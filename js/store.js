// js/store.js
//
// Persistence layer.
//   - Client ID and start cutoff live in localStorage (small, sync-ish values).
//   - The video store lives in IndexedDB (object store `videos`, keyPath
//     `videoId`). If IndexedDB is unavailable, we transparently fall back to a
//     localStorage-backed store.
//
// All video APIs are async (Promise-returning) so callers can treat both
// backends uniformly.

import {
  LS_CLIENT_ID,
  LS_START_CUTOFF,
  LS_VIDEOS_FALLBACK,
  LS_CHANNELS,
  IDB_NAME,
  IDB_VERSION,
  IDB_STORE_VIDEOS,
  IDB_KEYPATH,
} from './config.js';

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
      // Another tab holds an older version open. Fall back rather than hang.
      useFallback = true;
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
  if (!db || useFallback) {
    return fallbackReadAll();
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_VIDEOS, 'readonly');
    const store = tx.objectStore(IDB_STORE_VIDEOS);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
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
