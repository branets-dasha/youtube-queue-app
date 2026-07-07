// js/queue.js
//
// PURE queue logic. This module intentionally references NO browser globals
// (no window, document, fetch, localStorage, IndexedDB) at module scope or
// inside its functions, so it can be imported directly by a Node.js test
// runner:  import { advanceCutoff, computeQueue, ... } from './js/queue.js'
//
// A "video record" is a plain object of the shape:
//   {
//     videoId:      string,   // unique key
//     title:        string,
//     channelId:    string,
//     channelTitle: string,
//     publishedAt:  string,   // ISO 8601 timestamp
//     thumbnailUrl: string,
//     durationSeconds: number, // optional; video length, backfilled via videos.list
//     state:        'new' | 'watched' | 'not_interested'
//   }

export const STATE_NEW = 'new';
export const STATE_WATCHED = 'watched';
export const STATE_NOT_INTERESTED = 'not_interested';

// A video whose length is at most this many seconds is treated as a "Short".
// Heuristic only — the API exposes no isShort flag to the client.
export const SHORTS_MAX_SECONDS = 60;

/**
 * Compare two ISO timestamps. Returns a negative number if a < b, positive if
 * a > b, and 0 if equal. Uses Date parsing so differing ISO representations of
 * the same instant compare equal.
 * @param {string} a ISO timestamp
 * @param {string} b ISO timestamp
 * @returns {number}
 */
export function compareIso(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    // Fall back to lexical comparison for unparseable input so sorting is
    // still deterministic rather than throwing.
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  return ta - tb;
}

/**
 * Return a NEW array of records sorted ascending by publishedAt (oldest
 * first). Does not mutate the input array. Ties are broken by videoId to keep
 * the ordering stable and deterministic across environments.
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
export function sortAscending(records) {
  return records.slice().sort((r1, r2) => {
    const c = compareIso(r1.publishedAt, r2.publishedAt);
    if (c !== 0) return c;
    // Deterministic tie-break.
    if (r1.videoId < r2.videoId) return -1;
    if (r1.videoId > r2.videoId) return 1;
    return 0;
  });
}

/**
 * Return true if a record belongs in the active window: strictly newer than
 * the cutoff. publishedAt === cutoff is OUT (considered handled/pruned).
 * A null/empty cutoff means "no cutoff" and everything is in-window.
 * @param {object} record
 * @param {string|null|undefined} cutoff ISO timestamp
 * @returns {boolean}
 */
export function isAfterCutoff(record, cutoff) {
  if (!cutoff) return true;
  return compareIso(record.publishedAt, cutoff) > 0;
}

/**
 * Merge incoming records into an existing collection, keyed strictly by
 * videoId. Upsert semantics:
 *   - A videoId not already present is INSERTED with state 'new' (unless the
 *     incoming record already carries an explicit state, which is preserved).
 *   - A videoId already present KEEPS its existing state (never reset, never
 *     duplicated). Its display metadata (title, thumbnail, channelTitle,
 *     publishedAt) is refreshed from the incoming record so late edits/renames
 *     are reflected, but the user's state decision is untouched.
 *
 * Neither input array is mutated. Returns a brand-new array of merged records.
 *
 * @param {Array<object>} existing
 * @param {Array<object>} incoming
 * @returns {Array<object>}
 */
export function upsertVideos(existing, incoming) {
  const byId = new Map();

  for (const rec of existing) {
    // Clone so callers' objects are never mutated.
    byId.set(rec.videoId, { ...rec });
  }

  for (const inc of incoming) {
    const prev = byId.get(inc.videoId);
    if (prev) {
      // Preserve the existing state; refresh display metadata.
      byId.set(inc.videoId, {
        ...prev,
        title: inc.title !== undefined ? inc.title : prev.title,
        channelId: inc.channelId !== undefined ? inc.channelId : prev.channelId,
        channelTitle:
          inc.channelTitle !== undefined ? inc.channelTitle : prev.channelTitle,
        publishedAt:
          inc.publishedAt !== undefined ? inc.publishedAt : prev.publishedAt,
        thumbnailUrl:
          inc.thumbnailUrl !== undefined ? inc.thumbnailUrl : prev.thumbnailUrl,
        // state intentionally left as prev.state.
      });
    } else {
      byId.set(inc.videoId, {
        ...inc,
        state: inc.state || STATE_NEW,
      });
    }
  }

  return Array.from(byId.values());
}

