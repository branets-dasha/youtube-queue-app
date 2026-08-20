// js/queue.test.mjs
//
// Node unit tests for the PURE queue logic (js/queue.js references no browser
// globals, so it imports directly). Run from the repo root with:
//     node js/queue.test.mjs
// No dependencies beyond Node's built-in assert.

import assert from 'node:assert';
import {
  upsertVideos,
  computeQueue,
  computeVisible,
  computeCutoff,
  videosToClean,
  lastSkipped,
  nextPlayable,
  firstPlayable,
  compareIso,
  parseIsoDuration,
  formatDuration,
  isShort,
  resumeStart,
  effectiveSpeed,
  incrementalSince,
  parseDescription,
  sortChannels,
  subscriptionChannelInfo,
  stashChannelInfo,
  isChannelIgnored,
  channelPreferredSpeed,
  applyChannelSpeeds,
  setChannelPref,
  pruneChannels,
  mergeRefresh,
  parseVideoId,
  sortStash,
  stashToClean,
  addToStash,
  reconcileStash,
} from './queue.js';
import { SHORTS_MAX_SECONDS } from './config.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const rec = (videoId, publishedAt, state) => ({
  videoId,
  publishedAt,
  state,
  title: videoId,
  channelId: 'c',
  channelTitle: 'ch',
  thumbnailUrl: '',
});

// A stash record: ordered by addedAt (NOT publishedAt), which is why every
// fixture below shares one publishedAt — it must never influence the order.
const stashRec = (videoId, addedAt, state) => ({
  videoId,
  addedAt,
  state,
  publishedAt: '2026-01-01T00:00:00Z',
  title: videoId,
  channelId: 'c',
  channelTitle: 'ch',
  thumbnailUrl: '',
});

// --- computeVisible: render list = ALL states, strictly after cutoff, sorted ---

test('computeVisible includes marked videos (any state), oldest first', () => {
  const recs = [
    rec('d', '2026-01-04T00:00:00Z', 'new'),
    rec('a', '2026-01-01T00:00:00Z', 'skipped'),
    rec('c', '2026-01-03T00:00:00Z', 'skipped'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
  ];
  const ids = computeVisible(recs, '2025-12-31T00:00:00Z').map((r) => r.videoId);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']); // marked a & c still present, sorted
});

test('computeVisible excludes records at or before the cutoff', () => {
  const recs = [
    rec('old', '2026-01-01T00:00:00Z', 'new'), // strictly before -> out
    rec('eq', '2026-01-02T00:00:00Z', 'new'), // == cutoff -> out
    rec('keep', '2026-01-03T00:00:00Z', 'skipped'), // after -> in (even though marked)
  ];
  const ids = computeVisible(recs, '2026-01-02T00:00:00Z').map((r) => r.videoId);
  assert.deepEqual(ids, ['keep']);
});

test('computeVisible with null cutoff returns everything, sorted', () => {
  const recs = [
    rec('b', '2026-01-02T00:00:00Z', 'skipped'),
    rec('a', '2026-01-01T00:00:00Z', 'new'),
  ];
  assert.deepEqual(computeVisible(recs, null).map((r) => r.videoId), ['a', 'b']);
});

// --- computeQueue: unchanged 'new'-only subset (drives the "Queued" count) ---

test('computeQueue still returns only still-new videos', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'skipped'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
    rec('c', '2026-01-03T00:00:00Z', 'skipped'),
  ];
  assert.deepEqual(computeQueue(recs, null).map((r) => r.videoId), ['b']);
});

// --- lastSkipped: jump target = last handled record in render order ---

test('lastSkipped returns the LAST handled record when several are present', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'skipped'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
    rec('c', '2026-01-03T00:00:00Z', 'skipped'),
    rec('d', '2026-01-04T00:00:00Z', 'new'),
    rec('e', '2026-01-05T00:00:00Z', 'skipped'),
  ];
  assert.equal(lastSkipped(recs).videoId, 'e');
});

test('lastSkipped ignores newer new videos: skipped need not be last in the list', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'new'),
    rec('b', '2026-01-02T00:00:00Z', 'skipped'),
    rec('c', '2026-01-03T00:00:00Z', 'new'),
    rec('d', '2026-01-04T00:00:00Z', 'new'),
  ];
  assert.equal(lastSkipped(recs).videoId, 'b');
});

test('lastSkipped returns null when nothing is handled', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'new'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
  ];
  assert.equal(lastSkipped(recs), null);
});

test('lastSkipped returns null for an empty / missing list', () => {
  assert.equal(lastSkipped([]), null);
  assert.equal(lastSkipped(undefined), null);
});

// --- computeCutoff: contiguous handled-prefix marker, floor-bounded, tie-safe ---

const FLOOR = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const T3 = '2026-01-04T00:00:00Z';
const T4 = '2026-01-05T00:00:00Z';

test('computeCutoff advances over a contiguous handled prefix and stops at first new', () => {
  const recs = [
    rec('a', T1, 'skipped'),
    rec('b', T2, 'skipped'),
    rec('c', T3, 'new'),
    rec('d', T4, 'skipped'), // handled but AFTER the first new -> does not count
  ];
  assert.equal(computeCutoff(recs, FLOOR), T2); // stops at c (first new)
});

test('computeCutoff returns floor when the oldest present is new (or no records)', () => {
  assert.equal(
    computeCutoff([rec('a', T1, 'new'), rec('b', T2, 'skipped')], FLOOR),
    FLOOR
  );
  assert.equal(computeCutoff([], FLOOR), FLOOR);
});

test('computeCutoff tie-safety: never reaches a new video tying a handled one; result >= floor', () => {
  const T = '2026-02-01T00:00:00Z';
  const recs = [rec('h', T, 'skipped'), rec('n', T, 'new')]; // same timestamp
  const c = computeCutoff(recs, FLOOR);
  assert.equal(c, FLOOR); // cannot advance onto the tie
  assert.ok(compareIso(c, T) < 0, 'cutoff must be strictly before the new video');
});

test('cutoff retreats on un-mark and returns on re-mark', () => {
  const A = rec('A', T1, 'skipped');
  const B = rec('B', T2, 'skipped');
  const C = rec('C', T3, 'new');
  const recs = [A, B, C];
  assert.equal(computeCutoff(recs, FLOOR), T2); // cutoff = B
  A.state = 'new'; // un-mark A (inside the handled prefix)
  assert.equal(computeCutoff(recs, FLOOR), FLOOR); // retreats to floor
  A.state = 'skipped'; // re-mark A
  assert.equal(computeCutoff(recs, FLOOR), T2); // back to B
});

// --- videosToClean + cleanup semantics + FLOOR-based visibility ---

test('videosToClean is exactly the <= cutoff set; after cleanup floor=cutoff excludes them', () => {
  const recs = [rec('a', T1, 'skipped'), rec('b', T2, 'skipped'), rec('c', T3, 'new')];
  const cutoff = computeCutoff(recs, FLOOR); // T2
  const cleaned = videosToClean(recs, cutoff)
    .map((r) => r.videoId)
    .sort();
  assert.deepEqual(cleaned, ['a', 'b']);

  const remaining = recs.filter((r) => !cleaned.includes(r.videoId));
  const newFloor = cutoff; // cleanup sets floor = cutoff
  const visibleIds = computeVisible(remaining, newFloor).map((r) => r.videoId);
  assert.deepEqual(visibleIds, ['c']); // cleaned a,b gone; c remains
});

test('computeVisible is FLOOR-based: marked videos after the floor still appear', () => {
  const recs = [rec('a', T1, 'skipped'), rec('b', T2, 'new')];
  // On mark, the render list uses FLOOR (not the cutoff marker), so the skipped
  // 'a' stays visible/greyed and does NOT disappear.
  const visibleIds = computeVisible(recs, FLOOR).map((r) => r.videoId);
  assert.deepEqual(visibleIds, ['a', 'b']);
});

// --- duration helpers ---

test('parseIsoDuration parses H/M/S forms', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
  assert.equal(parseIsoDuration('PT4M13S'), 253);
  assert.equal(parseIsoDuration('PT45S'), 45);
  assert.equal(parseIsoDuration('PT1H'), 3600);
});

test('parseIsoDuration returns 0 for zero/missing/invalid', () => {
  assert.equal(parseIsoDuration('PT0S'), 0);
  assert.equal(parseIsoDuration('P0D'), 0);
  assert.equal(parseIsoDuration(''), 0);
  assert.equal(parseIsoDuration('garbage'), 0);
  assert.equal(parseIsoDuration(undefined), 0);
});

test('formatDuration formats M:SS and H:MM:SS', () => {
  assert.equal(formatDuration(59), '0:59'); // 59s
  assert.equal(formatDuration(60), '1:00'); // 60s
  assert.equal(formatDuration(3723), '1:02:03'); // 1h 2m 3s
  assert.equal(formatDuration(0), '0:00');
});

test('isShort: positive and <= SHORTS_MAX_SECONDS is short; above / 0 / unknown are not', () => {
  assert.equal(isShort(SHORTS_MAX_SECONDS), true); // boundary: threshold itself is short
  assert.equal(isShort(1), true);
  assert.equal(isShort(SHORTS_MAX_SECONDS + 1), false); // just over -> not short
  assert.equal(isShort(0), false); // zero/unknown length
  assert.equal(isShort(undefined), false);
  assert.equal(isShort(-5), false);
});

// --- nextPlayable: auto-advance selection (skips handled 'skipped' / non-embeddable) ---

const play = (videoId, state, embeddable) => ({
  videoId,
  state,
  embeddable, // undefined | true | false
  publishedAt: '2026-01-01T00:00:00Z',
  title: videoId,
});

