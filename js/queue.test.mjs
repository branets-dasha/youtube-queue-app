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
  nextPlayable,
  compareIso,
  parseIsoDuration,
  formatDuration,
  isShort,
  SHORTS_MAX_SECONDS,
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
    rec('a', '2026-01-01T00:00:00Z', 'watched'),
    rec('c', '2026-01-03T00:00:00Z', 'not_interested'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
  ];
  const ids = computeVisible(recs, '2025-12-31T00:00:00Z').map((r) => r.videoId);
  assert.deepEqual(ids, ['a', 'b', 'c', 'd']); // marked a & c still present, sorted
});

test('computeVisible excludes records at or before the cutoff', () => {
  const recs = [
    rec('old', '2026-01-01T00:00:00Z', 'new'), // strictly before -> out
    rec('eq', '2026-01-02T00:00:00Z', 'new'), // == cutoff -> out
    rec('keep', '2026-01-03T00:00:00Z', 'watched'), // after -> in (even though marked)
  ];
  const ids = computeVisible(recs, '2026-01-02T00:00:00Z').map((r) => r.videoId);
  assert.deepEqual(ids, ['keep']);
});

test('computeVisible with null cutoff returns everything, sorted', () => {
  const recs = [
    rec('b', '2026-01-02T00:00:00Z', 'watched'),
    rec('a', '2026-01-01T00:00:00Z', 'new'),
  ];
  assert.deepEqual(computeVisible(recs, null).map((r) => r.videoId), ['a', 'b']);
});

// --- computeQueue: unchanged 'new'-only subset (drives the "Queued" count) ---

test('computeQueue still returns only still-new videos', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'watched'),
    rec('b', '2026-01-02T00:00:00Z', 'new'),
    rec('c', '2026-01-03T00:00:00Z', 'not_interested'),
  ];
  assert.deepEqual(computeQueue(recs, null).map((r) => r.videoId), ['b']);
});

// --- computeCutoff: contiguous handled-prefix marker, floor-bounded, tie-safe ---

const FLOOR = '2026-01-01T00:00:00Z';
const T1 = '2026-01-02T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const T3 = '2026-01-04T00:00:00Z';
const T4 = '2026-01-05T00:00:00Z';

test('computeCutoff advances over a contiguous handled prefix and stops at first new', () => {
  const recs = [
    rec('a', T1, 'watched'),
    rec('b', T2, 'not_interested'),
    rec('c', T3, 'new'),
    rec('d', T4, 'watched'), // handled but AFTER the first new -> does not count
  ];
  assert.equal(computeCutoff(recs, FLOOR), T2); // stops at c (first new)
});

test('computeCutoff returns floor when the oldest present is new (or no records)', () => {
  assert.equal(
    computeCutoff([rec('a', T1, 'new'), rec('b', T2, 'watched')], FLOOR),
    FLOOR
  );
  assert.equal(computeCutoff([], FLOOR), FLOOR);
});

test('computeCutoff tie-safety: never reaches a new video tying a handled one; result >= floor', () => {
  const T = '2026-02-01T00:00:00Z';
  const recs = [rec('h', T, 'watched'), rec('n', T, 'new')]; // same timestamp
  const c = computeCutoff(recs, FLOOR);
  assert.equal(c, FLOOR); // cannot advance onto the tie
  assert.ok(compareIso(c, T) < 0, 'cutoff must be strictly before the new video');
});

test('cutoff retreats on un-mark and returns on re-mark', () => {
  const A = rec('A', T1, 'watched');
  const B = rec('B', T2, 'watched');
  const C = rec('C', T3, 'new');
  const recs = [A, B, C];
  assert.equal(computeCutoff(recs, FLOOR), T2); // cutoff = B
  A.state = 'new'; // un-mark A (inside the handled prefix)
  assert.equal(computeCutoff(recs, FLOOR), FLOOR); // retreats to floor
  A.state = 'watched'; // re-mark A
  assert.equal(computeCutoff(recs, FLOOR), T2); // back to B
});

// --- videosToClean + cleanup semantics + FLOOR-based visibility ---

test('videosToClean is exactly the <= cutoff set; after cleanup floor=cutoff excludes them', () => {
  const recs = [rec('a', T1, 'watched'), rec('b', T2, 'watched'), rec('c', T3, 'new')];
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
  const recs = [rec('a', T1, 'watched'), rec('b', T2, 'new')];
  // On mark, the render list uses FLOOR (not the cutoff marker), so the watched
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

// --- nextPlayable: auto-advance selection (skips watched/not_interested/non-embeddable) ---

const play = (videoId, state, embeddable) => ({
  videoId,
  state,
  embeddable, // undefined | true | false
  publishedAt: '2026-01-01T00:00:00Z',
  title: videoId,
});

test('nextPlayable skips not_interested, watched, and non-embeddable; returns first eligible new', () => {
  const sorted = [
    play('cur', 'watched', true),
    play('ni', 'not_interested', true), // skip (not_interested)
    play('w', 'watched', true), // skip (watched)
    play('ne', 'new', false), // skip (non-embeddable)
    play('ok', 'new', true), // <- first eligible after cur
    play('ok2', 'new', true),
  ];
  assert.equal(nextPlayable(sorted, 'cur').videoId, 'ok');
});

test('nextPlayable treats embeddable === undefined as playable', () => {
  const sorted = [play('cur', 'watched', true), play('u', 'new', undefined)];
  assert.equal(nextPlayable(sorted, 'cur').videoId, 'u');
});

test('nextPlayable returns null at the end of the list', () => {
  const sorted = [play('a', 'new', true), play('cur', 'new', true)];
  assert.equal(nextPlayable(sorted, 'cur'), null);
  // ...and null when nothing after current is eligible
  const sorted2 = [play('cur', 'new', true), play('w', 'watched', true)];
  assert.equal(nextPlayable(sorted2, 'cur'), null);
});

test('nextPlayable handles a current id not present (searches from the start)', () => {
  const sorted = [play('a', 'watched', true), play('b', 'new', true)];
  assert.equal(nextPlayable(sorted, 'ZZZ').videoId, 'b'); // graceful: first eligible
  assert.equal(nextPlayable([], 'ZZZ'), null); // empty list -> null
});

console.log(`\n${passed} passed`);
