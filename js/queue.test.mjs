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
  compareIso,
  parseIsoDuration,
  formatDuration,
  isShort,
  SHORTS_MAX_SECONDS,
  resumeStart,
  effectiveSpeed,
  incrementalSince,
  parseDescription,
  sortChannels,
  isChannelIgnored,
  channelPreferredSpeed,
  applyChannelSpeeds,
  setChannelPref,
  pruneChannels,
  mergeRefresh,
} from './queue.js';

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

console.log(`\n${passed} passed`);