test('nextPlayable skips handled (skipped) and non-embeddable; returns first eligible new', () => {
  const sorted = [
    play('cur', 'skipped', true),
    play('s1', 'skipped', true), // skip (handled)
    play('s2', 'skipped', true), // skip (handled)
    play('ne', 'new', false), // skip (non-embeddable)
    play('ok', 'new', true), // <- first eligible after cur
    play('ok2', 'new', true),
  ];
  assert.equal(nextPlayable(sorted, 'cur').videoId, 'ok');
});

test('nextPlayable treats embeddable === undefined as playable', () => {
  const sorted = [play('cur', 'skipped', true), play('u', 'new', undefined)];
  assert.equal(nextPlayable(sorted, 'cur').videoId, 'u');
});

test('nextPlayable returns null at the end of the list', () => {
  const sorted = [play('a', 'new', true), play('cur', 'new', true)];
  assert.equal(nextPlayable(sorted, 'cur'), null);
  // ...and null when nothing after current is eligible
  const sorted2 = [play('cur', 'new', true), play('w', 'skipped', true)];
  assert.equal(nextPlayable(sorted2, 'cur'), null);
});

test('nextPlayable handles a current id not present (searches from the start)', () => {
  const sorted = [play('a', 'skipped', true), play('b', 'new', true)];
  assert.equal(nextPlayable(sorted, 'ZZZ').videoId, 'b'); // graceful: first eligible
  assert.equal(nextPlayable([], 'ZZZ'), null); // empty list -> null
});

// --- firstPlayable: the player's "Start the queue" target (same rule, from the head) ---

test('firstPlayable returns the OLDEST still-new, embeddable record', () => {
  const sorted = [
    play('s1', 'skipped', true), // skip (handled)
    play('ne', 'new', false), // skip (non-embeddable)
    play('ok', 'new', true), // <- first eligible
    play('ok2', 'new', true),
  ];
  assert.equal(firstPlayable(sorted).videoId, 'ok');
  // embeddable === undefined counts as playable, like nextPlayable
  assert.equal(firstPlayable([play('u', 'new', undefined)]).videoId, 'u');
});

test('firstPlayable returns null when nothing is playable', () => {
  assert.equal(firstPlayable([]), null); // empty queue
  assert.equal(firstPlayable([play('a', 'skipped', true)]), null); // all handled
  assert.equal(firstPlayable([play('a', 'new', false)]), null); // all non-embeddable
  assert.equal(firstPlayable(null), null); // defensive: not an array
});

test('firstPlayable ignores a malformed record and does not mutate the list', () => {
  const sorted = [null, { videoId: null, state: 'skipped' }, play('ok', 'new', true)];
  const snapshot = sorted.slice();
  assert.equal(firstPlayable(sorted).videoId, 'ok');
  assert.deepEqual(sorted, snapshot);
});

// --- resumeStart: where to resume playback ---

test('resumeStart resumes from a mid-video position', () => {
  assert.equal(resumeStart(100, 600), 100);
  assert.equal(resumeStart(6, 600), 6); // just over the min threshold
  assert.equal(resumeStart(100.9, 600), 100); // floored
});

test('resumeStart returns 0 near the start, near the end, past the end, or missing', () => {
  assert.equal(resumeStart(5, 600), 0); // == min threshold -> not worth it
  assert.equal(resumeStart(3, 600), 0); // near start
  assert.equal(resumeStart(590, 600), 0); // within 15s of the end
  assert.equal(resumeStart(700, 600), 0); // past the duration
  assert.equal(resumeStart(undefined, 600), 0); // missing position
  assert.equal(resumeStart(0, 600), 0);
  assert.equal(resumeStart(NaN, 600), 0);
});

test('resumeStart resumes when duration is unknown (only the min threshold applies)', () => {
  assert.equal(resumeStart(100, undefined), 100);
  assert.equal(resumeStart(3, undefined), 0);
});

// --- effectiveSpeed: preferred > default > current, with preset validation ---

test('effectiveSpeed: a valid preferredSpeed always wins', () => {
  assert.equal(effectiveSpeed(2, 1.5, 1), 2); // preferred beats default + current
  assert.equal(effectiveSpeed(1.5, 2, 2), 1.5);
  assert.equal(effectiveSpeed(1, 2, 1.5), 1);
  assert.equal(effectiveSpeed(2, null, 1), 2); // preferred wins with no default
});

test('effectiveSpeed: falls back to a valid default when there is no preferred', () => {
  assert.equal(effectiveSpeed(undefined, 2, 1), 2); // no preferred -> default
  assert.equal(effectiveSpeed(null, 1.5, 1), 1.5);
  assert.equal(effectiveSpeed(3, 2, 1), 2); // invalid preferred -> default
  assert.equal(effectiveSpeed('2', 1.5, 1), 1.5); // wrong-type preferred -> default
});

test('effectiveSpeed: retains currentSpeed when neither preferred nor default is valid', () => {
  assert.equal(effectiveSpeed(undefined, null, 1.5), 1.5); // both unset -> current
  assert.equal(effectiveSpeed(null, undefined, 2), 2);
  assert.equal(effectiveSpeed(3, 0, 1), 1); // both invalid presets -> current
  assert.equal(effectiveSpeed('2', '1.5', 2), 2); // wrong types -> current
});

// --- incrementalSince: cheap lower bound for "Refresh new" ---

const HOUR = 60 * 60 * 1000;

test('incrementalSince returns the floor when there are no dated records', () => {
  const floor = '2026-01-01T00:00:00.000Z';
  assert.equal(incrementalSince([], floor, 6 * HOUR), floor);
  assert.equal(incrementalSince(undefined, floor, 6 * HOUR), floor);
  // Records present but none carry a parseable publishedAt -> still the floor.
  assert.equal(incrementalSince([{ videoId: 'x' }], floor, 6 * HOUR), floor);
});

test('incrementalSince uses the NEWEST publishedAt minus the buffer', () => {
  const floor = '2026-01-01T00:00:00.000Z';
  const recs = [
    { videoId: 'a', publishedAt: '2026-06-10T00:00:00.000Z' },
    { videoId: 'b', publishedAt: '2026-06-12T12:00:00.000Z' }, // newest
    { videoId: 'c', publishedAt: '2026-06-11T00:00:00.000Z' },
  ];
  // newest (Jun 12 12:00) minus 6h = Jun 12 06:00.
  assert.equal(incrementalSince(recs, floor, 6 * HOUR), '2026-06-12T06:00:00.000Z');
});

test('incrementalSince clamps to the floor when the buffer would dip below it', () => {
  const floor = '2026-06-12T09:00:00.000Z';
  const recs = [{ videoId: 'a', publishedAt: '2026-06-12T12:00:00.000Z' }];
  // newest minus 6h = 06:00, which is < floor (09:00) -> clamp to floor.
  assert.equal(incrementalSince(recs, floor, 6 * HOUR), floor);
});

test('incrementalSince is always >= floor', () => {
  const floor = '2026-06-12T00:00:00.000Z';
  const recs = [{ videoId: 'a', publishedAt: '2026-06-12T03:00:00.000Z' }];
  const bound = incrementalSince(recs, floor, 6 * HOUR); // 3h - 6h would be < floor
  assert.ok(compareIso(bound, floor) >= 0);
  assert.equal(bound, floor);
});

// --- channel helpers: sorting + per-channel prefs (channels page / fetch) ---

test('sortChannels sorts alphabetically case-insensitively and flattens entries', () => {
  const channels = {
    UCb: { title: 'apple', avatarUrl: 'a' },
    UCa: { title: 'Banana', avatarUrl: 'b' },
    UCc: { title: 'cherry', avatarUrl: '' },
  };
  const sorted = sortChannels(channels);
  // A naive codepoint sort would put 'Banana' (B) before 'apple' (a).
  assert.deepEqual(sorted.map((c) => c.title), ['apple', 'Banana', 'cherry']);
  assert.deepEqual(sorted[0], { channelId: 'UCb', title: 'apple', avatarUrl: 'a' });
});

test('sortChannels tolerates missing fields / empty maps; ties break by channelId', () => {
  assert.deepEqual(sortChannels({}), []);
  assert.deepEqual(sortChannels(undefined), []);
  const sorted = sortChannels({ UCy: { title: 'Same' }, UCx: { title: 'same' } });
  assert.deepEqual(sorted.map((c) => c.channelId), ['UCx', 'UCy']); // tie-break
  assert.equal(sortChannels({ UCz: {} })[0].avatarUrl, ''); // missing -> ''
});

test('isChannelIgnored is true only for ignored: true', () => {
  const prefs = { UCa: { ignored: true }, UCb: { speed: 2 } };
  assert.equal(isChannelIgnored(prefs, 'UCa'), true);
  assert.equal(isChannelIgnored(prefs, 'UCb'), false);
  assert.equal(isChannelIgnored(prefs, 'UCz'), false); // unknown channel
  assert.equal(isChannelIgnored(null, 'UCa'), false); // no prefs at all
});

test('channelPreferredSpeed returns a valid preset speed, else undefined', () => {
  const prefs = { UCa: { speed: 2 }, UCb: { ignored: true }, UCc: { speed: 3 } };
  assert.equal(channelPreferredSpeed(prefs, 'UCa'), 2);
  assert.equal(channelPreferredSpeed(prefs, 'UCb'), undefined); // no speed set
  assert.equal(channelPreferredSpeed(prefs, 'UCc'), undefined); // invalid preset
  assert.equal(channelPreferredSpeed(prefs, 'UCz'), undefined); // unknown channel
  assert.equal(channelPreferredSpeed(undefined, 'UCa'), undefined);
});