/**
 * Compute the queue view: all records that are strictly newer than the cutoff
 * AND still in state 'new', sorted ascending by publishedAt (oldest first).
 * @param {Array<object>} records
 * @param {string|null|undefined} cutoff ISO timestamp
 * @returns {Array<object>}
 */
export function computeQueue(records, cutoff) {
  const filtered = records.filter(
    (r) => r.state === STATE_NEW && isAfterCutoff(r, cutoff)
  );
  return sortAscending(filtered);
}

/**
 * Compute the RENDER list: all records strictly newer than the cutoff,
 * REGARDLESS of state (new / watched / not_interested), sorted ascending by
 * publishedAt (oldest first). Unlike computeQueue this KEEPS marked videos in
 * the list (they are greyed out in the UI) until a reload advances the cutoff
 * and prunes the contiguous handled prefix. Pure; does not mutate the input.
 * @param {Array<object>} records
 * @param {string|null|undefined} cutoff ISO timestamp
 * @returns {Array<object>}
 */
export function computeVisible(records, cutoff) {
  const filtered = records.filter((r) => isAfterCutoff(r, cutoff));
  return sortAscending(filtered);
}

/**
 * Advance the start cutoff across the contiguous handled prefix.
 *
 * Algorithm (pinned by spec):
 *   1. Sort all records ascending by publishedAt.
 *   2. Walk from the oldest. While the current oldest record's state !== 'new',
 *      set newCutoff = that record's publishedAt and mark it prunable.
 *   3. Stop at the first record whose state === 'new'. Never advance past a
 *      still-'new' older video. Because ISO timestamps have only second
 *      precision, a handled record can share the EXACT publishedAt of a still-
 *      'new' record. To avoid pruning that 'new' video (data loss), the cutoff
 *      is never advanced onto (or past) the earliest still-'new' timestamp:
 *      newCutoff is the newest handled-prefix timestamp that is STRICTLY older
 *      than the earliest still-'new' record.
 *   4. After determining newCutoff, prune EVERY record whose publishedAt <=
 *      newCutoff (strictly-greater-than stays; == is pruned).
 *
 * Returns { newCutoff, prunedIds } and does not mutate inputs.
 *   - newCutoff: the advanced cutoff (or the original cutoff if nothing at the
 *     head is handled). May be null if the original cutoff was null and no
 *     prefix was handled.
 *   - prunedIds: array of videoIds that should be deleted from the store.
 *
 * @param {Array<object>} records
 * @param {string|null|undefined} cutoff current ISO cutoff
 * @returns {{ newCutoff: (string|null), prunedIds: Array<string> }}
 */
export function advanceCutoff(records, cutoff) {
  const sorted = sortAscending(records);

  let newCutoff = cutoff == null ? null : cutoff;

  // First, find the earliest still-'new' record within the active window. The
  // cutoff must never advance onto (or past) its publishedAt, even if a handled
  // record shares the exact same timestamp (second-precision ties), otherwise
  // that 'new' video would be pruned and permanently lost.
  let firstNewTs = null;
  for (const rec of sorted) {
    if (!isAfterCutoff(rec, cutoff)) continue;
    if (rec.state === STATE_NEW) {
      firstNewTs = rec.publishedAt;
      break;
    }
  }

  // Walk the contiguous handled prefix, but only consider records that are in
  // the active window (newer than the current cutoff). Anything at or before
  // the existing cutoff is already handled/pruned and is ignored here.
  for (const rec of sorted) {
    if (!isAfterCutoff(rec, cutoff)) {
      // Already at/behind the cutoff; skip without breaking the prefix walk.
      continue;
    }
    if (rec.state === STATE_NEW) {
      // First still-'new' record in the active window: stop advancing.
      break;
    }
    if (firstNewTs != null && compareIso(rec.publishedAt, firstNewTs) >= 0) {
      // This handled record ties (or is newer than) the earliest still-'new'
      // record. Advancing the cutoff onto its timestamp would prune that 'new'
      // video, so stop here without advancing onto that boundary.
      break;
    }
    // Handled record at the head of the active window: advance the cutoff to
    // it. Because we advance to the NEWEST handled record in the contiguous
    // prefix, we keep overwriting newCutoff as we walk forward.
    newCutoff = rec.publishedAt;
  }

  // Determine which records to prune: everything at or before the new cutoff.
  const prunedIds = [];
  if (newCutoff != null) {
    for (const rec of records) {
      if (compareIso(rec.publishedAt, newCutoff) <= 0) {
        prunedIds.push(rec.videoId);
      }
    }
  }

  return { newCutoff, prunedIds };
}

