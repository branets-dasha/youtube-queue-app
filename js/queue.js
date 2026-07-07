// js/queue.js
//
// PURE queue logic. This module intentionally references NO browser globals
// (no window, document, fetch, localStorage, IndexedDB) at module scope or
// inside its functions, so it can be imported directly by a Node.js test
// runner:  import { computeCutoff, computeQueue, ... } from './js/queue.js'
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
//     embeddable:   boolean,   // optional; can be played in the on-page player
//     positionSeconds: number, // optional; last watch position, for resume
//     state:        'new' | 'watched' | 'not_interested'
//   }

export const STATE_NEW = 'new';
export const STATE_WATCHED = 'watched';
export const STATE_NOT_INTERESTED = 'not_interested';

// A video whose length is at most this many seconds is treated as a "Short".
// Heuristic only — the API exposes no isShort flag to the client.
export const SHORTS_MAX_SECONDS = 90;

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
 * The next auto-play candidate AFTER `currentVideoId` in an ascending
 * (oldest->newest) list: the first record whose state === 'new' (which skips
 * BOTH 'watched' and 'not_interested') AND is embeddable (embeddable !== false).
 * If `currentVideoId` is not in the list, the search starts from the beginning
 * (graceful). Returns null when nothing eligible remains. Pure.
 * @param {Array<object>} sorted visible records, ascending by publishedAt
 * @param {string} currentVideoId
 * @returns {object|null}
 */
export function nextPlayable(sorted, currentVideoId) {
  const list = Array.isArray(sorted) ? sorted : [];
  const idx = list.findIndex((r) => r && r.videoId === currentVideoId);
  const start = idx < 0 ? 0 : idx + 1;
  for (let k = start; k < list.length; k++) {
    const r = list[k];
    if (r && r.state === STATE_NEW && r.embeddable !== false) return r;
  }
  return null;
}

/**
 * Compute the live CUTOFF marker: the boundary of the contiguous handled prefix
 * among the currently-present videos — "everything up to here is handled; the
 * first UNMARKED video is just after it."
 *
 * Sort ascending (tie-safe). Walk from the oldest present video (strictly after
 * `floor`): while it is handled (watched / not_interested) advance the result to
 * its publishedAt; stop at the first 'new'. TIE-SAFETY: the result is always
 * STRICTLY LESS than the earliest still-'new' video's publishedAt, so a handled
 * video sharing a timestamp with a 'new' one never pulls the cutoff onto (or
 * past) that 'new' video. If the oldest present video is 'new' (or there are no
 * records), returns `floor`. The result is ALWAYS >= floor.
 *
 * Unlike a forward-only advance, this recomputes from `floor` every call, so it
 * can move BACK when a video inside the handled prefix is un-marked. Pure.
 *
 * @param {Array<object>} records
 * @param {string|null|undefined} floor deletion/fetch boundary (lower bound)
 * @returns {string|null} the cutoff marker ISO (>= floor)
 */
export function computeCutoff(records, floor) {
  const base = floor == null ? null : floor;
  const sorted = sortAscending(records);

  // Earliest still-'new' record strictly after the floor — the cutoff must never
  // reach it (tie-safety).
  let firstNewTs = null;
  for (const rec of sorted) {
    if (!isAfterCutoff(rec, base)) continue;
    if (rec.state === STATE_NEW) {
      firstNewTs = rec.publishedAt;
      break;
    }
  }

  // Walk the contiguous handled prefix (only records strictly after the floor).
  let result = base;
  for (const rec of sorted) {
    if (!isAfterCutoff(rec, base)) continue; // at/before floor: ignore
    if (rec.state === STATE_NEW) break; // first unmarked video: stop
    if (firstNewTs != null && compareIso(rec.publishedAt, firstNewTs) >= 0) {
      // Ties (or is newer than) the earliest 'new' video: don't advance onto it.
      break;
    }
    result = rec.publishedAt;
  }
  return result;
}

/**
 * The deletion set for CLEANUP: every record with publishedAt <= cutoff. Pure;
 * does not mutate.
 * @param {Array<object>} records
 * @param {string|null|undefined} cutoff
 * @returns {Array<object>} records to delete
 */
export function videosToClean(records, cutoff) {
  if (cutoff == null) return [];
  return records.filter((r) => compareIso(r.publishedAt, cutoff) <= 0);
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

// A saved position must be at least this many seconds in to be worth resuming,
// and at least this many seconds before the end (so we don't resume at the tail).
export const RESUME_MIN_SECONDS = 5;
export const RESUME_END_MARGIN_SECONDS = 15;

/**
 * Where playback should START for resume. Returns `positionSeconds` only when it
 * is a meaningful mid-point: strictly greater than RESUME_MIN_SECONDS and — when
 * the duration is known — at least RESUME_END_MARGIN_SECONDS before the end.
 * Otherwise returns 0 (start from the beginning). Handles missing / non-finite
 * values gracefully. Pure.
 * @param {number} positionSeconds
 * @param {number} [durationSeconds]
 * @returns {number} start-at seconds (0 = from the beginning)
 */
export function resumeStart(positionSeconds, durationSeconds) {
  const pos = Number(positionSeconds);
  if (!Number.isFinite(pos) || pos <= RESUME_MIN_SECONDS) return 0;
  const dur = Number(durationSeconds);
  if (Number.isFinite(dur) && dur > 0 && pos >= dur - RESUME_END_MARGIN_SECONDS) {
    return 0; // at/near the end (or past the duration): start over
  }
  return Math.floor(pos);
}