test('setChannelPref stores only non-default values and drops empty entries', () => {
  let prefs = {};
  prefs = setChannelPref(prefs, 'UCa', { ignored: true });
  assert.deepEqual(prefs, { UCa: { ignored: true } });
  prefs = setChannelPref(prefs, 'UCa', { speed: 2 });
  assert.deepEqual(prefs, { UCa: { ignored: true, speed: 2 } });
  prefs = setChannelPref(prefs, 'UCa', { ignored: false }); // un-ignore -> key removed
  assert.deepEqual(prefs, { UCa: { speed: 2 } });
  prefs = setChannelPref(prefs, 'UCa', { speed: undefined }); // toggle speed off
  assert.deepEqual(prefs, {}); // empty per-channel object dropped
});

test('setChannelPref rejects invalid speeds and never mutates its input', () => {
  const orig = { UCa: { speed: 2 } };
  assert.deepEqual(setChannelPref(orig, 'UCa', { speed: 3 }), {}); // invalid -> removed
  assert.deepEqual(orig, { UCa: { speed: 2 } }); // input untouched
  assert.deepEqual(setChannelPref(orig, 'UCb', { ignored: true }), {
    UCa: { speed: 2 },
    UCb: { ignored: true },
  });
});

test('setChannelPref treats a non-object stored value as empty, so it drops cleanly', () => {
  // A string would otherwise spread its characters into index keys and the
  // never-empty entry could never be dropped.
  assert.deepEqual(setChannelPref({ UCa: 'garbage' }, 'UCa', { ignored: false }), {});
  assert.deepEqual(setChannelPref({ UCa: ['x'] }, 'UCa', { speed: undefined }), {});
  assert.deepEqual(setChannelPref({ UCa: null }, 'UCa', { ignored: false }), {});
  assert.deepEqual(setChannelPref({ UCa: 'garbage' }, 'UCa', { speed: 2 }), {
    UCa: { speed: 2 },
  });
});

// --- channel display info: the two per-page resolution policies ---

// One map for every case below: a channel with both fields, one whose avatar is
// blank, and one that is simply absent ('UCgone').
const CHMAP = {
  UCa: { title: 'Channel A', avatarUrl: 'https://img/a.png' },
  UCblank: { title: 'Channel Blank', avatarUrl: '' },
};

test('subscriptionChannelInfo: map hit gives the map avatar', () => {
  const info = subscriptionChannelInfo({ channelId: 'UCa', channelTitle: 'Channel A' }, CHMAP);
  assert.deepEqual(info, { title: 'Channel A', avatarUrl: 'https://img/a.png' });
});

test('subscriptionChannelInfo: map miss gives no avatar at all', () => {
  const info = subscriptionChannelInfo({ channelId: 'UCgone', channelTitle: 'Gone' }, CHMAP);
  assert.deepEqual(info, { title: 'Gone', avatarUrl: '' }); // title still from the record
});

test('subscriptionChannelInfo: an entry with a blank avatarUrl is a miss', () => {
  const info = subscriptionChannelInfo(
    { channelId: 'UCblank', channelTitle: 'Channel Blank' },
    CHMAP
  );
  assert.equal(info.avatarUrl, ''); // '' means placeholder, exactly like no entry
});

test('subscriptionChannelInfo IGNORES a record-carried channelAvatarUrl', () => {
  // THE distinction between the two policies. A subscription record never
  // carries one, and if a stray one appeared it must not win: the map is the
  // authority on this page, so it self-heals on the next refresh.
  const withNoEntry = subscriptionChannelInfo(
    { channelId: 'UCgone', channelTitle: 'Gone', channelAvatarUrl: 'https://img/rec.png' },
    CHMAP
  );
  assert.equal(withNoEntry.avatarUrl, ''); // record avatar ignored -> placeholder
  const withEntry = subscriptionChannelInfo(
    { channelId: 'UCa', channelTitle: 'Channel A', channelAvatarUrl: 'https://img/rec.png' },
    CHMAP
  );
  assert.equal(withEntry.avatarUrl, 'https://img/a.png'); // the MAP wins
});

test('subscriptionChannelInfo: title falls back from the record to the map', () => {
  assert.equal(subscriptionChannelInfo({ channelId: 'UCa' }, CHMAP).title, 'Channel A');
  assert.equal(subscriptionChannelInfo({ channelId: 'UCa', channelTitle: '' }, CHMAP).title, 'Channel A');
  // A record title always wins over the map one.
  assert.equal(
    subscriptionChannelInfo({ channelId: 'UCa', channelTitle: 'Renamed' }, CHMAP).title,
    'Renamed'
  );
  // Nothing anywhere -> '' (buildAvatar then draws the '?' placeholder).
  assert.deepEqual(subscriptionChannelInfo({ channelId: 'UCgone' }, CHMAP), {
    title: '',
    avatarUrl: '',
  });
});

test('stashChannelInfo: the record avatar wins, with NO map entry', () => {
  const info = stashChannelInfo(
    { channelId: 'UCgone', channelTitle: 'Gone', channelAvatarUrl: 'https://img/rec.png' },
    CHMAP
  );
  assert.deepEqual(info, { title: 'Gone', avatarUrl: 'https://img/rec.png' });
});

test('stashChannelInfo: the record avatar wins over a DIFFERENT map avatar', () => {
  const info = stashChannelInfo(
    { channelId: 'UCa', channelTitle: 'Channel A', channelAvatarUrl: 'https://img/rec.png' },
    CHMAP
  );
  assert.equal(info.avatarUrl, 'https://img/rec.png'); // never the map's a.png
});

test('stashChannelInfo: the map is the load-bearing FALLBACK, not dead code', () => {
  // Records stashed before avatars were captured, and ones whose avatar fetch
  // failed, carry nothing of their own and must still show a picture.
  const info = stashChannelInfo({ channelId: 'UCa', channelTitle: 'Channel A' }, CHMAP);
  assert.equal(info.avatarUrl, 'https://img/a.png');
  // A null/empty own-avatar is treated the same as an absent one.
  assert.equal(
    stashChannelInfo({ channelId: 'UCa', channelAvatarUrl: null }, CHMAP).avatarUrl,
    'https://img/a.png'
  );
  assert.equal(
    stashChannelInfo({ channelId: 'UCa', channelAvatarUrl: '' }, CHMAP).avatarUrl,
    'https://img/a.png'
  );
});

test('stashChannelInfo: no avatar anywhere resolves to the empty string', () => {
  assert.deepEqual(stashChannelInfo({ channelId: 'UCgone', channelTitle: 'Gone' }, CHMAP), {
    title: 'Gone',
    avatarUrl: '',
  });
  assert.equal(stashChannelInfo({ channelId: 'UCblank' }, CHMAP).avatarUrl, '');
});

test('stashChannelInfo: title falls back from the record to the map', () => {
  assert.equal(stashChannelInfo({ channelId: 'UCa' }, CHMAP).title, 'Channel A');
  assert.equal(
    stashChannelInfo({ channelId: 'UCa', channelTitle: 'Renamed' }, CHMAP).title,
    'Renamed'
  );
});

test('both resolvers: a missing or empty channelId consults no map entry', () => {
  for (const rec of [{}, { channelId: undefined }, { channelId: null }]) {
    assert.deepEqual(subscriptionChannelInfo(rec, CHMAP), { title: '', avatarUrl: '' });
    assert.deepEqual(stashChannelInfo(rec, CHMAP), { title: '', avatarUrl: '' });
  }
  // A record's OWN avatar does not depend on the channelId, so the stash still
  // shows it; the map-only policy still has nothing to show.
  const orphan = { channelTitle: 'No Id', channelAvatarUrl: 'https://img/rec.png' };
  assert.deepEqual(stashChannelInfo(orphan, CHMAP), { title: 'No Id', avatarUrl: 'https://img/rec.png' });
  assert.deepEqual(subscriptionChannelInfo(orphan, CHMAP), { title: 'No Id', avatarUrl: '' });
});

test('both resolvers tolerate a missing, non-object or malformed channels map', () => {
  const rec = { channelId: 'UCa', channelTitle: 'Channel A' };
  for (const bad of [undefined, null, 0, 'nope', [], [{ title: 'x' }], { UCa: null }, { UCa: 'x' }]) {
    assert.deepEqual(subscriptionChannelInfo(rec, bad), { title: 'Channel A', avatarUrl: '' });
    assert.deepEqual(stashChannelInfo(rec, bad), { title: 'Channel A', avatarUrl: '' });
  }
  // A missing record is tolerated the same way (the player meta clears with null).
  for (const r of [null, undefined]) {
    assert.deepEqual(subscriptionChannelInfo(r, CHMAP), { title: '', avatarUrl: '' });
    assert.deepEqual(stashChannelInfo(r, CHMAP), { title: '', avatarUrl: '' });
  }
});

test('both resolvers mutate neither the record nor the map', () => {
  const rec = { channelId: 'UCa', channelTitle: 'Channel A' };
  const before = JSON.stringify({ rec, CHMAP });
  subscriptionChannelInfo(rec, CHMAP);
  stashChannelInfo(rec, CHMAP);
  assert.equal(JSON.stringify({ rec, CHMAP }), before);
});

// --- pruneChannels: drop unsubscribed channels once their videos have drained ---

const CHANNELS = {
  UCkeep: { title: 'Still subscribed', avatarUrl: 'k.jpg' },
  UCgone: { title: 'Unsubscribed, drained', avatarUrl: 'g.jpg' },
  UCdrain: { title: 'Unsubscribed, still queued', avatarUrl: 'd.jpg' },
};
const SUBS = [{ channelId: 'UCkeep', channelTitle: 'Still subscribed' }];
const VIDS = [{ ...rec('v', T1, 'new'), channelId: 'UCdrain' }];

