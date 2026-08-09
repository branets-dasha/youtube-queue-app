// js/store.js
//
// Persistence layer.
//   - Client ID, cutoffs and settings live in localStorage (small, sync-ish
//     values).
//   - The video store lives in IndexedDB (object store `videos`, keyPath
//     `videoId`), which is REQUIRED: the app cannot store videos without it.
//   - If IndexedDB is genuinely unavailable (missing global, the open() call
//     throws, or `req.onerror` fires) every video API throws
//     `DbUnavailableError` and `app.js` halts startup with a blocking error.
//   - Likewise `req.onblocked` (another tab holds the DB open at a different
//     schema version during a version upgrade): the real data lives in
//     IndexedDB but is temporarily inaccessible, so every video API throws
//     `DbBlockedError` and startup halts with a different blocking message.
//
// All video APIs are async (Promise-returning).

import {
  LS_CLIENT_ID,
  LS_START_CUTOFF,
  LS_CUTOFF,
  LS_CHANNELS,
  LS_CHANNEL_PREFS,
  LS_PLAYBACK_RATE,
  LS_DEFAULT_RATE,
  LS_HIDE_MARKED,
  IDB_NAME,
  IDB_VERSION,
  IDB_STORE_VIDEOS,
  IDB_KEYPATH,
  STATE_NEW,
  STATE_SKIPPED,
} from './config.js';

/**
 * Migrate loaded records to the single "handled" state model: any record whose
 * state is not 'new' (old 'watched' / 'not_interested', or anything unexpected)
 * becomes 'skipped'. Mutates + returns the array. Applied on every read so the
 * in-memory model is always normalized regardless of what's on disk.
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
/**
 * Thrown by every video API when IndexedDB is BLOCKED by another tab holding the
 * database open at a different schema version. Distinct from
 * DbUnavailableError: here the database opened fine at some point and the data
 * exists, it is just temporarily inaccessible — a condition the user can clear
 * by closing the other tab, so app.js halts startup and says exactly that.
 */
export class DbBlockedError extends Error {
  constructor() {
    super('IndexedDB is blocked by another tab holding a different database version.');
    this.name = 'DbBlockedError';
  }
}

/**
 * Thrown by every video API when IndexedDB cannot be opened at all: the global
 * is missing, `indexedDB.open()` throws, or the open request errors. There is
 * then nowhere to read or save videos, so app.js halts with a blocking error.
 */
export class DbUnavailableError extends Error {
  constructor() {
    super('IndexedDB is unavailable; this app cannot store videos without it.');
    this.name = 'DbUnavailableError';
  }
}

function migrateStates(records) {
  for (const r of records) {
    if (r && r.state !== STATE_NEW) r.state = STATE_SKIPPED;
  }
  return records;
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

// The persisted player playback rate (yqa_playback_rate). Returns a Number, or
// null if absent/unreadable (caller validates + falls back to the default).

export function getPlaybackRate() {
  try {
    const raw = localStorage.getItem(LS_PLAYBACK_RATE);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function setPlaybackRate(rate) {
  try {
    localStorage.setItem(LS_PLAYBACK_RATE, String(rate));
  } catch {
    /* ignore */
  }
}

// The persisted DEFAULT-speed setting (yqa_default_rate). Returns a Number, or
// null when unset/unreadable (caller validates against the 1/1.5/2 presets).

export function getDefaultRate() {
  try {
    const raw = localStorage.getItem(LS_DEFAULT_RATE);
    return raw == null ? null : Number(raw);
  } catch {
    return null;
  }
}

export function setDefaultRate(rate) {
  try {
    if (rate == null) localStorage.removeItem(LS_DEFAULT_RATE);
    else localStorage.setItem(LS_DEFAULT_RATE, String(rate));
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
// localStorage: per-channel prefs (channelId -> { ignored?, rate? })
// ---------------------------------------------------------------------------

/**
 * Load the persisted per-channel prefs map, or {} if absent/unparseable. Only
 * non-default values are stored (see setChannelPref in queue.js). Read FRESH at
 * refresh time so edits made on channels.html in another tab apply to the next
 * fetch without reloading.
 * @returns {Record<string,{ignored?:boolean,rate?:number}>}
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
 * @param {Record<string,{ignored?:boolean,rate?:number}>} map
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
// IndexedDB video store (required)
// ---------------------------------------------------------------------------

let dbPromise = null;
// Sticky: IndexedDB could not be opened at all. Every video API then throws
// DbUnavailableError (see the three trigger sites in openDb below).
let dbUnavailable = false;
// Sticky: the DB is held by another tab at a different schema version. Every
// video API then throws DbBlockedError.
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
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_VIDEOS)) {
        db.createObjectStore(IDB_STORE_VIDEOS, { keyPath: IDB_KEYPATH });
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
      // video API then throws DbUnavailableError and app.js halts startup.
      dbUnavailable = true;
      resolve(null);
    };

    req.onblocked = () => {
      // Another tab holds the DB open at a different version, blocking this
      // upgrade. The real data is in IndexedDB (just inaccessible), so this is a
      // distinct, recoverable condition. Flag it and resolve null (nothing
      // hangs); every video API then throws DbBlockedError and app.js halts
      // startup with a blocking "close other tabs" message.
      dbBlocked = true;
      resolve(null);
    };
  });

  return dbPromise;
}

// -- Public async video API --------------------------------------------------
//
// Every one of the four APIs below opens the DB and then runs the SAME two
// guards, in this order:
//   1. dbBlocked      -> DbBlockedError
//   2. dbUnavailable  -> DbUnavailableError
// Blocked is checked first because it is the more specific, recoverable
// diagnosis: the data exists and closing the other tab fixes it. If a blocked
// upgrade later aborts, `req.onerror` can set dbUnavailable too, and the user
// still needs the "close the other tab(s)" message, not "IndexedDB is broken".
// The `|| !db` half of the second guard is a belt: openDb only ever resolves
// null via those flags, so a null db with neither flag set would be a bug — fail
// loudly rather than crash on db.transaction or return an empty list.

/**
 * Return all stored video records as an array.
 * @returns {Promise<Array<object>>}
 */
export async function getAllVideos() {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (dbUnavailable || !db) throw new DbUnavailableError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readonly');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    const req = store.getAll();
    req.onsuccess = () => resolve(migrateStates(req.result || []));
    req.onerror = () => reject(req.error);
  });
}

/**
 * Insert or replace a single video record (full overwrite by videoId).
 * @param {object} record
 * @returns {Promise<void>}
 */
export async function putVideo(record) {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (dbUnavailable || !db) throw new DbUnavailableError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readwrite');
    tx.objectStore(IDB_STORE_VIDEOS).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Bulk replace: write every record in `records` (put by videoId).
 * @param {Array<object>} records
 * @returns {Promise<void>}
 */
export async function putVideos(records) {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (dbUnavailable || !db) throw new DbUnavailableError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readwrite');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    for (const rec of records) store.put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Delete records by an array of videoIds.
 * @param {Array<string>} ids
 * @returns {Promise<void>}
 */
export async function deleteVideos(ids) {
  if (!ids || ids.length === 0) return;
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (dbUnavailable || !db) throw new DbUnavailableError();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readwrite');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
