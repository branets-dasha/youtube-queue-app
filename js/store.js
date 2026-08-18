// js/store.js
//
// Persistence layer.
//   - Client ID, cutoffs and settings live in localStorage (small, sync-ish
//     values).
//   - Video records live in IndexedDB, which is REQUIRED: the app cannot store
//     videos without it. ONE database holds TWO object stores that share the
//     same keyPath (`videoId`) and the same record shape: `videos` — the
//     burn-down queue, written by index.html — and `stash` — the manually
//     curated queue, written by stash.html (whose records carry `addedAt` and
//     `channelAvatarUrl` on top). Everything else below (the open, the sticky
//     flags, the guards) is per-DATABASE and covers both.
//   - If IndexedDB is genuinely unavailable (missing global, the open() call
//     throws, or `req.onerror` fires) every video API throws
//     `DbUnavailableError` and the queue page (index.html or stash.html) halts
//     startup with a blocking error.
//   - Likewise `req.onblocked` (another tab holds the DB open at a different
//     schema version during a version upgrade): the real data lives in
//     IndexedDB but is temporarily inaccessible, so every video API throws
//     `DbBlockedError` and startup halts with a different blocking message.
//   - `standDownForOtherTab()` sets that same BLOCKED flag from the outside, for
//     either page's single-tab guard: another tab owns that queue, so this page
//     must not write, and the user fixes it the same way (close the other tab,
//     reload).
//
// All video APIs are async (Promise-returning).

import {
  LS_CLIENT_ID,
  LS_START_CUTOFF,
  LS_CUTOFF,
  LS_CHANNELS,
  LS_CHANNEL_PREFS,
  LS_PLAYBACK_SPEED,
  LS_DEFAULT_SPEED,
  LS_HIDE_MARKED,
  IDB_NAME,
  IDB_VERSION,
  IDB_STORE_VIDEOS,
  IDB_STORE_STASH,
  IDB_KEYPATH,
} from './config.js';
import { migrateVideos } from './migrations.js';

/**
 * Thrown by every video API when another tab of this app owns the database and
 * this page must not touch it. Distinct from DbUnavailableError: here IndexedDB
 * works and the data exists, it is just off-limits — a condition the user can
 * clear by closing the other tab, so the queue page halts startup and says
 * exactly that.
 */
export class DbBlockedError extends Error {
  constructor() {
    super('Another tab of this app owns the database; this page must not touch it.');
    this.name = 'DbBlockedError';
  }
}

/**
 * Thrown by every video API when IndexedDB cannot be opened at all: the global
 * is missing, `indexedDB.open()` throws, or the open request errors. There is
 * then nowhere to read or save videos, so the queue page halts with a
 * blocking error.
 */