test('pruneChannels drops an unsubscribed channel with no stored videos', () => {
  const out = pruneChannels(CHANNELS, {}, SUBS, VIDS);
  assert.deepEqual(out.removed, ['UCgone']); // unsubscribed AND drained
  assert.deepEqual(Object.keys(out.channels).sort(), ['UCdrain', 'UCkeep']);
  assert.equal(out.channels.UCkeep.avatarUrl, 'k.jpg'); // surviving entries intact
});

test('pruneChannels keeps an unsubscribed channel that still has videos', () => {
  const out = pruneChannels(CHANNELS, {}, SUBS, VIDS);
  assert.equal(out.channels.UCdrain.title, 'Unsubscribed, still queued'); // cards need it
  assert.equal(out.removed.includes('UCdrain'), false);
  // Once that last video drains, the SAME channel prunes on a later refresh.
  assert.deepEqual(pruneChannels(CHANNELS, {}, SUBS, []).removed.sort(), [
    'UCdrain',
    'UCgone',
  ]);
});

test('pruneChannels keeps a subscribed channel that has no videos', () => {
  const out = pruneChannels({ UCkeep: { title: 'Still subscribed' } }, {}, SUBS, []);
  assert.deepEqual(out.removed, []); // subscribed: never pruned
  assert.equal(out.channels.UCkeep.title, 'Still subscribed');
});

test('pruneChannels prunes prefs for exactly the pruned channels, leaving the rest', () => {
  const prefs = {
    UCkeep: { ignored: true },
    UCgone: { speed: 2 },
    UCdrain: { ignored: true, speed: 1.5 },
    UCorphan: { speed: 1 }, // no channels entry, unsubscribed, drained: swept too
  };
  const out = pruneChannels(CHANNELS, prefs, SUBS, VIDS);
  assert.deepEqual(out.removed, ['UCgone', 'UCorphan']); // channels keys, then prefs-only
  assert.deepEqual(out.prefs, {
    UCkeep: { ignored: true },
    UCdrain: { ignored: true, speed: 1.5 }, // channel kept -> prefs kept
  });
});

test('pruneChannels sweeps an ORPHAN prefs entry that has no channels entry', () => {
  // Hand-edited storage, or prefs written before pruning existed: judged by the
  // same two conditions instead of lingering forever.
  const prefs = { UCorphan: { speed: 2 } };
  const out = pruneChannels(CHANNELS, prefs, SUBS, VIDS);
  assert.deepEqual(out.removed, ['UCgone', 'UCorphan']); // a prefs-only id is a candidate
  assert.deepEqual(out.prefs, {}); // the orphan is gone
});

test('pruneChannels keeps an orphan prefs entry whose channel is still subscribed', () => {
  const prefs = { UCkeep: { speed: 2 } }; // no channels entry, but still subscribed
  const out = pruneChannels({}, prefs, SUBS, VIDS);
  assert.deepEqual(out.removed, []);
  assert.equal(out.prefs, prefs); // identity: nothing to write
});

test('pruneChannels keeps an orphan prefs entry whose channel still has videos', () => {
  const prefs = { UCdrain: { speed: 1.5 } }; // unsubscribed, but VIDS still holds one
  const out = pruneChannels({}, prefs, SUBS, VIDS);
  assert.deepEqual(out.removed, []);
  assert.equal(out.prefs, prefs); // identity: nothing to write
  // Once that video drains, the SAME orphan prunes on a later refresh.
  assert.deepEqual(pruneChannels({}, prefs, SUBS, []).removed, ['UCdrain']);
});

test('pruneChannels returns the channels by identity when only a prefs orphan went', () => {
  const channels = { UCkeep: { title: 'Still subscribed' } };
  const prefs = { UCorphan: { speed: 2 } };
  const out = pruneChannels(channels, prefs, SUBS, VIDS);
  assert.equal(out.channels, channels); // untouched map -> caller skips saveChannels
  assert.notEqual(out.prefs, prefs); // prefs DID change: a fresh object
  assert.deepEqual(out.removed, ['UCorphan']);
});

test('pruneChannels lists an id present in BOTH maps exactly once in removed', () => {
  const prefs = { UCgone: { speed: 2 } }; // also a channels key
  const out = pruneChannels(CHANNELS, prefs, SUBS, VIDS);
  assert.deepEqual(out.removed, ['UCgone']); // the union is deduped
  assert.equal(out.removed.filter((id) => id === 'UCgone').length, 1);
  assert.equal(out.channels.UCgone, undefined); // dropped from both maps
  assert.deepEqual(out.prefs, {});
});

test('pruneChannels returns the prefs by identity when only channels changed', () => {
  const prefs = { UCkeep: { ignored: true } };
  const out = pruneChannels(CHANNELS, prefs, SUBS, VIDS);
  assert.equal(out.prefs, prefs); // no prefs entry pruned -> caller can skip that write
  assert.notEqual(out.channels, CHANNELS); // channels did change
});

test('pruneChannels prunes NOTHING when the subs list is empty or not an array', () => {
  // An empty subscriptions list is a failed/suspect fetch, not "unsubscribed
  // from everything" — the whole channel map would otherwise be wiped.
  // [{ noChannelId: 1 }] is the all-malformed-subs early return: same treatment.
  const prefs = { UCgone: { speed: 2 } };
  for (const subs of [[], null, undefined, 'UCkeep', {}, [{ noChannelId: 1 }]]) {
    const out = pruneChannels(CHANNELS, prefs, subs, []);
    assert.deepEqual(out.removed, []);
    assert.equal(out.channels, CHANNELS); // original identities, nothing to write
    assert.equal(out.prefs, prefs); // both maps, not just the channel one
    assert.deepEqual(Object.keys(out.channels).sort(), ['UCdrain', 'UCgone', 'UCkeep']);
    // The early returns hand back the RAW arguments too — never an invented {}.
    const raw = pruneChannels(null, undefined, subs, []);
    assert.strictEqual(raw.channels, null); // not normalized to {}
    assert.strictEqual(raw.prefs, undefined); // and undefined stays undefined
  }
});

test('pruneChannels returns the original identities when nothing is pruned', () => {
  const channels = { UCkeep: { title: 'Still subscribed' } };
  const prefs = { UCkeep: { speed: 2 } };
  const out = pruneChannels(channels, prefs, SUBS, VIDS);
  assert.equal(out.channels, channels); // same object: caller skips saveChannels
  assert.equal(out.prefs, prefs); // same object: caller skips saveChannelPrefs
  assert.deepEqual(out.removed, []);
});

test('pruneChannels never mutates its inputs', () => {
  const channels = { ...CHANNELS };
  const prefs = { UCgone: { speed: 2 }, UCkeep: { ignored: true } };
  const records = VIDS.slice();
  const subs = SUBS.slice();
  pruneChannels(channels, prefs, subs, records);
  assert.deepEqual(Object.keys(channels).sort(), ['UCdrain', 'UCgone', 'UCkeep']);
  assert.deepEqual(prefs, { UCgone: { speed: 2 }, UCkeep: { ignored: true } });
  assert.equal(records.length, 1); // record set untouched
  assert.equal(subs.length, 1);
});

test('pruneChannels tolerates malformed entries and missing maps', () => {
  const subs = [null, { channelId: '' }, { channelTitle: 'no id' }, ...SUBS];
  const records = [null, { videoId: 'x' }, ...VIDS]; // null / channel-less records
  const out = pruneChannels(CHANNELS, null, subs, records);
  assert.deepEqual(out.removed, ['UCgone']); // malformed entries just ignored
  assert.strictEqual(out.prefs, null); // a real prune, but nothing pruned from prefs
  assert.notEqual(out.channels, CHANNELS); // channels DID change: a fresh object
  assert.deepEqual(Object.keys(out.channels).sort(), ['UCdrain', 'UCkeep']);
});

test('pruneChannels hands malformed or absent maps straight back by identity', () => {
  // It prunes; it does not normalize on the caller's behalf. A caller trusting
  // the result must never end up writing a '{}' this helper invented.
  const arrChannels = [];
  const arrPrefs = [];
  for (const [channels, prefs] of [
    [null, null],
    [undefined, undefined],
    [arrChannels, arrPrefs], // array-shaped: read as empty, returned as given
  ]) {
    const out = pruneChannels(channels, prefs, SUBS, VIDS);
    assert.strictEqual(out.channels, channels); // identity, not a fresh {}
    assert.strictEqual(out.prefs, prefs); // identity, not a fresh {}
    assert.deepEqual(out.removed, []); // neither map -> no candidates to prune
  }
});

// --- preferredSpeed: an explicitly-set per-video speed always survives a refresh ---

test('upsertVideos never overwrites or clears an explicitly-set preferredSpeed', () => {
  const existing = [
    { ...rec('a', T1, 'new'), preferredSpeed: 1 },
    { ...rec('b', T2, 'skipped'), preferredSpeed: 2 },
  ];
  const incoming = [
    { ...rec('a', T1, undefined), preferredSpeed: 2 }, // speed on incoming
    rec('b', T2, undefined), // no speed on incoming
    { ...rec('c', T3, undefined), preferredSpeed: 2 }, // genuinely new record
  ];
  const byId = new Map(upsertVideos(existing, incoming).map((r) => [r.videoId, r]));
  assert.equal(byId.get('a').preferredSpeed, 1); // incoming speed ignored
  assert.equal(byId.get('b').preferredSpeed, 2); // stored speed not cleared
  assert.equal(byId.get('c').preferredSpeed, 2); // new record keeps the preset
  assert.equal(byId.get('b').state, 'skipped'); // and state stays preserved
});

