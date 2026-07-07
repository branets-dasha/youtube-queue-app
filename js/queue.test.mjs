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
  advanceCutoff,
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

// --- advanceCutoff: prunes only the contiguous handled prefix, stops at 1st new ---

test('advanceCutoff prunes the contiguous handled prefix and stops at first new', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'watched'),
    rec('b', '2026-01-02T00:00:00Z', 'not_interested'),
    rec('c', '2026-01-03T00:00:00Z', 'new'),
    rec('d', '2026-01-04T00:00:00Z', 'watched'),
  ];
  const { newCutoff, prunedIds } = advanceCutoff(recs, '2025-12-31T00:00:00Z');
  assert.equal(newCutoff, '2026-01-02T00:00:00Z'); // advanced across a, b
  assert.deepEqual(prunedIds.sort(), ['a', 'b']); // d NOT pruned (sits after new c)
});

test('advanceCutoff does not advance when the oldest in-window video is new', () => {
  const recs = [
    rec('a', '2026-01-01T00:00:00Z', 'new'),
    rec('b', '2026-01-02T00:00:00Z', 'watched'),
  ];
  const { newCutoff, prunedIds } = advanceCutoff(recs, '2025-12-31T00:00:00Z');
  assert.equal(newCutoff, '2025-12-31T00:00:00Z'); // unchanged
  assert.deepEqual(prunedIds, []); // nothing pruned
});

// --- The coordinator's concrete example, end to end ---

test('reload example: [A watched, B new, C watched, D new] -> only A pruned', () => {
  const recs = [
    rec('A', '2026-02-01T00:00:00Z', 'watched'),
    rec('B', '2026-02-02T00:00:00Z', 'new'),
    rec('C', '2026-02-03T00:00:00Z', 'watched'),
    rec('D', '2026-02-04T00:00:00Z', 'new'),
  ];
  const cutoff = '2026-01-01T00:00:00Z';
  const { newCutoff, prunedIds } = advanceCutoff(recs, cutoff);
  assert.deepEqual(prunedIds, ['A']); // ONLY A deleted
  assert.equal(newCutoff, '2026-02-01T00:00:00Z'); // cutoff moves up to just after A

  const surviving = recs.filter((r) => !prunedIds.includes(r.videoId));
  const visibleIds = computeVisible(surviving, newCutoff).map((r) => r.videoId);
  assert.deepEqual(visibleIds, ['B', 'C', 'D']); // C (watched) remains, greyed in UI
});

// --- tie-safety: a handled record sharing a timestamp with a still-new one ---

test('advanceCutoff never prunes a new video that ties a handled timestamp', () => {
  const recs = [
    rec('h', '2026-03-01T00:00:00Z', 'watched'),
    rec('n', '2026-03-01T00:00:00Z', 'new'), // same second as h, still new
  ];
  const { newCutoff, prunedIds } = advanceCutoff(recs, '2026-02-01T00:00:00Z');
  assert.ok(!prunedIds.includes('n'), 'the still-new video must survive');
  assert.equal(newCutoff, '2026-02-01T00:00:00Z'); // cannot advance onto the tie
});

console.log(`\n${passed} passed`);
