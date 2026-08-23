// js/queue.js
//
// PURE queue logic. This module intentionally references NO browser globals
// (no window, document, fetch, localStorage, IndexedDB) at module scope or
// inside its functions, so it can be imported directly by a Node.js test
// runner:  import { computeCutoff, computeQueue, ... } from './js/queue.js'
// Its ONLY import is config.js (constants), which must stay browser-global-free
// for the same reason.
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
//     liked:        boolean,   // optional; locally-tracked YouTube like state
//     preferredSpeed: number,  // optional; per-video preferred speed (1 | 1.5 | 2)
//     state:        'new' | 'skipped'   // 'skipped' is the single "handled" state
//   }

// There is a single "handled" state. Every handled check below is expressed as
// `state === STATE_NEW` (or its negation), so nothing depends on the exact
// handled value — a record is "handled" iff its state is not 'new'.
import {
  STATE_NEW,
  SHORTS_MAX_SECONDS,
  RESUME_MIN_SECONDS,
  RESUME_END_MARGIN_SECONDS,
} from './config.js';

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
 * REGARDLESS of state (new / skipped), sorted ascending by
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
 * (oldest->newest) list: the first record whose state === 'new' (which skips any
 * handled 'skipped' video) AND is embeddable (embeddable !== false).
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
    if (isPlayable(list[k])) return list[k];
  }
  return null;
}

/**
 * The single eligibility rule shared by nextPlayable and firstPlayable: a record
 * is playable when it is still 'new' (skips any handled video) and embeddable
 * (embeddable !== false — undefined means "not known to be blocked").
 * @param {object|null|undefined} r
 * @returns {boolean}
 */
function isPlayable(r) {
  return !!r && r.state === STATE_NEW && r.embeddable !== false;
}

/**
 * The FIRST playable record in an ascending (oldest->newest) list — same
 * eligibility rule as nextPlayable, but scanning from the head instead of from a
 * current video. This is what the player's "Start the queue" button plays: the
 * oldest still-'new', embeddable video. Returns null when nothing is eligible
 * (empty list, everything handled, or every remaining video non-embeddable).
 * Pure; does not mutate.
 * @param {Array<object>} sorted visible records, ascending by publishedAt
 * @returns {object|null}
 */
export function firstPlayable(sorted) {
  const list = Array.isArray(sorted) ? sorted : [];
  for (let k = 0; k < list.length; k++) {
    if (isPlayable(list[k])) return list[k];
  }
  return null;
}

/**
 * The LAST handled ("skipped") record in an ascending (oldest->newest) list —
 * i.e. the latest one in render order. "Handled" follows the app-wide convention:
 * state !== 'new' (STATE_SKIPPED is the only handled state). Callers pass the
 * list they actually render, so any active view filter (Hide skipped) or display
 * windowing is already applied by the caller and honoured here. Returns null when
 * the list is empty or holds no handled record. Pure; does not mutate.
 * @param {Array<object>} records rendered records, ascending by publishedAt
 * @returns {object|null} the last handled record, or null
 */
export function lastSkipped(records) {
  const list = Array.isArray(records) ? records : [];
  for (let k = list.length - 1; k >= 0; k--) {
    const r = list[k];
    if (r && r.state !== STATE_NEW) return r;
  }
  return null;
}

/**
 * Given the id order BEFORE a re-render and the ids that SURVIVED it, pick the
 * id that stands in for `anchorId` — the user's place in the list. The anchor
 * itself if it survived; otherwise the first survivor AFTER it, else the
 * nearest survivor BEFORE it. Forward-first, the same preference the removal
 * rescue uses when a marked card leaves under the cursor.
 *
 * Returns null when nothing survived, and also when the anchor is null or is
 * not in `orderedIds` at all: that is an honest "no opinion" rather than a
 * guess, and callers already fall back to the first card.
 *
 * `survivingIds` may be a Set or an array. Pure; mutates nothing.
 * @param {Array<string>} orderedIds ids in render order, before the re-render
 * @param {string|null|undefined} anchorId the id the user's place was at
 * @param {Set<string>|Array<string>|null|undefined} survivingIds ids still rendered
 * @returns {string|null}
 */
export function nearestSurvivor(orderedIds, anchorId, survivingIds) {
  const order = Array.isArray(orderedIds) ? orderedIds : [];
  const alive =
    survivingIds instanceof Set ? survivingIds : new Set(Array.isArray(survivingIds) ? survivingIds : []);
  if (!anchorId) return null;
  const at = order.indexOf(anchorId);
  if (at < 0) return null;
  if (alive.has(anchorId)) return anchorId;
  for (let k = at + 1; k < order.length; k++) {
    if (alive.has(order[k])) return order[k];
  }
  for (let k = at - 1; k >= 0; k--) {
    if (alive.has(order[k])) return order[k];
  }
  return null;
}