test('applyChannelSpeeds fills the channel speed only where a video has none', () => {
  const prefs = { UCa: { speed: 2 }, UCi: { ignored: true, speed: 2 } };
  const records = [
    { ...rec('a', T1, 'new'), channelId: 'UCa' }, // no speed -> filled
    { ...rec('b', T2, 'skipped'), channelId: 'UCa', preferredSpeed: 1 }, // explicit -> kept
    { ...rec('c', T3, 'new'), channelId: 'UCn' }, // channel has no speed pref
    { ...rec('d', T4, 'new'), channelId: 'UCi' }, // ignored channel -> untouched
    { ...rec('e', T4, 'new'), channelId: 'UCa', preferredSpeed: null }, // legacy null -> filled
  ];
  const byId = new Map(applyChannelSpeeds(records, prefs).map((r) => [r.videoId, r]));
  assert.equal(byId.get('a').preferredSpeed, 2);
  assert.equal(byId.get('b').preferredSpeed, 1);
  assert.equal(byId.get('c').preferredSpeed, undefined);
  assert.equal(byId.get('d').preferredSpeed, undefined);
  assert.equal(byId.get('e').preferredSpeed, 2); // null counts as "unset"
  assert.equal(byId.get('b').state, 'skipped'); // fill is state-agnostic
});

test('applyChannelSpeeds limits the fill to onlyVideoIds when given', () => {
  const prefs = { UCa: { speed: 2 } };
  const records = [
    { ...rec('a', T1, 'new'), channelId: 'UCa' },
    { ...rec('b', T2, 'new'), channelId: 'UCa' },
  ];
  const set = new Map(applyChannelSpeeds(records, prefs, new Set(['b'])).map((r) => [r.videoId, r]));
  assert.equal(set.get('a').preferredSpeed, undefined); // out of scope
  assert.equal(set.get('b').preferredSpeed, 2);
  const arr = new Map(applyChannelSpeeds(records, prefs, ['a']).map((r) => [r.videoId, r]));
  assert.equal(arr.get('a').preferredSpeed, 2); // an array works too
  assert.equal(arr.get('b').preferredSpeed, undefined);
  const none = applyChannelSpeeds(records, prefs, []); // empty scope -> nothing filled
  assert.equal(none[0].preferredSpeed, undefined);
  assert.equal(none[1].preferredSpeed, undefined);
  assert.equal(applyChannelSpeeds(records, prefs, null)[0].preferredSpeed, 2); // null = all
});

test('applyChannelSpeeds never mutates its input and tolerates garbage prefs', () => {
  const records = [{ ...rec('a', T1, 'new'), channelId: 'UCa' }];
  assert.equal(applyChannelSpeeds(records, { UCa: { speed: 1.5 } })[0].preferredSpeed, 1.5);
  assert.equal(records[0].preferredSpeed, undefined); // input untouched
  assert.equal(applyChannelSpeeds(records, null)[0], records[0]); // no prefs -> passthrough
  assert.equal(applyChannelSpeeds(records, { UCa: { speed: 3 } })[0], records[0]); // invalid preset
  assert.equal(applyChannelSpeeds(records, { UCa: null })[0], records[0]); // hand-edited junk
  assert.equal(applyChannelSpeeds(records, { UCa: 'x' })[0], records[0]);
  assert.deepEqual(applyChannelSpeeds(undefined, { UCa: { speed: 2 } }), []);
});

// --- mergeRefresh: the real refresh composition (upsert, then fill-if-absent) ---

// Index the merged array by videoId so the assertions read like the store does.
const merged = (existing, incoming, prefs, options) =>
  new Map(mergeRefresh(existing, incoming, prefs, options).map((r) => [r.videoId, r]));

test('mergeRefresh: a brand-new video arrives carrying its channel speed', () => {
  const prefs = { UCa: { speed: 2 } };
  const incoming = [{ ...rec('a', T1, undefined), channelId: 'UCa' }];
  // The fill runs AFTER the upsert, so brand-new arrivals are in scope either way.
  assert.equal(merged([], incoming, prefs, { sweepSpeeds: false }).get('a').preferredSpeed, 2);
  assert.equal(merged([], incoming, prefs, { sweepSpeeds: true }).get('a').preferredSpeed, 2);
});

const REFRESH_EXISTING = [
  { ...rec('old', T1, 'new'), channelId: 'UCa' }, // stored, speed-less, not re-fetched
  { ...rec('buf', T2, 'skipped'), channelId: 'UCa' }, // re-returned inside the buffer window
  { ...rec('own', T3, 'new'), channelId: 'UCa', preferredSpeed: 1 }, // explicit per-video speed
  { ...rec('ign', T4, 'new'), channelId: 'UCi' }, // ignored channel
];
const REFRESH_INCOMING = [
  { ...rec('buf', T2, undefined), channelId: 'UCa' },
  { ...rec('own', T3, undefined), channelId: 'UCa' },
  { ...rec('fresh', T4, undefined), channelId: 'UCa' },
];
const REFRESH_PREFS = { UCa: { speed: 2 }, UCi: { ignored: true, speed: 2 } };

test('mergeRefresh: "Fetch new" speeds only the newly-inserted records', () => {
  const byId = merged(REFRESH_EXISTING, REFRESH_INCOMING, REFRESH_PREFS, {
    sweepSpeeds: false,
  });
  assert.equal(byId.get('fresh').preferredSpeed, 2); // newly inserted
  assert.equal(byId.get('buf').preferredSpeed, undefined); // re-returned in the buffer: untouched
  assert.equal(byId.get('old').preferredSpeed, undefined); // older queue: untouched
  assert.equal(byId.get('own').preferredSpeed, 1); // explicit speed never overwritten
  assert.equal(byId.get('ign').preferredSpeed, undefined); // ignored channel excluded
  assert.equal(byId.get('buf').state, 'skipped'); // upsert preserved the state
});

test('mergeRefresh: "Refresh all" speeds every stored record that has none', () => {
  const byId = merged(REFRESH_EXISTING, REFRESH_INCOMING, REFRESH_PREFS, {
    sweepSpeeds: true,
  });
  assert.equal(byId.get('fresh').preferredSpeed, 2);
  assert.equal(byId.get('buf').preferredSpeed, 2);
  assert.equal(byId.get('old').preferredSpeed, 2); // swept even though not re-fetched
  assert.equal(byId.get('own').preferredSpeed, 1); // explicit speed still wins
  assert.equal(byId.get('ign').preferredSpeed, undefined); // ignored channel still excluded
});

test('mergeRefresh: omitted options / {} default to the "Fetch new" scope', () => {
  const bare = new Map(
    mergeRefresh(REFRESH_EXISTING, REFRESH_INCOMING, REFRESH_PREFS).map((r) => [r.videoId, r])
  );
  assert.equal(bare.get('old').preferredSpeed, undefined); // not swept
  assert.equal(bare.get('fresh').preferredSpeed, 2);
  const empty = merged(REFRESH_EXISTING, REFRESH_INCOMING, REFRESH_PREFS, {});
  assert.equal(empty.get('old').preferredSpeed, undefined);
  assert.equal(empty.get('fresh').preferredSpeed, 2);
});

test('mergeRefresh never mutates its inputs', () => {
  const existing = [{ ...rec('old', T1, 'new'), channelId: 'UCa' }];
  const incoming = [{ ...rec('fresh', T2, undefined), channelId: 'UCa' }];
  mergeRefresh(existing, incoming, { UCa: { speed: 2 } }, { sweepSpeeds: true });
  assert.equal(existing.length, 1);
  assert.equal(existing[0].preferredSpeed, undefined);
  assert.equal(incoming[0].preferredSpeed, undefined);
  assert.equal(incoming[0].state, undefined); // the 'new' default lands on the copy only
});

// --- parseDescription: linkify timestamps + urls, exact round-trip ---

// Helper: the concatenated segment text must equal the original input.
const roundTrips = (input) =>
  parseDescription(input).map((s) => s.text).join('') === input;

test('parseDescription parses a YouTube-style chapter list with newlines', () => {
  const input = '0:00 Intro\n1:23 Topic A\n1:02:03 Topic B';
  const segs = parseDescription(input);
  assert.ok(roundTrips(input));
  const stamps = segs.filter((s) => s.type === 'timestamp');
  assert.deepEqual(
    stamps.map((s) => [s.text, s.seconds]),
    [['0:00', 0], ['1:23', 83], ['1:02:03', 3723]],
  );
  // Non-timestamp runs preserve the labels + newlines.
  const texts = segs.filter((s) => s.type === 'text').map((s) => s.text);
  assert.deepEqual(texts, [' Intro\n', ' Topic A\n', ' Topic B']);
});

test('parseDescription handles a bare M:SS and an H:MM:SS', () => {
  const a = parseDescription('4:13');
  assert.deepEqual(a, [{ type: 'timestamp', text: '4:13', seconds: 253 }]);
  const b = parseDescription('2:03:04');
  assert.deepEqual(b, [{ type: 'timestamp', text: '2:03:04', seconds: 7384 }]);
});

test('parseDescription does NOT treat glued/out-of-range digits as timestamps', () => {
  for (const input of ['3:999', '1234:56', '192:168', '1:60', 'v1:23x']) {
    const segs = parseDescription(input);
    assert.ok(roundTrips(input), `round-trip ${input}`);
    assert.equal(
      segs.filter((s) => s.type === 'timestamp').length,
      0,
      `no timestamp in "${input}"`,
    );
  }
});

test('parseDescription strips trailing punctuation off a url, leaving it in text', () => {
  const input = 'see https://example.com/x. thanks';
  const segs = parseDescription(input);
  assert.ok(roundTrips(input));
  assert.deepEqual(segs, [
    { type: 'text', text: 'see ' },
    { type: 'url', text: 'https://example.com/x', url: 'https://example.com/x' },
    { type: 'text', text: '. thanks' },
  ]);
});

