// js/store.js
//
// Persistence layer.
//   - Client ID and start cutoff live in localStorage (small, sync-ish values).
//   - The video store lives in IndexedDB (object store `videos`, keyPath
//     `videoId`). If IndexedDB is genuinely unavailable (private browsing, the
//     open() call throws, or `req.onerror` fires) we transparently fall back to a
//     localStorage-backed store — that fallback is the only way to use the app.
//   - EXCEPTION: `req.onblocked` (another tab holds the DB open at a different
//     schema version during a version upgrade) does NOT fall back. The real data
//     lives in IndexedDB but is temporarily inaccessible, so a separate empty
//     localStorage store would just confuse the user. Instead every video API
//     throws `DbBlockedError`, and `app.js` halts startup with a blocking error.
//
// All video APIs are async (Promise-returning) so callers can treat both
// backends uniformly.

import {
  LS_CLIENT_ID,
  LS_START_CUTOFF,
  LS_CUTOFF,
  LS_VIDEOS_FALLBACK,
  LS_CHANNELS,
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
 * database open at a different schema version. Distinct from the localStorage
 * fallback: the data exists but is temporarily inaccessible, so we surface an
 * error (app.js halts startup) rather than silently using an empty store.
 */
export class DbBlockedError extends Error {
  constructor() {
    super('IndexedDB is blocked by another tab holding a different database version.');
    this.name = 'DbBlockedError';
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
// IndexedDB video store (with localStorage fallback)
// ---------------------------------------------------------------------------

let dbPromise = null;
let useFallback = false;
let dbBlocked = false;

function idbAvailable() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb() {
  if (dbPromise) return dbPromise;

  if (!idbAvailable()) {
    useFallback = true;
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }

  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch {
      useFallback = true;
      resolve(null);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_VIDEOS)) {
        db.createObjectStore(IDB_STORE_VIDEOS, { keyPath: IDB_KEYPATH });
      }
    };

    req.onsuccess = () => resolve(req.result);

    req.onerror = () => {
      // Fall back to localStorage if IndexedDB cannot be opened.
      useFallback = true;
      resolve(null);
    };

    req.onblocked = () => {
      // Another tab holds the DB open at a different version, blocking this
      // upgrade. Do NOT fall back: the real data is in IndexedDB (just
      // inaccessible), so an empty localStorage store would mislead. Flag it and
      // resolve null (nothing hangs); every video API then throws DbBlockedError
      // and app.js halts startup with a blocking "close other tabs" message.
      dbBlocked = true;
      resolve(null);
    };
  });

  return dbPromise;
}

// -- localStorage fallback helpers ------------------------------------------

function fallbackReadAll() {
  try {
    const raw = localStorage.getItem(LS_VIDEOS_FALLBACK);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fallbackWriteAll(records) {
  localStorage.setItem(LS_VIDEOS_FALLBACK, JSON.stringify(records));
}

// -- Public async video API --------------------------------------------------

/**
 * Return all stored video records as an array.
 * @returns {Promise<Array<object>>}
 */
export async function getAllVideos() {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (!db || useFallback) {
    return migrateStates(fallbackReadAll());
  }
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
  if (!db || useFallback) {
    const all = fallbackReadAll();
    const idx = all.findIndex((r) => r.videoId === record.videoId);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    fallbackWriteAll(all);
    return;
  }
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
  if (!db || useFallback) {
    const all = fallbackReadAll();
    const byId = new Map(all.map((r) => [r.videoId, r]));
    for (const rec of records) byId.set(rec.videoId, rec);
    fallbackWriteAll(Array.from(byId.values()));
    return;
  }
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
  if (!db || useFallback) {
    const idSet = new Set(ids);
    const all = fallbackReadAll().filter((r) => !idSet.has(r.videoId));
    fallbackWriteAll(all);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readwrite');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Replace the ENTIRE video store contents with `records` (clear + bulk put).
 * Used after a prune to keep IndexedDB in sync with the in-memory model.
 * @param {Array<object>} records
 * @returns {Promise<void>}
 */
export async function replaceAllVideos(records) {
  const db = await openDb();
  if (dbBlocked) throw new DbBlockedError();
  if (!db || useFallback) {
    fallbackWriteAll(records);
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readwrite');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    const clearReq = store.clear();
    clearReq.onsuccess = () => {
      for (const rec of records) store.put(rec);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
