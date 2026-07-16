// js/queue.test.mjs
//
// Node unit tests for the PURE queue logic (js/queue.js references no browser
// globals, so it imports directly). Run from the repo root with:
//     node js/queue.test.mjs
// No dependencies beyond Node's built-in assert.

import assert from 'node:assert';
import {
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
  effectiveRate,
  incrementalSince,
  parseDescription,
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

// --- effectiveRate: preferred > default > current, with preset validation ---

test('effectiveRate: a valid preferredRate always wins', () => {
  assert.equal(effectiveRate(2, 1.5, 1), 2); // preferred beats default + current
  assert.equal(effectiveRate(1.5, 2, 2), 1.5);
  assert.equal(effectiveRate(1, 2, 1.5), 1);
  assert.equal(effectiveRate(2, null, 1), 2); // preferred wins with no default
});

test('effectiveRate: falls back to a valid default when there is no preferred', () => {
  assert.equal(effectiveRate(undefined, 2, 1), 2); // no preferred -> default
  assert.equal(effectiveRate(null, 1.5, 1), 1.5);
  assert.equal(effectiveRate(3, 2, 1), 2); // invalid preferred -> default
  assert.equal(effectiveRate('2', 1.5, 1), 1.5); // wrong-type preferred -> default
});

test('effectiveRate: retains currentRate when neither preferred nor default is valid', () => {
  assert.equal(effectiveRate(undefined, null, 1.5), 1.5); // both unset -> current
  assert.equal(effectiveRate(null, undefined, 2), 2);
  assert.equal(effectiveRate(3, 0, 1), 1); // both invalid presets -> current
  assert.equal(effectiveRate('2', '1.5', 2), 2); // wrong types -> current
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