test('parseDescription mixes text, timestamp and url in one string', () => {
  const input = 'watch at 1:30 then visit http://foo.bar/a) ok';
  const segs = parseDescription(input);
  assert.ok(roundTrips(input));
  assert.deepEqual(segs, [
    { type: 'text', text: 'watch at ' },
    { type: 'timestamp', text: '1:30', seconds: 90 },
    { type: 'text', text: ' then visit ' },
    { type: 'url', text: 'http://foo.bar/a', url: 'http://foo.bar/a' },
    { type: 'text', text: ') ok' },
  ]);
});

test('parseDescription returns [] for empty / whitespace-only input', () => {
  assert.deepEqual(parseDescription(''), []);
  assert.deepEqual(parseDescription('   \n\t '), []);
});

// --- parseVideoId: pull an 11-char id out of a pasted link (regex, not URL) ---

const ID = 'dQw4w9WgXcQ'; // a canonical 11-char id
const ODD_ID = 'a_B-c1D2e3F'; // mixed case plus the two non-alphanumeric id chars

test('parseVideoId reads a standard watch URL', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
});

test('parseVideoId accepts http://, protocol-less and //-prefixed forms', () => {
  assert.equal(parseVideoId(`http://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`www.youtube.com/watch?v=${ID}`), ID); // no protocol at all
  assert.equal(parseVideoId(`youtube.com/watch?v=${ID}`), ID); // no protocol, no subdomain
  assert.equal(parseVideoId(`//www.youtube.com/watch?v=${ID}`), ID); // protocol-relative
});

test('parseVideoId accepts the m. / music. subdomains and youtube-nocookie.com', () => {
  assert.equal(parseVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoId(`https://www.youtube-nocookie.com/embed/${ID}`), ID);
  assert.equal(parseVideoId(`https://youtube-nocookie.com/watch?v=${ID}`), ID);
});

test('parseVideoId finds v= wherever it sits among the query params', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}&list=PLxyz&index=2`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/watch?list=PLxyz&v=${ID}`), ID); // not first
  assert.equal(parseVideoId(`https://www.youtube.com/watch?a=1&b=2&v=${ID}&t=90s`), ID);
});

test('parseVideoId reads youtu.be links, with or without a ?t= / ?si= suffix', () => {
  assert.equal(parseVideoId(`https://youtu.be/${ID}`), ID);
  assert.equal(parseVideoId(`youtu.be/${ID}`), ID);
  assert.equal(parseVideoId(`https://youtu.be/${ID}?t=42`), ID);
  assert.equal(parseVideoId(`https://youtu.be/${ID}?si=AbCdEfGhIjKl`), ID);
});

test('parseVideoId reads /shorts/, /embed/, /live/ and /v/ paths', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/live/${ID}`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/v/${ID}`), ID);
});

test('parseVideoId accepts a trailing slash after the id', () => {
  assert.equal(parseVideoId(`https://youtu.be/${ID}/`), ID);
  assert.equal(parseVideoId(`https://www.youtube.com/shorts/${ID}/`), ID);
});

test('parseVideoId accepts a bare 11-char id', () => {
  assert.equal(parseVideoId(ID), ID);
  assert.equal(parseVideoId(ODD_ID), ODD_ID);
});

test('parseVideoId trims surrounding whitespace and newlines', () => {
  // Pastes routinely carry a trailing newline.
  assert.equal(parseVideoId(`\n  https://youtu.be/${ID}  \n`), ID);
  assert.equal(parseVideoId(`\t${ID}\n`), ID);
});

test('parseVideoId preserves the id case and its _ / - characters', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ODD_ID}`), ODD_ID);
  assert.equal(parseVideoId(`https://youtu.be/${ODD_ID}`), ODD_ID);
});

test('parseVideoId matches the host case-insensitively without touching the id case', () => {
  assert.equal(parseVideoId(`HTTPS://WWW.YOUTUBE.COM/watch?v=${ODD_ID}`), ODD_ID);
  assert.equal(parseVideoId(`HTTPS://YOUTU.BE/${ODD_ID}`), ODD_ID);
});

test('parseVideoId returns null for empty, whitespace or non-string input', () => {
  assert.equal(parseVideoId(''), null);
  assert.equal(parseVideoId('   \n\t '), null);
  assert.equal(parseVideoId(null), null);
  assert.equal(parseVideoId(undefined), null);
  assert.equal(parseVideoId(12345678901), null); // a number, not a string
  assert.equal(parseVideoId({ v: ID }), null);
});

test('parseVideoId returns null for a 10- or 12-char id (never truncates)', () => {
  const short = ID.slice(0, 10); // 10 chars
  const long = `${ID}Z`; // 12 chars
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${short}`), null);
  assert.equal(parseVideoId(`https://youtu.be/${short}`), null);
  // The trailing lookahead makes an over-long run a rejection, not a silent
  // truncation to the first 11 characters.
  assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${long}`), null);
  assert.equal(parseVideoId(long), null);
  assert.equal(parseVideoId(short), null);
});

test('parseVideoId returns null for channel, playlist, results and bare-host URLs', () => {
  assert.equal(parseVideoId('https://www.youtube.com/@somehandle'), null);
  assert.equal(parseVideoId('https://www.youtube.com/playlist?list=PLxyz'), null);
  assert.equal(parseVideoId('https://www.youtube.com/results?search_query=cats'), null);
  assert.equal(parseVideoId('https://www.youtube.com/'), null);
  assert.equal(parseVideoId('youtube.com'), null);
});

test('parseVideoId returns null for lookalike and non-YouTube hosts', () => {
  // Every pattern is ^-anchored, so neither a prefix nor a suffix lookalike matches.
  assert.equal(parseVideoId(`https://evil-youtube.com/watch?v=${ID}`), null);
  assert.equal(parseVideoId(`https://youtube.com.evil.tld/watch?v=${ID}`), null);
  assert.equal(parseVideoId(`https://myoutube.com/watch?v=${ID}`), null);
  assert.equal(parseVideoId(`https://notyoutu.be/${ID}`), null);
  assert.equal(parseVideoId(`https://vimeo.com/watch?v=${ID}`), null);
  assert.equal(parseVideoId(`https://example.com/shorts/${ID}`), null);
});

test('parseVideoId returns null for ?vi= and for free text', () => {
  assert.equal(parseVideoId(`https://www.youtube.com/watch?vi=${ID}`), null); // not the v param
  assert.equal(parseVideoId(`https://www.youtube.com/watch?a=1&vi=${ID}`), null);
  assert.equal(parseVideoId('just some text about a video'), null);
  assert.equal(parseVideoId('watch this: it is great'), null);
});

// --- sortStash: the stash's ONLY order — oldest addedAt first, unstamped last ---

const A1 = '2026-05-01T10:00:00.000Z';
const A2 = '2026-05-02T10:00:00.000Z';
const A3 = '2026-05-03T10:00:00.000Z';

test('sortStash orders by addedAt ascending, ignoring publishedAt', () => {
  // publishedAt runs the OTHER way: the stash is hand-curated, so arrival order
  // is the user's order and publishedAt must not get a vote.
  const recs = [
    { ...stashRec('b', A2, 'new'), publishedAt: '2026-01-02T00:00:00Z' },
    { ...stashRec('c', A3, 'new'), publishedAt: '2026-01-01T00:00:00Z' }, // oldest video, added last
    { ...stashRec('a', A1, 'new'), publishedAt: '2026-01-03T00:00:00Z' }, // newest video, added first
  ];
  assert.deepEqual(sortStash(recs).map((r) => r.videoId), ['a', 'b', 'c']);
});

test('sortStash returns a new array and does not mutate the input', () => {
  const recs = [stashRec('b', A2, 'new'), stashRec('a', A1, 'new')];
  const out = sortStash(recs);
  assert.notEqual(out, recs);
  assert.deepEqual(recs.map((r) => r.videoId), ['b', 'a']); // input order untouched
  assert.deepEqual(out.map((r) => r.videoId), ['a', 'b']);
});

test('sortStash breaks addedAt ties by videoId', () => {
  const recs = [stashRec('z', A1, 'new'), stashRec('a', A1, 'new'), stashRec('m', A1, 'new')];
  assert.deepEqual(sortStash(recs).map((r) => r.videoId), ['a', 'm', 'z']);
});

test('sortStash sorts a record with no addedAt LAST', () => {
  // Every record the app writes is stamped, so an unstamped one is foreign data:
  // the tail is where a mystery row does the least damage.
  const recs = [
    stashRec('none', undefined, 'new'),
    stashRec('b', A2, 'new'),
    stashRec('a', A1, 'new'),
  ];
  assert.deepEqual(sortStash(recs).map((r) => r.videoId), ['a', 'b', 'none']);
});

test('sortStash sorts an UNPARSEABLE addedAt last, not lexically', () => {
  // '0000-...' would sort FIRST under a lexical compare (which is exactly what
  // compareIso falls back to) — hence not delegating to it.
  const recs = [
    stashRec('junk', '0000-not-a-date', 'new'),
    stashRec('b', A2, 'new'),
    stashRec('a', A1, 'new'),
  ];
  assert.deepEqual(sortStash(recs).map((r) => r.videoId), ['a', 'b', 'junk']);
  // Two unstamped records still tie-break by videoId rather than swapping about.
  const both = [stashRec('y', null, 'new'), stashRec('x', 'nonsense', 'new')];
  assert.deepEqual(sortStash(both).map((r) => r.videoId), ['x', 'y']);
});