/**
 * Convenience helper: given records and a cutoff, apply advanceCutoff and
 * return the surviving records plus the new cutoff. Pure; does not mutate.
 * @param {Array<object>} records
 * @param {string|null|undefined} cutoff
 * @returns {{ records: Array<object>, newCutoff: (string|null), prunedIds: Array<string> }}
 */
export function pruneWithCutoff(records, cutoff) {
  const { newCutoff, prunedIds } = advanceCutoff(records, cutoff);
  const prunedSet = new Set(prunedIds);
  const surviving = records.filter((r) => !prunedSet.has(r.videoId));
  return { records: surviving, newCutoff, prunedIds };
}

/**
 * Derive the uploads playlist id from a channel id by replacing the leading
 * "UC" with "UU". Returns null if the channelId does not start with "UC"
 * (caller should fall back to channels.list in that rare case).
 * @param {string} channelId
 * @returns {string|null}
 */
export function uploadsPlaylistId(channelId) {
  if (typeof channelId === 'string' && channelId.startsWith('UC')) {
    return 'UU' + channelId.slice(2);
  }
  return null;
}

/**
 * Default cutoff: N days ago from a reference instant, as an ISO string.
 * Pure helper (accepts the "now" value so it is deterministic in tests).
 * @param {number} days
 * @param {number} [nowMs=Date.now-like] reference epoch millis
 * @returns {string} ISO timestamp
 */
export function daysAgoIso(days, nowMs) {
  const base = typeof nowMs === 'number' ? nowMs : 0;
  return new Date(base - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Duration helpers (video length badge + Shorts heuristic)
// ---------------------------------------------------------------------------

/**
 * Parse an ISO-8601 duration (YouTube's contentDetails.duration, e.g. "PT1H2M3S",
 * "PT4M13S", "PT45S") into a whole number of seconds. Returns 0 for missing,
 * zero, or unparseable input. Pure.
 * @param {string} iso
 * @returns {number} seconds
 */
export function parseIsoDuration(iso) {
  if (typeof iso !== 'string') return 0;
  const m = iso.match(/^(-)?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const sign = m[1] ? -1 : 1;
  const days = parseInt(m[2] || '0', 10);
  const hours = parseInt(m[3] || '0', 10);
  const mins = parseInt(m[4] || '0', 10);
  const secs = parseInt(m[5] || '0', 10);
  return sign * (((days * 24 + hours) * 60 + mins) * 60 + secs);
}

/**
 * Format a number of seconds as "M:SS" (under an hour) or "H:MM:SS". Pure.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/**
 * Heuristic: treat a video as a YouTube Short when it has a known, positive
 * duration no longer than SHORTS_MAX_SECONDS. There is no client-visible isShort
 * flag, so this is only an approximation. Pure.
 * @param {number} durationSeconds
 * @returns {boolean}
 */
export function isShort(durationSeconds) {
  return (
    typeof durationSeconds === 'number' &&
    durationSeconds > 0 &&
    durationSeconds <= SHORTS_MAX_SECONDS
  );
}