/**
 * Compute the live CUTOFF marker: the boundary of the contiguous handled prefix
 * among the currently-present videos — "everything up to here is handled; the
 * first UNMARKED video is just after it."
 *
 * Sort ascending (tie-safe). Walk from the oldest present video (strictly after
 * `floor`): while it is handled (state !== 'new') advance the result to
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

/**
 * Lower bound for an INCREMENTAL refresh: only pull uploads newer than what we
 * already have. Returns `floor` when there are no stored records (so the first
 * run behaves like a full refresh). Otherwise takes the NEWEST stored
 * publishedAt, subtracts `bufferMs` (a lag safety margin), and returns the LATER
 * of that and `floor` — the result is ALWAYS >= floor. Pure.
 * @param {Array<object>} records stored video records
 * @param {string|null|undefined} floor the deletion/fetch floor (lower bound)
 * @param {number} bufferMs safety buffer subtracted from the newest timestamp
 * @returns {string|null} ISO lower bound (>= floor), or floor when no records
 */
export function incrementalSince(records, floor, bufferMs) {
  let newestMs = null;
  for (const rec of records || []) {
    const t = rec && rec.publishedAt ? Date.parse(rec.publishedAt) : NaN;
    if (!Number.isNaN(t) && (newestMs === null || t > newestMs)) newestMs = t;
  }
  if (newestMs === null) return floor; // no dated records: full refresh from floor

  const buffered = new Date(newestMs - (Number(bufferMs) || 0)).toISOString();
  // Clamp to the floor: never fetch below it.
  if (floor == null) return buffered;
  return compareIso(buffered, floor) >= 0 ? buffered : floor;
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

/**
 * The playback speed to use when a video plays, in PRIORITY order:
 *   1. the video's per-video `preferredSpeed`, when it is a valid preset (1/1.5/2);
 *   2. else the user's `defaultSpeed` setting, when it is a valid preset;
 *   3. else `currentSpeed` — retain the speed carried over from the previous video.
 * "valid" means exactly one of 1 / 1.5 / 2. Pure.
 * @param {number|undefined|null} preferredSpeed per-video preference
 * @param {number|undefined|null} defaultSpeed user's default-speed setting (null = unset)
 * @param {number} currentSpeed the current/global speed (previous video's speed)
 * @returns {number}
 */
export function effectiveSpeed(preferredSpeed, defaultSpeed, currentSpeed) {
  const isPreset = (s) => s === 1 || s === 1.5 || s === 2;
  if (isPreset(preferredSpeed)) return preferredSpeed;
  if (isPreset(defaultSpeed)) return defaultSpeed;
  return currentSpeed;
}

// ---------------------------------------------------------------------------
// Channel helpers (channel list page + per-channel fetch preferences)
// ---------------------------------------------------------------------------

/**
 * Flatten a channels map (channelId -> { title, avatarUrl }) into an array of
 * { channelId, title, avatarUrl } sorted alphabetically by title
 * (case-insensitive localeCompare), tie-broken by channelId so the order is
 * deterministic. Missing fields become ''. Pure.
 * @param {Record<string,{title?:string,avatarUrl?:string}>|null|undefined} channels
 * @returns {Array<{channelId:string,title:string,avatarUrl:string}>}
 */
export function sortChannels(channels) {
  const entries = Object.entries(channels || {}).map(([channelId, ch]) => ({
    channelId,
    title: (ch && ch.title) || '',
    avatarUrl: (ch && ch.avatarUrl) || '',
  }));
  return entries.sort((a, b) => {
    const c = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
    if (c !== 0) return c;
    if (a.channelId < b.channelId) return -1;
    if (a.channelId > b.channelId) return 1;
    return 0;
  });
}
/**
 * Resolve the channel display info for a SUBSCRIPTION record from the channels
 * map ALONE (yqa_channels, keyed by channelId) — an avatar carried on the record
 * itself is deliberately IGNORED here, and that is what keeps this policy
 * genuinely distinct from the stash one below. Subscription records are written
 * by the refresh path and carry no avatar of their own, while the map is
 * rewritten by every refresh, so the map is the single authority: a video stored
 * before its channel had an avatar self-heals on the next render, for free.
 * The TITLE still falls back from the record to the map, so a record stored
 * without one shows the name the map knows instead of nothing.
 * Pure — the caller supplies the map, and owns whether it is a fresh read or a
 * snapshot.
 * @param {object|null|undefined} rec video record
 * @param {Record<string,{title?:string,avatarUrl?:string}>|null|undefined} channels
 * @returns {{title:string,avatarUrl:string}} either may be '' when nothing resolves
 */
export function subscriptionChannelInfo(rec, channels) {
  const ch = channelEntry(rec, channels);
  return {
    title: (rec && rec.channelTitle) || (ch && ch.title) || '',
    avatarUrl: (ch && ch.avatarUrl) || '',
  };
}

/**
 * Resolve the channel display info for a STASH record: the avatar the record
 * carries ITSELF (`channelAvatarUrl`) wins, and the channels map is only the
 * fallback. The record-carried copy is what frees the stash from yqa_channels —
 * pruneChannels may drop the entry of a channel a stashed video still references,
 * and that card must keep its picture. The fallback is load-bearing all the same:
 * records stashed before avatars were captured, and ones whose avatar fetch
 * failed, have nothing of their own and resolve through the map. The TITLE falls
 * back from the record to the map, exactly as above. Pure.
 * @param {object|null|undefined} rec stash record (may carry `channelAvatarUrl`)
 * @param {Record<string,{title?:string,avatarUrl?:string}>|null|undefined} channels
 * @returns {{title:string,avatarUrl:string}} either may be '' when nothing resolves
 */
export function stashChannelInfo(rec, channels) {
  const ch = channelEntry(rec, channels);
  return {
    title: (rec && rec.channelTitle) || (ch && ch.title) || '',
    avatarUrl: (rec && rec.channelAvatarUrl) || (ch && ch.avatarUrl) || '',
  };
}

/**
 * The channels-map entry for a record's channel, or null — the ONE lookup both
 * resolvers above share, so "which key, and when is there no entry" is written
 * down once. Tolerant of a missing record, a missing/blank channelId, and a
 * missing or non-object (or array) map.
 * @param {object|null|undefined} rec
 * @param {*} channels
 * @returns {{title?:string,avatarUrl?:string}|null}
 */
function channelEntry(rec, channels) {
  const id = rec && rec.channelId;
  if (!id) return null;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return null;
  return channels[id] || null;
}

/**
 * True when a channel is marked ignored in the prefs map — its uploads are
 * skipped entirely on future fetches (existing records stay untouched). Pure.
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {string} channelId
 * @returns {boolean}
 */
export function isChannelIgnored(prefs, channelId) {
  const p = prefs && channelId ? prefs[channelId] : null;
  return !!(p && p.ignored === true);
}

/**
 * A channel's preferred speed when it is a valid preset (1/1.5/2), else
 * undefined (no preference). Pure.
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {string} channelId
 * @returns {number|undefined}
 */
export function channelPreferredSpeed(prefs, channelId) {
  const p = prefs && channelId ? prefs[channelId] : null;
  const s = p ? p.speed : undefined;
  return s === 1 || s === 1.5 || s === 2 ? s : undefined;
}

/**
 * Fill in each channel's preferred speed on the records that do not have one:
 * a record whose `preferredSpeed` is unset (undefined/null) and whose channel
 * has a preferred speed gets that speed. A record that already carries an
 * explicit `preferredSpeed` is NEVER overwritten or cleared, and records of
 * IGNORED channels (or of channels with no speed pref) are left exactly as they
 * are.
 *
 * `onlyVideoIds` limits which records are ELIGIBLE for the fill (a Set or array
 * of videoIds); null/undefined means every record is. "Refresh all" passes null
 * (fill the whole stored set), while "Fetch new" passes just the videoIds it
 * newly inserted, so an incremental fetch never re-speeds already-stored videos.
 *
 * Returns a NEW array; unchanged records are passed through by reference and
 * nothing is mutated. Pure.
 * @param {Array<object>} records
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {Set<string>|Array<string>|null|undefined} [onlyVideoIds] eligible ids
 * @returns {Array<object>}
 */
export function applyChannelSpeeds(records, prefs, onlyVideoIds) {
  const list = Array.isArray(records) ? records : [];
  const only =
    onlyVideoIds == null
      ? null
      : onlyVideoIds instanceof Set
        ? onlyVideoIds
        : new Set(onlyVideoIds);
  return list.map((rec) => {
    if (!rec || rec.preferredSpeed != null) return rec;
    if (only && !only.has(rec.videoId)) return rec;
    if (isChannelIgnored(prefs, rec.channelId)) return rec;
    const speed = channelPreferredSpeed(prefs, rec.channelId);
    return speed === undefined ? rec : { ...rec, preferredSpeed: speed };
  });
}

/**
 * Return a NEW prefs map with `patch` applied to `channelId`, storing only
 * non-default values: `ignored` is kept only when exactly true, `speed` only
 * when a valid preset (1/1.5/2) — anything else REMOVES the key. A per-channel
 * object left empty is dropped from the map. Neither input is mutated. Pure.
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {string} channelId
 * @param {{ignored?:boolean,speed?:(number|undefined)}} patch
 * @returns {Record<string,{ignored?:boolean,speed?:number}>}
 */
export function setChannelPref(prefs, channelId, patch) {
  const next = { ...(prefs || {}) };
  if (!channelId) return next;
  const p = patch || {};
  // A non-object stored value (hand-edited/foreign) is treated as empty rather
  // than spread (a string would leak its characters as index keys and the entry
  // could then never be dropped).
  const prev = next[channelId];
  const cur =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
  if ('ignored' in p) {
    if (p.ignored === true) cur.ignored = true;
    else delete cur.ignored;
  }
  if ('speed' in p) {
    const s = p.speed;
    if (s === 1 || s === 1.5 || s === 2) cur.speed = s;
    else delete cur.speed;
  }
  if (Object.keys(cur).length === 0) delete next[channelId];
  else next[channelId] = cur;
  return next;
}

/**
 * Prune the stored channel map (and the matching per-channel prefs) of channels
 * that are gone. A channel is removed only when BOTH hold: its channelId is
 * ABSENT from the freshly-fetched subscriptions, AND no stored record still
 * belongs to it. A channel with videos still in the queue therefore KEEPS its
 * entry — its cards need the avatar/title — and drops on a later refresh once
 * those videos drain.
 *
 * The sweep covers the UNION of both maps (deduped; channel keys first, then
 * prefs-only keys), so an ORPHAN prefs entry — one with no channels entry at
 * all — is judged by those same two conditions instead of lingering forever.
 *
 * DEFENSIVE: an empty (or non-array, or all-malformed) `subs` prunes NOTHING —
 * an empty subscriptions list reads as a failed/suspect fetch, never as
 * "unsubscribed from everything".
 *
 * Neither input is mutated, and neither is normalized on the caller's behalf:
 * this helper PRUNES, nothing more. Whatever is not pruned comes back VERBATIM
 * by identity — the `channels` and `prefs` arguments themselves when nothing is
 * pruned, and either one alone when only the OTHER map lost an entry, malformed
 * or absent ones included. So the caller can compare identities to skip the
 * writes it does not need, and can never be handed a map this helper invented.
 * Pure.
 *
 * @param {Record<string,{title?:string,avatarUrl?:string}>|null|undefined} channels
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {Array<{channelId?:string}>|null|undefined} subs freshly fetched subscriptions
 * @param {Array<object>|null|undefined} records stored video records
 * @returns {{channels:*,prefs:*,removed:Array<string>}} a pruned map is a fresh
 *   object, an unpruned one is the argument as given; removed = pruned channelIds
 */
export function pruneChannels(channels, prefs, subs, records) {
  const chanMap =
    channels && typeof channels === 'object' && !Array.isArray(channels)
      ? channels
      : {};
  const prefMap =
    prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
  // The RAW arguments, not the normalized maps: an untouched input is handed
  // back exactly as it came in (see the identity contract above).
  const unchanged = { channels, prefs, removed: [] };

  // A missing/empty subscriptions list means the fetch failed, not that every
  // subscription is gone: prune nothing.
  if (!Array.isArray(subs) || subs.length === 0) return unchanged;
  const subscribed = new Set();
  for (const s of subs) {
    if (s && s.channelId) subscribed.add(s.channelId);
  }
  if (subscribed.size === 0) return unchanged; // only malformed entries: same as a failed fetch

  // Channels that still own at least one stored video keep their entry.
  const withVideos = new Set();
  for (const r of records || []) {
    if (r && r.channelId) withVideos.add(r.channelId);
  }

  // Candidates are the UNION of both maps, so a prefs entry with no channels
  // entry (an orphan — hand-edited storage, or predating pruning) sweeps out on
  // the very same two conditions. Deduped, channels keys first then prefs-only
  // keys, each in insertion order: `removed` is deterministic.
  const has = (map, id) => Object.prototype.hasOwnProperty.call(map, id);
  const candidates = Object.keys(chanMap).concat(
    Object.keys(prefMap).filter((id) => !has(chanMap, id))
  );
  const removed = candidates.filter(
    (id) => !subscribed.has(id) && !withVideos.has(id)
  );
  if (removed.length === 0) return unchanged;

  const nextChannels = { ...chanMap };
  const nextPrefs = { ...prefMap };
  let channelsChanged = false;
  let prefsChanged = false;
  for (const id of removed) {
    if (has(chanMap, id)) {
      delete nextChannels[id];
      channelsChanged = true;
    }
    if (has(prefMap, id)) {
      delete nextPrefs[id];
      prefsChanged = true;
    }
  }
  return {
    channels: channelsChanged ? nextChannels : channels,
    prefs: prefsChanged ? nextPrefs : prefs,
    removed,
  };
}

// ---------------------------------------------------------------------------
// Refresh merge ("Fetch new" / "Refresh all" — the whole composition)
// ---------------------------------------------------------------------------

/**
 * The complete refresh merge, as ONE pure step: upsert the freshly fetched
 * records into the stored set (existing state preserved, never duplicated),
 * then fill in each channel's preferred speed on the records that lack one.
 * FILL-IF-ABSENT: a record carrying an explicit `preferredSpeed` is never
 * overwritten or cleared, and records of ignored channels are left as they are.
 *
 * `sweepSpeeds` is the refresh MODE (passed explicitly — never inferred from the
 * fetch bound): "Refresh all" sweeps the WHOLE stored set, so older
 * already-stored videos pick up their channel's speed too, while "Fetch new"
 * reaches only this fetch's arrivals — a video re-returned inside the buffer
 * window counts as already-stored and keeps what it has.
 *
 * Returns a NEW array; neither input array is mutated. Pure.
 *
 * @param {Array<object>} existing stored video records
 * @param {Array<object>} incoming freshly fetched records
 * @param {Record<string,{ignored?:boolean,speed?:number}>|null|undefined} prefs
 * @param {{sweepSpeeds?:boolean}} [options] defaults to the "Fetch new" scope
 * @returns {Array<object>}
 */
export function mergeRefresh(existing, incoming, prefs, { sweepSpeeds = false } = {}) {
  const stored = new Set(existing.map((r) => r.videoId));
  const arrivals = new Set(
    incoming.map((v) => v.videoId).filter((id) => !stored.has(id))
  );
  const merged = upsertVideos(existing, incoming);
  return sweepSpeeds
    ? applyChannelSpeeds(merged, prefs, null) // "Refresh all": every record
    : applyChannelSpeeds(merged, prefs, arrivals); // "Fetch new": arrivals only
}

// ---------------------------------------------------------------------------
// Description parsing (linkify timestamps + urls for the video description)
// ---------------------------------------------------------------------------

// A timestamp (M:SS / MM:SS / H:MM:SS / HH:MM:SS) OR an http(s) url. The `\w`
// boundaries keep a timestamp from matching when glued to surrounding
// digits/word-chars (e.g. "1234:56", "192:168", "v1:23x"); seconds are always
// 00-59 and, when an hours field is present, the minutes field is too.
const DESCRIPTION_TOKEN_RE =
  /(?<!\w)\d{1,2}:[0-5]\d(?::[0-5]\d)?(?!\w)|https?:\/\/\S+/g;

// Trailing sentence punctuation that belongs to the surrounding prose, not the url.
const URL_TRAILING_PUNCT_RE = /[.,)\]}!?]+$/;