test('sortStash compares INSTANTS, not strings (+02:00 vs Z)', () => {
  // 12:00+02:00 is 10:00Z — earlier than 11:00Z — but sorts LATER as a string.
  const recs = [
    stashRec('zulu', '2026-03-01T11:00:00Z', 'new'),
    stashRec('offset', '2026-03-01T12:00:00+02:00', 'new'),
  ];
  assert.deepEqual(sortStash(recs).map((r) => r.videoId), ['offset', 'zulu']);
});

test('sortStash returns [] for an empty or non-array input', () => {
  assert.deepEqual(sortStash([]), []);
  assert.deepEqual(sortStash(undefined), []);
  assert.deepEqual(sortStash(null), []);
});

// --- stashToClean: STATE-based deletion set (contrast: videosToClean is positional) ---

test('stashToClean returns every handled record, from ANYWHERE in the list', () => {
  // The contrast with videosToClean: that one is publishedAt <= cutoff, so it can
  // only ever delete a contiguous PREFIX. This one deletes out of the middle.
  const recs = [
    stashRec('a', A1, 'new'),
    stashRec('b', A2, 'skipped'), // middle of the list
    stashRec('c', A3, 'new'),
    stashRec('d', A3, 'skipped'), // and the tail
  ];
  assert.deepEqual(stashToClean(recs).map((r) => r.videoId), ['b', 'd']);
  assert.equal(stashToClean(recs)[0].title, 'b'); // RECORDS, not ids
});

test('stashToClean returns [] when every record is still new', () => {
  const recs = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  assert.deepEqual(stashToClean(recs), []);
});

test('stashToClean returns [] for an empty or non-array input', () => {
  assert.deepEqual(stashToClean([]), []);
  assert.deepEqual(stashToClean(undefined), []);
  assert.deepEqual(stashToClean(null), []);
});

test('stashToClean ignores publishedAt entirely — there is no cutoff', () => {
  const recs = [
    { ...stashRec('old', A1, 'new'), publishedAt: '2000-01-01T00:00:00Z' }, // ancient but unmarked
    { ...stashRec('newest', A2, 'skipped'), publishedAt: '2099-01-01T00:00:00Z' }, // future but marked
  ];
  assert.deepEqual(stashToClean(recs).map((r) => r.videoId), ['newest']);
});

test('stashToClean treats ANY non-new state as handled (legacy values included)', () => {
  const recs = [
    stashRec('a', A1, 'new'),
    stashRec('w', A2, 'watched'), // legacy value: handled all the same
    stashRec('n', A3, 'not_interested'),
  ];
  assert.deepEqual(stashToClean(recs).map((r) => r.videoId), ['w', 'n']);
});

test('stashToClean does not mutate its input', () => {
  const recs = [stashRec('a', A1, 'new'), stashRec('b', A2, 'skipped')];
  const out = stashToClean(recs);
  assert.notEqual(out, recs);
  assert.equal(recs.length, 2);
  assert.deepEqual(recs.map((r) => r.state), ['new', 'skipped']);
});

// --- addToStash: the whole "add a pasted video" step, as one pure composition ---

const paste = (videoId, channelId, extra) => ({
  videoId,
  channelId,
  title: videoId,
  channelTitle: 'ch',
  publishedAt: '2026-01-01T00:00:00Z',
  thumbnailUrl: '',
  ...extra,
});

test('addToStash appends the record, stamped new + addedAt', () => {
  const stash = [stashRec('a', A1, 'skipped')];
  const out = addToStash(stash, paste('b', 'UCa'), { addedAt: A2, prefs: {} });
  assert.equal(out.added, true);
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']); // APPENDED
  assert.equal(out.record.state, 'new');
  assert.equal(out.record.addedAt, A2);
  assert.equal(out.record.title, 'b'); // metadata carried over
  assert.equal(out.records[1], out.record); // the returned record is the stored one
});

test('addToStash fills preferredSpeed from the channel pref', () => {
  const out = addToStash([], paste('b', 'UCa'), {
    addedAt: A1,
    prefs: { UCa: { speed: 1.5 } },
  });
  assert.equal(out.record.preferredSpeed, 1.5);
});

test('addToStash fills the speed even when the channel is IGNORED', () => {
  // The stash deliberately ignores the Ignore flag: Ignore governs what gets
  // FETCHED by subscription, and nothing here is fetched by subscription. Hence
  // the leaf channelPreferredSpeed rather than applyChannelSpeeds, which excludes
  // ignored channels by design.
  const out = addToStash([], paste('b', 'UCi'), {
    addedAt: A1,
    prefs: { UCi: { ignored: true, speed: 2 } },
  });
  assert.equal(out.record.preferredSpeed, 2);
});

test('addToStash never overwrites an explicit incoming preferredSpeed', () => {
  const prefs = { UCa: { speed: 2 } };
  const kept = addToStash([], paste('b', 'UCa', { preferredSpeed: 1 }), { addedAt: A1, prefs });
  assert.equal(kept.record.preferredSpeed, 1); // fill-if-ABSENT
  // null counts as unset (legacy shape), exactly like the subscriptions rule.
  const filled = addToStash([], paste('c', 'UCa', { preferredSpeed: null }), { addedAt: A1, prefs });
  assert.equal(filled.record.preferredSpeed, 2);
});

test('addToStash omits preferredSpeed when the channel has no usable pref', () => {
  for (const prefs of [{}, null, undefined, { UCa: { ignored: true } }, { UCa: { speed: 3 } }]) {
    const out = addToStash([], paste('b', 'UCa'), { addedAt: A1, prefs });
    assert.equal(out.record.preferredSpeed, undefined);
    assert.equal('preferredSpeed' in out.record, false); // no key at all, not an undefined one
  }
  // Missing options object entirely: still stamps, still no speed.
  assert.equal(addToStash([], paste('b', 'UCa')).record.state, 'new');
});

test('addToStash reports added:false, changed:false and the array BY IDENTITY on a no-op duplicate', () => {
  // Already there, unmarked, and the incoming record has no speed to impose:
  // there is nothing left for this add to do.
  const stash = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const out = addToStash(stash, paste('b', 'UCa'), { addedAt: A3, prefs: { UCa: { speed: 2 } } });
  assert.equal(out.added, false);
  assert.equal(out.changed, false);
  assert.strictEqual(out.records, stash); // same object: the caller can skip its write
  assert.equal(out.records.length, 2); // no duplicate row
  assert.strictEqual(out.record, stash[1]); // the stored record, not the pasted one
  // The channel pref above is deliberately NOT applied: a duplicate went through
  // the fill when it was first stashed and takes an EXPLICIT incoming speed only.
  assert.equal(out.record.preferredSpeed, undefined);
});

test('addToStash does not refresh a duplicate metadata from the incoming copy', () => {
  const stash = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const out = addToStash(stash, paste('b', 'UCa', { title: 'renamed' }), { addedAt: A3 });
  assert.equal(out.record.title, 'b'); // not refreshed from the paste
  assert.equal(out.record.addedAt, A2); // and not re-stamped
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']); // did not jump to the end
});

test('addToStash REVIVES a duplicate that was marked Remove, in place', () => {
  const stash = [stashRec('a', A1, 'new'), stashRec('b', A2, 'skipped'), stashRec('c', A3, 'new')];
  const out = addToStash(stash, paste('b', 'UCa'), { addedAt: '2026-09-09T00:00:00Z' });
  assert.equal(out.added, false); // an update, not an arrival
  assert.equal(out.changed, true); // ... which the caller must persist
  assert.equal(out.record.state, 'new'); // un-marked
  assert.equal(out.record.addedAt, A2); // NOT re-stamped: same place in arrival order
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b', 'c']); // same index
  assert.strictEqual(out.records[1], out.record);
  assert.notStrictEqual(out.records, stash); // a NEW array, with a copy substituted
  assert.equal(stash[1].state, 'skipped'); // the input record is left alone
  assert.strictEqual(out.records[0], stash[0]); // untouched records come back by identity
  assert.strictEqual(out.records[2], stash[2]);
});

test('addToStash lets an incoming preferredSpeed OVERRIDE the stashed one', () => {
  const stash = [{ ...stashRec('b', A2, 'new'), preferredSpeed: 1 }];
  const out = addToStash(stash, paste('b', 'UCa', { preferredSpeed: 2 }), { addedAt: A3 });
  assert.equal(out.changed, true);
  assert.equal(out.record.preferredSpeed, 2);
  assert.equal(out.record.state, 'new'); // was not marked: nothing to revive
  assert.equal(stash[0].preferredSpeed, 1); // the input record is left alone
});

test('addToStash keeps the stashed speed when the incoming record has none', () => {
  // The paste-a-link flow builds its record from getVideosByIds, which carries no
  // speed at all — so there this rule always degrades to "keep what we have".
  const stash = [{ ...stashRec('b', A2, 'new'), preferredSpeed: 1.5 }];
  for (const incoming of [paste('b', 'UCa'), paste('b', 'UCa', { preferredSpeed: null })]) {
    const out = addToStash(stash, incoming, { addedAt: A3, prefs: { UCa: { speed: 2 } } });
    assert.equal(out.changed, false); // nothing to write
    assert.strictEqual(out.records, stash); // ... and the array back by identity
    assert.equal(out.record.preferredSpeed, 1.5);
  }
  // The same incoming speed the record already has is not a change either.
  const same = addToStash(stash, paste('b', 'UCa', { preferredSpeed: 1.5 }), { addedAt: A3 });
  assert.equal(same.changed, false);
  assert.strictEqual(same.records, stash);
});

