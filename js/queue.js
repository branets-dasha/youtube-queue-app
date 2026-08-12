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
    const r = list[k];
    if (r && r.state === STATE_NEW && r.embeddable !== false) return r;
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
