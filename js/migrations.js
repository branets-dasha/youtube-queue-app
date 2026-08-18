// js/migrations.js
//
// EVERY data migration lives here, so retiring them later is deleting this file
// plus its four call sites (store.js readAll, subscriptions-page.js init,
// stash-page.js bootApp, channels-page.js init).
//
// Convention: a function's JSDoc states only its GENERAL contract; each
// individual migration is a date-marked `// YYYY-MM-DD — <name>: …` comment
// inside the body, and nothing outside this file explains it. Delete the block
// (with its constants and tests) once a migration is obsolete; delete the file
// once the last block is gone.
//
// No browser globals are touched at module level — the file imports cleanly
// under Node, so js/migrations.test.mjs exercises the real logic. localStorage
// is reached only inside migrateLocalStorage(), guarded by the same try/catch
// discipline store.js uses (private mode / storage disabled must never throw).

import { LS_CHANNEL_PREFS } from './config.js';

/**
 * Bring video records read from IndexedDB up to the current shape. Mutates +
 * returns the array. Applied on every read, so the in-memory model is always
 * current regardless of what's on disk; nothing is written back here — the next
 * putVideos persists the new shape, so no IDB_VERSION bump is needed. Must stay
 * cheap and idempotent, and tolerant of malformed entries (a corrupt store must
 * not break the read path). A non-array argument (null/undefined/anything else)
 * is returned unchanged rather than throwing, so callers need no guard of their
 * own.
 * @param {Array<object>} records
 * @returns {Array<object>} the same value that was passed in
 */
export function migrateVideos(records) {
  if (!Array.isArray(records)) return records;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;

    // 2026-08-11 — rate > speed rename.
    if (rec.preferredSpeed == null && rec.preferredRate != null) {
      rec.preferredSpeed = rec.preferredRate;
    }
    delete rec.preferredRate;
  }
  return records;
}

/**
 * Bring a channel-prefs map up to the current shape, in memory only (the caller
 * decides whether to write it back). An entry left with NO own properties is
 * removed from the map, keeping the invariant setChannelPref/saveChannelPrefs
 * maintain (only non-default values are stored) — a dropped entry reads
 * identically to an empty one
 * (isChannelIgnored -> false, channelPreferredSpeed -> undefined). That is the
 * whole cleanup: an entry carrying a pre-existing default-ish value such as
 * `{ignored: false}` is data no migration created, so it is left alone.
 * Mutates + returns the map. Idempotent and tolerant of malformed entries.
 * @param {Record<string,object>} prefs
 * @returns {Record<string,{ignored?:boolean,speed?:number}>} the same map object
 */
export function migrateChannelPrefs(prefs) {
  for (const [channelId, entry] of Object.entries(prefs || {})) {
    if (!entry || typeof entry !== 'object') continue;

    // 2026-08-11 — rate > speed rename.
    if (entry.speed == null && entry.rate != null) entry.speed = entry.rate;
    delete entry.rate;

    if (Object.keys(entry).length === 0) delete prefs[channelId];
  }
  return prefs;
}

/**
 * The one-shot localStorage migration, run once at startup by BOTH entry points
 * before anything reads prefs. The only migration that rewrites what is ON DISK
 * rather than just the loaded copy, so the read paths in store.js stay plain
 * parses. Only writes when the shape actually changed, and keeps the prefs
 * invariants: only non-default values are stored, and an empty map removes the
 * key. Idempotent, and never throws (storage disabled / private mode).
 */
export function migrateLocalStorage() {
  try {
    // 2026-08-11 — rate > speed rename: drop the pre-rename speed keys, their
    // values intentionally NOT carried over (re-picking a speed by hand is trivial).
    localStorage.removeItem('yqa_playback_rate');
    localStorage.removeItem('yqa_default_rate');
  } catch {
    /* ignore */
  }

  // 2026-08-11 — rate > speed rename: rewrite yqa_channel_prefs into the
  // `speed` shape on disk (migrateChannelPrefs does the per-entry work).
  try {
    const raw = localStorage.getItem(LS_CHANNEL_PREFS);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const migrated = migrateChannelPrefs(parsed);
    // Emptiness is checked AFTER the migration, not before: dropping the entries
    // it emptied can empty the whole map, so an earlier check would let
    // '{}' reach the disk. This one guard covers both an already-empty stored
    // map and one the migration itself emptied.
    if (Object.keys(migrated).length === 0) {
      localStorage.removeItem(LS_CHANNEL_PREFS); // no '{}' garbage
      return;
    }
    const json = JSON.stringify(migrated);
    if (json !== raw) localStorage.setItem(LS_CHANNEL_PREFS, json);
  } catch {
    /* ignore */
  }
}