test('addToStash applies BOTH duplicate rules at once', () => {
  const stash = [stashRec('a', A1, 'new'), { ...stashRec('b', A2, 'skipped'), preferredSpeed: 1 }];
  const out = addToStash(stash, paste('b', 'UCa', { preferredSpeed: 2 }), { addedAt: A3 });
  assert.equal(out.added, false);
  assert.equal(out.changed, true);
  assert.equal(out.record.state, 'new'); // revived
  assert.equal(out.record.preferredSpeed, 2); // and re-speeded
  assert.equal(out.record.addedAt, A2); // still in its place
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']);
});

test('addToStash revives ANY handled state, not just skipped', () => {
  // "handled" means state !== 'new' everywhere, legacy values included.
  for (const legacy of ['skipped', 'watched', 'not_interested']) {
    const out = addToStash([stashRec('b', A2, legacy)], paste('b', 'UCa'), { addedAt: A3 });
    assert.equal(out.changed, true);
    assert.equal(out.record.state, 'new');
  }
});

test('addToStash reports changed:true on an ADD, so one flag drives the write', () => {
  const out = addToStash([], paste('b', 'UCa'), { addedAt: A1 });
  assert.equal(out.added, true);
  assert.equal(out.changed, true);
});

test('addToStash + sortStash agree: the append order IS the rendered order', () => {
  // The two halves of the real composition: addToStash appends, sortStash sorts
  // by addedAt — so pastes come out in the order they were pasted, whatever
  // their publishedAt says.
  let stash = [];
  for (const [videoId, at] of [['first', A1], ['second', A2], ['third', A3]]) {
    stash = addToStash(stash, paste(videoId, 'UCa'), { addedAt: at }).records;
  }
  assert.deepEqual(sortStash(stash).map((r) => r.videoId), ['first', 'second', 'third']);
  // Re-pasting an old link does NOT move it to the end.
  stash = addToStash(stash, paste('first', 'UCa'), { addedAt: '2026-09-09T00:00:00Z' }).records;
  assert.deepEqual(sortStash(stash).map((r) => r.videoId), ['first', 'second', 'third']);
});

test('addToStash mutates neither input', () => {
  const stash = [stashRec('a', A1, 'new')];
  const incoming = paste('b', 'UCa');
  const out = addToStash(stash, incoming, { addedAt: A2, prefs: { UCa: { speed: 2 } } });
  assert.equal(stash.length, 1); // the stash array is untouched
  assert.notEqual(out.records, stash);
  assert.equal(incoming.state, undefined); // the stamp lands on the copy only
  assert.equal(incoming.addedAt, undefined);
  assert.equal(incoming.preferredSpeed, undefined);
});

// --- reconcileStash: cross-tab merge — membership from `fresh`, CONTENT local ---

test('reconcileStash ADDS a record the other tab inserted', () => {
  const current = [stashRec('a', A1, 'new')];
  const fresh = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const out = reconcileStash(current, fresh);
  assert.equal(out.changed, true);
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']);
  assert.strictEqual(out.records[0], current[0]); // the one we already had, by identity
  assert.strictEqual(out.records[1], fresh[1]); // the arrival, by identity
});

test('reconcileStash REMOVES a record the other tab swept', () => {
  const current = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const fresh = [stashRec('b', A2, 'new')];
  const out = reconcileStash(current, fresh);
  assert.equal(out.changed, true);
  assert.deepEqual(out.records.map((r) => r.videoId), ['b']);
  assert.strictEqual(out.records[0], current[1]);
});

test('reconcileStash handles an ADD and a REMOVE in the same signal', () => {
  const current = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const fresh = [stashRec('b', A2, 'new'), stashRec('c', A3, 'new')];
  const out = reconcileStash(current, fresh);
  assert.equal(out.changed, true); // equal LENGTHS, but the membership moved
  assert.deepEqual(out.records.map((r) => r.videoId), ['b', 'c']);
  assert.strictEqual(out.records[0], current[1]);
});

test('reconcileStash NEVER takes `fresh` for a record we have a write IN FLIGHT for', () => {
  // THE rule this function exists for: the stash page marks OPTIMISTICALLY —
  // rec.state is set in memory before the write is awaited — so a signal landing
  // inside that window must not resurrect the pre-mark state from disk.
  const marked = stashRec('a', A1, 'skipped'); // marked here, not yet persisted
  const onDisk = stashRec('a', A1, 'new'); // what IndexedDB still says
  onDisk.title = 'stale title';
  onDisk.preferredSpeed = 2;
  const out = reconcileStash([marked], [onDisk], new Set(['a']));
  assert.equal(out.changed, false); // we kept ours: nothing new to draw
  assert.strictEqual(out.records[0], marked); // same object, not a merge of the two
  assert.equal(out.records[0].state, 'skipped'); // the mark survives
  assert.equal(out.records[0].title, 'a');
  assert.equal(out.records[0].preferredSpeed, undefined);
});

test('reconcileStash TAKES fresh content for a record we are NOT writing', () => {
  // The other tab updates existing records now (re-adding a stashed video
  // un-marks it), so anything not in flight has to be free to change here.
  const local = stashRec('a', A1, 'skipped'); // marked, and already persisted
  const onDisk = stashRec('a', A1, 'new'); // the other tab revived it
  const out = reconcileStash([local], [onDisk], new Set(['b'])); // 'b' in flight, not 'a'
  assert.equal(out.changed, true); // ... and a remote un-mark MUST re-render
  assert.strictEqual(out.records[0], onDisk);
  assert.equal(out.records[0].state, 'new');
  // No in-flight argument at all behaves the same way — nothing is protected.
  assert.equal(reconcileStash([local], [onDisk]).changed, true);
  assert.equal(reconcileStash([local], [onDisk], null).records[0].state, 'new');
});

test('reconcileStash counts a CONTENT difference as changed, field by field', () => {
  const base = stashRec('a', A1, 'new');
  const differs = [
    { ...base, preferredSpeed: 2 }, // a remote re-speed
    { ...base, positionSeconds: 30 }, // any other field, too
    { ...base, title: 'renamed' },
  ];
  for (const onDisk of differs) {
    const out = reconcileStash([base], [onDisk]);
    assert.equal(out.changed, true);
    assert.strictEqual(out.records[0], onDisk);
  }
  // A key PRESENT-but-undefined is not the same as an absent one: addToStash
  // omits preferredSpeed rather than writing it undefined, so the two shapes
  // genuinely differ.
  assert.equal(reconcileStash([base], [{ ...base, preferredSpeed: undefined }]).changed, true);
  // An identical copy — a different object with the same fields — is not.
  assert.equal(reconcileStash([base], [{ ...base }]).changed, false);
  assert.strictEqual(reconcileStash([base], [{ ...base }]).records[0], base); // ours kept
});

test('reconcileStash empties the list when `fresh` is empty', () => {
  const current = [stashRec('a', A1, 'new'), stashRec('b', A2, 'skipped')];
  const out = reconcileStash(current, []);
  assert.equal(out.changed, true);
  assert.deepEqual(out.records, []);
  assert.equal(current.length, 2); // input untouched
});

test('reconcileStash is a NO-OP when both sides match', () => {
  const current = [stashRec('a', A1, 'new'), stashRec('b', A2, 'skipped')];
  const fresh = [stashRec('a', A1, 'new'), stashRec('b', A2, 'skipped')];
  const out = reconcileStash(current, fresh);
  assert.equal(out.changed, false); // the caller skips its re-render on this
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']);
  assert.strictEqual(out.records[0], current[0]);
  assert.strictEqual(out.records[1], current[1]);
});

test('reconcileStash does not treat a different ORDER as a change', () => {
  // Order is the caller's business (sortStash), so a re-read that comes back in
  // another order must not cost a render.
  const current = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const fresh = [stashRec('b', A2, 'new'), stashRec('a', A1, 'new')];
  assert.equal(reconcileStash(current, fresh).changed, false);
});

test('reconcileStash leaves ordering to the caller, exactly like addToStash', () => {
  // The arrival is appended where `fresh` had it; sortStash still decides the
  // rendered order, so it stays the stash's single sort site.
  const current = [stashRec('b', A2, 'new')];
  const fresh = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const out = reconcileStash(current, fresh);
  assert.deepEqual(out.records.map((r) => r.videoId), ['a', 'b']);
  assert.deepEqual(sortStash(out.records).map((r) => r.videoId), ['a', 'b']);
});

test('reconcileStash tolerates malformed entries and non-arrays', () => {
  const good = stashRec('a', A1, 'new');
  // Junk on the FRESH side is dropped; junk on OURS is dropped and counts as a
  // change, because the rendered list loses it.
  const out = reconcileStash([good, null, {}], [good, null, { title: 'no id' }]);
  assert.deepEqual(out.records.map((r) => r.videoId), ['a']);
  assert.equal(out.changed, true);
  // A duplicate id in `fresh` is taken once.
  const dupes = reconcileStash([], [stashRec('a', A1, 'new'), stashRec('a', A2, 'new')]);
  assert.deepEqual(dupes.records.map((r) => r.videoId), ['a']);
  assert.equal(dupes.records[0].addedAt, A1); // the first one wins
  // Neither side has to be an array.
  assert.deepEqual(reconcileStash(null, undefined), { records: [], changed: false });
  assert.equal(reconcileStash(undefined, [good]).changed, true);
  assert.deepEqual(reconcileStash([good], null).records, []);
});

test('reconcileStash mutates neither input', () => {
  const current = [stashRec('a', A1, 'skipped')];
  const fresh = [stashRec('a', A1, 'new'), stashRec('b', A2, 'new')];
  const out = reconcileStash(current, fresh);
  assert.equal(current.length, 1);
  assert.equal(current[0].state, 'skipped');
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].state, 'new'); // adopted by reference, never rewritten
  assert.notStrictEqual(out.records, current);
  assert.notStrictEqual(out.records, fresh);
});

console.log(`\n${passed} passed`);