/**
 * Split a video description into an ordered array of segments whose `text`
 * fields concatenate back to the exact input string. Segment shapes:
 *   { type:'text', text }                    — a plain run (may hold spaces/newlines)
 *   { type:'timestamp', text, seconds }      — `text` is the match, `seconds` its total
 *   { type:'url', text, url }                — `text` and `url` are the matched url
 * Empty / whitespace-only input returns []. Pure.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseDescription(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const segments = [];
  const re = new RegExp(DESCRIPTION_TOKEN_RE.source, 'g');
  let cursor = 0;
  let m;

  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const isUrl = /^https?:\/\//i.test(m[0]);

    // Strip trailing punctuation off urls so it stays in the surrounding text.
    let matched = m[0];
    if (isUrl) matched = matched.replace(URL_TRAILING_PUNCT_RE, '');
    const end = start + matched.length;

    if (start > cursor) {
      segments.push({ type: 'text', text: text.slice(cursor, start) });
    }

    if (isUrl) {
      segments.push({ type: 'url', text: matched, url: matched });
    } else {
      const parts = matched.split(':').map((p) => parseInt(p, 10));
      const [h, mm, ss] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
      segments.push({ type: 'timestamp', text: matched, seconds: h * 3600 + mm * 60 + ss });
    }

    cursor = end;
    re.lastIndex = end; // reconsider any stripped punctuation as text
  }

  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  return segments;
}

// ---------------------------------------------------------------------------
// Stash (hand-added videos: paste a link, play it, remove it)
// ---------------------------------------------------------------------------

// A YouTube video id is exactly 11 chars of [A-Za-z0-9_-]. The trailing
// lookahead makes a LONGER run of id chars a REJECTION rather than a silent
// truncation to its first 11 characters.
const VIDEO_ID_RE_SRC = '([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])';
// Optional protocol: 'https:', 'http:', a bare '//' prefix, or nothing at all.
const PROTOCOL_RE_SRC = '(?:(?:https?:)?//)?';
const YT_HOST_RE_SRC = '(?:www\\.|m\\.|music\\.)?(?:youtube\\.com|youtube-nocookie\\.com)';
const YT_SHORT_HOST_RE_SRC = '(?:www\\.)?youtu\\.be';

// Every pattern is anchored at ^ so a lookalike host can never match: neither a
// PREFIX one ('evil-youtube.com/watch?v=...' — the anchor rejects it) nor a
// SUFFIX one ('youtube.com.evil.tld/watch?v=...' — the host is followed by '.'
// where the pattern requires '/'). The 'i' flag matters only for the HOST; the
// captured id is a slice of the input, so it always keeps its exact case.
const VIDEO_URL_PATTERNS = [
  // /watch?v=ID — 'v' need not be the first parameter, and anything may follow.
  new RegExp(
    '^' + PROTOCOL_RE_SRC + YT_HOST_RE_SRC + '/watch\\?(?:[^#]*&)?v=' + VIDEO_ID_RE_SRC,
    'i'
  ),
  // /shorts/ID, /embed/ID, /live/ID, /v/ID
  new RegExp(
    '^' + PROTOCOL_RE_SRC + YT_HOST_RE_SRC + '/(?:shorts|embed|live|v)/' + VIDEO_ID_RE_SRC,
    'i'
  ),
  // youtu.be/ID (a '?t=' / '?si=' suffix or a trailing '/' just ends the id).
  new RegExp('^' + PROTOCOL_RE_SRC + YT_SHORT_HOST_RE_SRC + '/' + VIDEO_ID_RE_SRC, 'i'),
  // A bare id pasted on its own.
  new RegExp('^' + VIDEO_ID_RE_SRC + '$'),
];

/**
 * Extract the 11-char video id from a pasted YouTube link (or from a bare id),
 * else null.
 *
 * REGEX, not `new URL()`, deliberately: `new URL('youtu.be/ID')` THROWS on
 * protocol-less input, which is an input we must accept; `URL` signals failure
 * by throwing when the normal outcome here is simply `null`; a bare id is not a
 * URL at all; and anchoring one alternation at ^ rules out lookalike hosts more
 * directly than parsing and then checking a hostname allow-list.
 *
 * Surrounding whitespace is trimmed (pastes carry newlines). Accepts an optional
 * protocol, the www./m./music. subdomains, youtube-nocookie.com, and a trailing
 * slash after the id. Pure.
 * @param {string} input a pasted URL or bare video id
 * @returns {string|null} the 11-char id, or null when nothing matches
 */