export class DbUnavailableError extends Error {
  constructor() {
    super('IndexedDB is unavailable; this app cannot store videos without it.');
    this.name = 'DbUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// localStorage: client id & cutoff
// ---------------------------------------------------------------------------

export function getClientId() {
  try {
    return localStorage.getItem(LS_CLIENT_ID) || null;
  } catch {
    return null;
  }
}

export function setClientId(clientId) {
  localStorage.setItem(LS_CLIENT_ID, clientId);
}

export function clearClientId() {
  try {
    localStorage.removeItem(LS_CLIENT_ID);
  } catch {
    /* ignore */
  }
}

export function getStartCutoff() {
  try {
    return localStorage.getItem(LS_START_CUTOFF) || null;
  } catch {
    return null;
  }
}

export function setStartCutoff(iso) {
  if (iso == null) {
    localStorage.removeItem(LS_START_CUTOFF);
  } else {
    localStorage.setItem(LS_START_CUTOFF, iso);
  }
}

// The live cutoff marker (yqa_cutoff). Distinct from the floor above.

export function getCutoff() {
  try {
    return localStorage.getItem(LS_CUTOFF) || null;
  } catch {
    return null;
  }
}

export function setCutoff(iso) {
  if (iso == null) {
    localStorage.removeItem(LS_CUTOFF);
  } else {
    localStorage.setItem(LS_CUTOFF, iso);
  }
}

// The persisted player playback speed (yqa_playback_speed). Returns a Number, or
// null if absent/unreadable (caller validates + falls back to the default).

export function getPlaybackSpeed() {
  try {
    const raw = localStorage.getItem(LS_PLAYBACK_SPEED);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function setPlaybackSpeed(speed) {
  try {
    localStorage.setItem(LS_PLAYBACK_SPEED, String(speed));
  } catch {
    /* ignore */
  }
}

// The persisted DEFAULT-speed setting (yqa_default_speed). Returns a Number, or
// null when unset/unreadable (caller validates against the 1/1.5/2 presets).

export function getDefaultSpeed() {
  try {
    const raw = localStorage.getItem(LS_DEFAULT_SPEED);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function setDefaultSpeed(speed) {
  try {
    if (speed == null) localStorage.removeItem(LS_DEFAULT_SPEED);
    else localStorage.setItem(LS_DEFAULT_SPEED, String(speed));
  } catch {
    /* ignore */
  }
}

// The persisted "hide marked videos" view toggle (yqa_hide_marked). Default off.

export function getHideMarked() {
  try {
    return localStorage.getItem(LS_HIDE_MARKED) === 'true';
  } catch {
    return false;
  }
}

export function setHideMarked(on) {
  try {
    localStorage.setItem(LS_HIDE_MARKED, on ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// localStorage: channel map (channelId -> { title, avatarUrl }) for avatars
// ---------------------------------------------------------------------------

/**
 * Load the persisted channel map, or {} if absent/unparseable.
 * @returns {Record<string,{title:string,avatarUrl:string}>}
 */
export function loadChannels() {
  try {
    const raw = localStorage.getItem(LS_CHANNELS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Persist the channel map. Best-effort — avatars are cosmetic, so quota /
 * serialization failures are ignored.
 * @param {Record<string,{title:string,avatarUrl:string}>} map
 */
export function saveChannels(map) {
  try {
    localStorage.setItem(LS_CHANNELS, JSON.stringify(map || {}));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// localStorage: per-channel prefs (channelId -> { ignored?, speed? })
// ---------------------------------------------------------------------------

/**
 * Load the persisted per-channel prefs map, or {} if absent/unparseable. Only
 * non-default values are stored (see setChannelPref in queue.js). Read FRESH at
 * refresh time so edits made on channels.html in another tab apply to the next
 * fetch without reloading.
 * @returns {Record<string,{ignored?:boolean,speed?:number}>}
 */
export function loadChannelPrefs() {
  try {
    const raw = localStorage.getItem(LS_CHANNEL_PREFS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Persist the per-channel prefs map. An EMPTY map removes the key entirely
 * (no '{}' garbage). Best-effort — quota / serialization failures are ignored.
 * @param {Record<string,{ignored?:boolean,speed?:number}>} map
 */
export function saveChannelPrefs(map) {
  try {
    if (!map || Object.keys(map).length === 0) {
      localStorage.removeItem(LS_CHANNEL_PREFS);
    } else {
      localStorage.setItem(LS_CHANNEL_PREFS, JSON.stringify(map));
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// IndexedDB video stores (required)
//
// The memoized `dbPromise`, the two sticky flags, `onversionchange`, `onblocked`
// and `standDownForOtherTab()` are all per-DATABASE, not per-object-store: one
// open, one connection, one diagnosis covering `videos` AND `stash`. Do not
// "fix" any of it into per-store granularity — a database that cannot be opened,
// or that another tab owns, is equally unusable for every store inside it.
// ---------------------------------------------------------------------------

let dbPromise = null;
// Sticky: IndexedDB could not be opened at all. Every video API then throws
// DbUnavailableError (see the three trigger sites in openDb below).
let dbUnavailable = false;
// Sticky: another tab owns the database — it holds it open at a different schema
// version, or (via standDownForOtherTab) it is the active queue tab. Every video
// API then throws DbBlockedError.
let dbBlocked = false;

function openDb() {
  if (dbPromise) return dbPromise;

  if (indexedDB == null) {
    dbUnavailable = true;
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch {
      dbUnavailable = true;
      resolve(null);
      return;
    }

    req.onupgradeneeded = () => {
      // This ONE existence-guarded block covers BOTH paths, which is why
      // `event.oldVersion` is never needed: a fresh install creates both stores,
      // and a v1 -> v2 upgrade of an existing install creates only `stash`
      // (`videos` and every row in it are left untouched).
      // No indexes on either store: both are read whole and sorted in memory, and
      // an index would be a second thing to keep in step with the record shape.
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_VIDEOS)) {
        db.createObjectStore(IDB_STORE_VIDEOS, { keyPath: IDB_KEYPATH });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_STASH)) {
        db.createObjectStore(IDB_STORE_STASH, { keyPath: IDB_KEYPATH });
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // Another tab is opening the DB at a NEWER version. Close this
        // connection so that upgrade isn't blocked forever, and route into the
        // same sticky blocked machinery as onblocked: every subsequent video
        // API throws DbBlockedError instead of using the dead connection.
        dbBlocked = true;
        db.close();
      };
      resolve(db);
    };

    req.onerror = () => {
      // The open request failed (storage blocked for this origin, corrupted
      // database, disk full). Flag it and resolve null (nothing hangs); every
      // video API then throws DbUnavailableError and the queue page halts
      // startup.
      dbUnavailable = true;
      resolve(null);
    };

    req.onblocked = () => {
      // Another tab holds the DB open at a different version, blocking this
      // upgrade. The real data is in IndexedDB (just inaccessible), so this is a
      // distinct, recoverable condition. Flag it and resolve null (nothing
      // hangs); every video API then throws DbBlockedError and the queue page
      // halts startup with a blocking "close other tabs" message.
      dbBlocked = true;
      resolve(null);
    };
  });

  return dbPromise;
}

/**
 * Stand down: another tab of this page owns its queue, so this page must never
 * write. Sets the SAME sticky blocked flag as `onblocked` /
 * `onversionchange` — the condition is identical from here on (the data is
 * there, this page must not touch it, closing the other tab and reloading fixes
 * it), so every subsequent video API throws DbBlockedError and no fourth guard
 * line is needed. Also closes this connection (IndexedDB lets pending
 * transactions finish first) so the surviving tab is never blocked by it.
 * Called only by a page's single-tab guard (subscriptions-page.js for `videos`,
 * the stash page for `stash`). The flag is per-database, so it stands this
 * document down from BOTH stores — which is correct, and what the caller
 * wants: a superseded tab has no business writing either queue. Sticky and
 * irreversible by design.
 */
export function standDownForOtherTab() {
  dbBlocked = true;
  if (dbPromise) dbPromise.then((db) => db && db.close()).catch(() => {});
}

// -- Private object-store helpers --------------------------------------------
//
// One implementation per operation, parameterized by object store name, so the
// store names never leave this module and the guard order is written down
// exactly once. The public APIs below are thin per-store wrappers over these.

/**
 * Open the database and apply the SAME two guards every video API needs, in this
 * order:
 *   1. dbBlocked      -> DbBlockedError
 *   2. dbUnavailable  -> DbUnavailableError
 * Blocked is checked FIRST because it is the more specific, recoverable
 * diagnosis: the data exists and closing the other tab fixes it. If a blocked
 * upgrade later aborts, `req.onerror` can set dbUnavailable too, and the user
 * still needs the "close the other tab(s)" message, not "IndexedDB is broken".
 * The `|| !db` half of the second guard is a belt: openDb only ever resolves
 * null via those flags, so a null db with neither flag set would be a bug — fail
 * loudly rather than crash on db.transaction or return an empty list.
 * @returns {Promise<IDBDatabase>}
 */
async function openGuarded() {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (dbUnavailable || !db) throw new DbUnavailableError();
  return db;
}

/**
 * Read a whole object store. These are the only video read paths, so this is
 * where the record migrations run (see migrations.js) — callers always get the
 * current shape, whatever is on disk.
 * @param {string} storeName
 * @returns {Promise<Array<object>>}
 */
async function readAll(storeName) {
  const db = await openGuarded();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(migrateVideos(req.result || []));
    req.onerror = () => reject(req.error);
  });
}

/**
 * Insert or replace a single record (full overwrite by keyPath).
 * @param {string} storeName
 * @param {object} record
 * @returns {Promise<void>}
 */
async function putOne(storeName, record) {
  const db = await openGuarded();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Bulk put: the WHOLE set goes in ONE transaction, so a bulk write is a single
 * all-or-nothing commit rather than N independent ones.
 * @param {string} storeName
 * @param {Array<object>} records
 * @returns {Promise<void>}
 */
async function putAll(storeName, records) {
  const db = await openGuarded();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const rec of records) store.put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Delete records by key. The empty-list early return sits BEFORE openGuarded(),
 * so deleting nothing stays a no-op even when the database is blocked or
 * unavailable — there is nothing to fail at.
 * @param {string} storeName
 * @param {Array<string>} ids
 * @returns {Promise<void>}
 */
async function deleteAll(storeName, ids) {
  if (!ids || ids.length === 0) return;
  const db = await openGuarded();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// -- Public async video API: the `videos` store (the burn-down queue) ---------

/**
 * Return all stored video records as an array, with the record migrations
 * applied (see readAll).
 * @returns {Promise<Array<object>>}
 */
export async function getAllVideos() {
  return readAll(IDB_STORE_VIDEOS);
}

/**
 * Insert or replace a single video record (full overwrite by videoId).
 * @param {object} record
 * @returns {Promise<void>}
 */
export async function putVideo(record) {
  return putOne(IDB_STORE_VIDEOS, record);
}

/**
 * Bulk replace: write every record in `records` (put by videoId), in one
 * transaction.
 * @param {Array<object>} records
 * @returns {Promise<void>}
 */
export async function putVideos(records) {
  return putAll(IDB_STORE_VIDEOS, records);
}

/**
 * Delete records by an array of videoIds.
 * @param {Array<string>} ids
 * @returns {Promise<void>}
 */
export async function deleteVideos(ids) {
  return deleteAll(IDB_STORE_VIDEOS, ids);
}

// -- Public async video API: the `stash` store (the curated queue) ------------

/**
 * Return all stashed video records as an array.
 *
 * This DOES run the record migrations, because it shares `readAll`: a stash
 * record IS a video record plus `addedAt` / `channelAvatarUrl`, so any shape
 * migration applies to both stores by definition. Against today's single
 * migration that is a no-op; the value is that the NEXT migration covers both
 * stores by construction, instead of silently fixing one and leaving the other
 * on the old shape.
 * @returns {Promise<Array<object>>}
 */
export async function getAllStashVideos() {
  return readAll(IDB_STORE_STASH);
}

/**
 * Insert or replace a single stash record (full overwrite by videoId).
 * @param {object} record
 * @returns {Promise<void>}
 */
export async function putStashVideo(record) {
  return putOne(IDB_STORE_STASH, record);
}

/**
 * Delete stash records by an array of videoIds.
 * @param {Array<string>} ids
 * @returns {Promise<void>}
 */
export async function deleteStashVideos(ids) {
  return deleteAll(IDB_STORE_STASH, ids);
}