export function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text === '') return null;
  for (const re of VIDEO_URL_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

/**
 * The instant a stash record was added, in epoch millis, with a MISSING or
 * UNPARSEABLE `addedAt` mapped to +Infinity so it sorts LAST. Accepts the ISO
 * string the app writes, and tolerates a raw epoch-millis number.
 * @param {object|null|undefined} rec
 * @returns {number}
 */
function addedAtMs(rec) {
  const v = rec ? rec.addedAt : undefined;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY;
  }
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Return a NEW array of stash records in the stash's ONLY order: oldest
 * `addedAt` first. NOT publishedAt — the stash is hand-curated, so the order the
 * user added things in IS the user's order. Ties break by videoId, exactly like
 * sortAscending, so the result is deterministic.
 *
 * A record with a missing or unparseable `addedAt` sorts LAST: every record the
 * app writes is stamped, so an unstamped one is foreign / hand-edited data, and
 * the tail is where it does the least damage (sorting it first would park a
 * mystery row right next to play).
 *
 * NOT built on compareIso: that helper falls back to a LEXICAL compare for
 * unparseable input, which would order a missing `addedAt` arbitrarily instead
 * of last. Parsed instants are compared here, so '...T12:00:00+02:00' and
 * '...T10:00:00Z' compare as the same instant rather than as two strings.
 *
 * This is deliberately the SINGLE sort site for the stash: when drag-to-reorder
 * lands it adds an `order` field and changes exactly this one function. Pure;
 * does not mutate.
 * @param {Array<object>} records stash records
 * @returns {Array<object>}
 */
export function sortStash(records) {
  const list = Array.isArray(records) ? records : [];
  return list.slice().sort((r1, r2) => {
    const t1 = addedAtMs(r1);
    const t2 = addedAtMs(r2);
    // Compared, never subtracted: Infinity - Infinity is NaN.
    if (t1 !== t2) return t1 < t2 ? -1 : 1;
    // Deterministic tie-break.
    const id1 = (r1 && r1.videoId) || '';
    const id2 = (r2 && r2.videoId) || '';
    if (id1 < id2) return -1;
    if (id1 > id2) return 1;
    return 0;
  });
}

/**
 * The deletion set for the stash's "Clean up": every record the user has marked
 * "Remove" — i.e. every handled record, `state !== 'new'` (stored as
 * STATE_SKIPPED). Returns RECORDS, the same shape videosToClean returns, not ids.
 *
 * CONTRAST with videosToClean(records, cutoff) — and it is the whole reason the
 * stash needs neither a floor nor a cutoff: that one is POSITION-based
 * (publishedAt <= cutoff), so it can only ever delete a contiguous PREFIX of the
 * list; this one is STATE-based and takes no cutoff at all, so it deletes
 * handled records from ANYWHERE in the list, gaps included. Pure; does not
 * mutate.
 * @param {Array<object>} records stash records
 * @returns {Array<object>} records to delete
 */
export function stashToClean(records) {
  const list = Array.isArray(records) ? records : [];
  return list.filter((r) => r && r.state !== STATE_NEW);
}

/**
 * Add one video to the stash — a pasted link on stash.html, or a subscriptions
 * card's "Add to stash" — as ONE pure step, the same idea as mergeRefresh, so
 * the tests exercise the real composition instead of a mirror of it.
 *
 * A NEW videoId is APPENDED (the stash's order is arrival order), stamped
 * `state: 'new'` and `addedAt`, and given its channel's preferred speed when —
 * and only when — the incoming record carries none (undefined OR null): the
 * fill-if-absent rule, identical to the subscriptions one.
 *
 * A DUPLICATE never moves: it keeps its PLACE and its `addedAt`, and its
 * metadata is never refreshed from the incoming copy. But adding a video you
 * already have is still a gesture that means something, so exactly two fields
 * can change, and only ever in one direction:
 *
 *   - REVIVE — a duplicate marked "Remove" goes back to `state: 'new'`. Adding
 *     it again is the plainest way there is of saying you want it back, and the
 *     alternative is to silently do nothing to a record the next Clean up
 *     deletes.
 *   - RE-SPEED — an incoming `preferredSpeed` that is PRESENT (neither undefined
 *     nor null: the same test the fill-if-absent path uses) OVERRIDES the
 *     stashed one; an incoming record carrying none leaves the stashed speed
 *     exactly as it is. That is one rule serving both entrances rather than two:
 *     a card carries the speed you set on it, while the paste-a-link flow builds
 *     its record from getVideosByIds, which has no speed to carry, so there it
 *     always degrades to "keep what the stash has".
 *
 * A duplicate is deliberately NOT run through the channel-prefs fill — it went
 * through that when it was first stashed, and a channel speed set since is not a
 * statement about a video already sitting here. It takes an EXPLICIT incoming
 * speed and nothing else.
 *
 * `changed` is the flag the caller persists on: true for an add, true for a
 * duplicate one of those two rules touched, and false for a duplicate nothing
 * happened to. In that last case ONLY, the input array comes back BY IDENTITY,
 * so "there is nothing to write" is visible to the caller as an identity check.
 * `added` still separates an arrival from an update, for the wording of the
 * toast.
 *
 * The channel speed is read with the LEAF channelPreferredSpeed, never with
 * applyChannelSpeeds: that one deliberately excludes IGNORED channels, and the
 * stash ignores the Ignore flag on purpose — Ignore governs what gets FETCHED by
 * subscription, and nothing here is fetched by subscription. (Hence calling the
 * leaf, rather than adding a policy flag to applyChannelSpeeds, whose single
 * policy is documented.)
 *
 * `addedAt` is INJECTED, never read from a clock: this module has none (cf.
 * daysAgoIso). Mutates neither input — an updated duplicate comes back as a COPY
 * substituted at the same index of a new array, exactly as the add path returns
 * a new array, so a caller that has already rendered the old object is never
 * changed underneath. Pure.
 *
 * @param {Array<object>} records the current stash
 * @param {object} incoming the record to add (videoId + metadata)
 * @param {{addedAt?:string, prefs?:Record<string,{ignored?:boolean,speed?:number}>}} [options]
 * @returns {{records:Array<object>, added:boolean, changed:boolean, record:object}}
 */
export function addToStash(records, incoming, { addedAt, prefs } = {}) {
  const list = Array.isArray(records) ? records : [];
  const videoId = incoming ? incoming.videoId : undefined;
  const at = videoId ? list.findIndex((r) => r && r.videoId === videoId) : -1;
  if (at !== -1) {
    const existing = list[at];
    const speed = incoming.preferredSpeed;
    const revive = existing.state !== STATE_NEW;
    const respeed = speed != null && speed !== existing.preferredSpeed;
    // Nothing this add can still say about it: hand back the very same array so
    // the caller can skip its write.
    if (!revive && !respeed) return { records, added: false, changed: false, record: existing };
    const record = { ...existing };
    if (revive) record.state = STATE_NEW;
    if (respeed) record.preferredSpeed = speed;
    const updated = list.slice();
    updated[at] = record;
    return { records: updated, added: false, changed: true, record };
  }

  const record = { ...incoming, state: STATE_NEW, addedAt };
  if (record.preferredSpeed == null) {
    const speed = channelPreferredSpeed(prefs, record.channelId);
    // No channel preference: leave NO preferredSpeed key at all, rather than an
    // explicit undefined/null one.
    if (speed === undefined) delete record.preferredSpeed;
    else record.preferredSpeed = speed;
  }
  return { records: list.concat([record]), added: true, changed: true, record };
}

/**
 * Do these two copies of one stash record say the same thing? A SHALLOW compare
 * of every own key on both sides — records are flat (strings, numbers, booleans)
 * — and an absent key is not the same as a present undefined one, because
 * addToStash goes to the trouble of omitting `preferredSpeed` rather than
 * writing it undefined. A nested field would compare by reference and so read as
 * different, which costs a needless re-render and never a wrong one.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameStashContent(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Merge a FRESHLY-READ stash into the one this page holds in memory, after
 * another tab announced a write (see store.js's cross-tab sync). MEMBERSHIP
 * always follows `fresh`; CONTENT follows it too, for everything except the
 * records this tab has a write in flight for:
 *
 *   - ADD    a videoId in `fresh` but not in `current` — the other tab's new
 *            stash entry arriving.
 *   - REMOVE a videoId absent from `fresh` — it was swept.
 *   - For a videoId in BOTH, take `fresh`'s content — UNLESS that videoId is in
 *     `inFlight`, in which case keep the local object untouched.
 *
 * That exception is the reason this is a merge and not a wholesale replace, and
 * in-flight is exactly the scope it needs: the stash page marks OPTIMISTICALLY —
 * it sets `rec.state` in memory and only THEN awaits the write — so for the
 * length of that write DISK IS BEHIND MEMORY for that one videoId, and adopting
 * it would resurrect the pre-mark state and un-mark the card under the user. The
 * exception cannot be widened back to "every videoId we already hold": the other
 * tab UPDATES existing stash records now (re-adding a video un-marks it — see
 * addToStash), so a record we are NOT writing has to be free to change out from
 * under us, or an un-mark done over there would never appear here.
 *
 * `changed` is what the caller re-renders on, so it covers both kinds of
 * difference: the MEMBERSHIP moving (an add, a removal, a malformed entry
 * dropped) OR a record we hold coming back from disk with DIFFERENT CONTENT.
 * Membership alone was enough only while local content always won. A record we
 * KEPT is never a change — it is in flight, or it is byte-identical to what disk
 * says — and that is what still buys the common case its silence: a signal about
 * something this page cannot see costs no re-render, and none of the scroll and
 * focus disturbance that comes with one.
 *
 * Order is NOT imposed here — the caller sorts, exactly as it does after
 * addToStash, so sortStash stays the stash's single sort site. Tolerant of
 * malformed data like every helper here: a null / videoId-less entry on either
 * side is dropped, and a duplicate id in `fresh` is taken once. Mutates neither
 * input; the records in the result are the input objects by reference, never
 * copies. Pure — `inFlight` is read, never written, and only through `.has`.
 *
 * @param {Array<object>} current the stash this page holds in memory
 * @param {Array<object>} fresh the stash just re-read from the store
 * @param {{has:(videoId:string)=>boolean}} [inFlight] the videoIds this tab has a
 *        write in flight for (a Set, or the page's refcount Map): their local
 *        objects are kept whatever `fresh` says
 * @returns {{records:Array<object>, changed:boolean}}
 */
export function reconcileStash(current, fresh, inFlight) {
  const mine = Array.isArray(current) ? current : [];
  const theirs = Array.isArray(fresh) ? fresh : [];
  const held = inFlight && typeof inFlight.has === 'function' ? inFlight : null;

  const known = new Map();
  for (const rec of mine) {
    if (rec && rec.videoId) known.set(rec.videoId, rec);
  }

  const records = [];
  const seen = new Set();
  let changed = false;
  for (const rec of theirs) {
    const videoId = rec && rec.videoId;
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const local = known.get(videoId);
    if (local === undefined) {
      changed = true; // an arrival from the other tab
      records.push(rec);
    } else if ((held && held.has(videoId)) || sameStashContent(local, rec)) {
      // Ours is mid-write (disk is behind memory), or disk has nothing new to
      // say. Either way keep the object we already hold, by identity.
      records.push(local);
    } else {
      changed = true; // the other tab updated a record we hold
      records.push(rec);
    }
  }

  // Whatever we held that `fresh` did not account for is gone: a record swept in
  // the other tab, a duplicate, or a malformed entry with no videoId to match
  // on. Counting is enough — every id in `fresh` that we already had is in
  // `records`, so a shorter result can only mean something of ours dropped out.
  if (records.length !== mine.length) changed = true;

  return { records, changed };
}
