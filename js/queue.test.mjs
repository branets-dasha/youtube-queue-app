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
  nearestSurvivor,
  paneCandidates,
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
  unmirroredVideoIds,
  reconcileChannel,
  parseVideoId,
  parseStartSeconds,
  sortStash,
  stashToClean,
  addToStash,
  reconcileStash,
  normalizeKey,
  sortTime,
  isUnaired,
  needsDetails,
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

// --- nearestSurvivor: the user's place, carried across a filtering re-render ---

const ORDER = ['a', 'b', 'c', 'd', 'e'];

test('nearestSurvivor keeps the anchor when it survived', () => {
  assert.equal(nearestSurvivor(ORDER, 'c', ['a', 'c', 'e']), 'c');
});

test('nearestSurvivor prefers the first survivor AFTER a vanished anchor', () => {
  // 'b' and 'c' both went; 'd' is forward, 'a' is back — forward wins.
  assert.equal(nearestSurvivor(ORDER, 'b', ['a', 'd', 'e']), 'd');
});

test('nearestSurvivor falls BACK when nothing after the anchor survived', () => {
  assert.equal(nearestSurvivor(ORDER, 'd', ['a', 'b']), 'b');
});

test('nearestSurvivor returns null when nothing survived at all', () => {
  assert.equal(nearestSurvivor(ORDER, 'c', []), null);
});

test('nearestSurvivor has NO opinion without a usable anchor', () => {
  assert.equal(nearestSurvivor(ORDER, null, ORDER), null);
  assert.equal(nearestSurvivor(ORDER, undefined, ORDER), null);
  assert.equal(nearestSurvivor(ORDER, '', ORDER), null);
  // An anchor absent from the order it is supposed to index into.
  assert.equal(nearestSurvivor(ORDER, 'zz', ORDER), null);
});

test('nearestSurvivor accepts a Set or an array of survivors alike', () => {
  assert.equal(nearestSurvivor(ORDER, 'b', new Set(['a', 'd'])), 'd');
  assert.equal(nearestSurvivor(ORDER, 'b', ['a', 'd']), 'd');
});

test('nearestSurvivor tolerates non-array input and mutates neither argument', () => {
  assert.equal(nearestSurvivor(undefined, 'a', ['a']), null);
  assert.equal(nearestSurvivor(ORDER, 'a', undefined), null);
  const order = ['a', 'b', 'c'];
  const alive = new Set(['c']);
  nearestSurvivor(order, 'a', alive);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual([...alive], ['c']);
});

// --- paneCandidates: the order the pane cycle is tried in ---

test('paneCandidates walks forward from the middle, wrapping past the end', () => {
  assert.deepEqual(paneCandidates(5, 2, 1), [3, 4, 0, 1]);
});

test('paneCandidates walks backward from the middle, wrapping past the start', () => {
  assert.deepEqual(paneCandidates(5, 2, -1), [1, 0, 4, 3]);
});

test('paneCandidates wraps at BOTH ends rather than clamping', () => {
  // From the last pane forward, and from the first backward: the far end is the
  // very first candidate, which is the whole difference from the card walk.
  assert.deepEqual(paneCandidates(5, 4, 1), [0, 1, 2, 3]);
  assert.deepEqual(paneCandidates(5, 0, -1), [4, 3, 2, 1]);
});

// --- normalizeKey: the shortcut a key means, whatever the layout ---

test('normalizeKey passes a latin press straight through', () => {
  assert.equal(normalizeKey({ key: 'x', code: 'KeyX' }), 'x');
  assert.equal(normalizeKey({ key: '1', code: 'Digit1' }), '1');
  assert.equal(normalizeKey({ key: '/', code: 'Slash' }), '/');
  // Uppercase (Shift, or caps lock) still resolves to the bound character.
  assert.equal(normalizeKey({ key: 'X', code: 'KeyX' }), 'x');
});

test('normalizeKey rescues a Cyrillic layout through the physical position', () => {
  // The whole point: a Cyrillic layout produces no latin letter at all, so
  // without the fallback every letter shortcut dies on switching input.
  assert.equal(normalizeKey({ key: 'ч', code: 'KeyX' }), 'x');
  assert.equal(normalizeKey({ key: 'е', code: 'KeyT' }), 't');
  assert.equal(normalizeKey({ key: 'з', code: 'KeyP' }), 'p');
  assert.equal(normalizeKey({ key: 'д', code: 'KeyL' }), 'l');
  // Its brackets carry letters, and its Slash position carries a full stop.
  assert.equal(normalizeKey({ key: 'х', code: 'BracketLeft' }), '[');
  assert.equal(normalizeKey({ key: 'ъ', code: 'BracketRight' }), ']');
  assert.equal(normalizeKey({ key: '.', code: 'Slash' }), '/');
});

test('normalizeKey rescues the AZERTY digit row, where the presets are shifted', () => {
  assert.equal(normalizeKey({ key: '&', code: 'Digit1' }), '1');
  assert.equal(normalizeKey({ key: '(', code: 'Digit5' }), '5');
  assert.equal(normalizeKey({ key: 'é', code: 'Digit2' }), '2');
});

test('normalizeKey lets the PRINTED character win over the physical position', () => {
  // German QWERTZ puts '-' on the Slash position. Both are bound, and what the
  // keycap says wins — the user gets the speed cycle, not the pane toggle. This
  // precedence is what keeps Dvorak/AZERTY/QWERTZ on their own printed letters.
  assert.equal(normalizeKey({ key: '-', code: 'Slash' }), '-');
  // Dvorak prints 'l' where QWERTY sits 'p': the printed letter wins again.
  assert.equal(normalizeKey({ key: 'l', code: 'KeyP' }), 'l');
});

test('normalizeKey binds the player-frame key by cap first, position second', () => {
  // US, UK and Cyrillic caps all print '\' somewhere and produce it.
  assert.equal(normalizeKey({ key: '\\', code: 'Backslash' }), '\\');
  assert.equal(normalizeKey({ key: '\\', code: 'IntlBackslash' }), '\\');
  // German QWERTZ has '\' only under AltGr (a modifier combo the tables ignore)
  // and prints '#' on the Backslash position, so the position is the way in.
  assert.equal(normalizeKey({ key: '#', code: 'Backslash' }), '\\');
  // A printed shortcut on that position still wins, as everywhere else.
  assert.equal(normalizeKey({ key: '/', code: 'Backslash' }), '/');
});

test('normalizeKey leaves every unbound key untouched', () => {
  // Non-character keys report the same e.key on every layout, so they must never
  // be routed through the fallback — their codes carry no character at all.
  assert.equal(normalizeKey({ key: 'Escape', code: 'Escape' }), 'escape');
  assert.equal(normalizeKey({ key: 'ArrowUp', code: 'ArrowUp' }), 'arrowup');
  assert.equal(normalizeKey({ key: 'PageDown', code: 'PageDown' }), 'pagedown');
  assert.equal(normalizeKey({ key: 'Home', code: 'Home' }), 'home');
  assert.equal(normalizeKey({ key: 'Enter', code: 'Enter' }), 'enter');
  assert.equal(normalizeKey({ key: ' ', code: 'Space' }), ' ');
  // An unbound character key keeps what the layout produced, physical position
  // or not — 'й' must not become the (unbound) 'q' it sits on.
  assert.equal(normalizeKey({ key: 'й', code: 'KeyQ' }), 'й');
  assert.equal(normalizeKey({ key: 'a', code: 'KeyA' }), 'a');
});

test('normalizeKey survives a missing or empty code', () => {
  // Some virtual keyboards report no code; the fallback simply cannot fire, and
  // the produced character stands, exactly as it does today.
  assert.equal(normalizeKey({ key: 'x' }), 'x');
  assert.equal(normalizeKey({ key: 'ч', code: '' }), 'ч');
  assert.equal(normalizeKey({ key: 'ч', code: 'Unidentified' }), 'ч');
  assert.equal(normalizeKey({}), '');
  assert.equal(normalizeKey(null), '');
});

test('paneCandidates never offers the origin, so a cycle of one is empty', () => {
  assert.deepEqual(paneCandidates(1, 0, 1), []);
  assert.deepEqual(paneCandidates(1, 0, -1), []);
  // Every other pane exactly once, whichever way and wherever from.
  for (const from of [0, 1, 2, 3, 4]) {
    for (const dir of [1, -1]) {
      const out = paneCandidates(5, from, dir);
      assert.equal(out.length, 4);
      assert.equal(new Set(out).size, 4);
      assert.ok(!out.includes(from));
    }
  }
});

test('paneCandidates reads a nonsense length as an empty cycle', () => {
  assert.deepEqual(paneCandidates(0, 0, 1), []);
  assert.deepEqual(paneCandidates(-3, 0, 1), []);
  assert.deepEqual(paneCandidates(2.5, 0, 1), []);
  assert.deepEqual(paneCandidates(undefined, 0, 1), []);
});

test('paneCandidates wraps an out-of-cycle origin into it', () => {
  // Both are index 2 of 5 — a stale lastPane index cannot produce a bad index.
  assert.deepEqual(paneCandidates(5, 7, 1), paneCandidates(5, 2, 1));
  assert.deepEqual(paneCandidates(5, -3, 1), paneCandidates(5, 2, 1));
  // A non-integer origin reads as 0 rather than throwing.
  assert.deepEqual(paneCandidates(3, undefined, 1), [1, 2]);
});

test('paneCandidates treats any dir <= -1 as backward and everything else as forward', () => {
  // The pages only ever pass -1 / +1; 0 must still pick a direction, not stall.
  assert.deepEqual(paneCandidates(3, 0, 0), [1, 2]);
  assert.deepEqual(paneCandidates(3, 0, -2), [2, 1]);
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

// --- unmirroredVideoIds: "Refresh all" drops the channels it does not mirror ---

const MIXED = [
  { ...rec('k1', T1, 'new'), channelId: 'UCkeep' },
  { ...rec('g1', T2, 'new'), channelId: 'UCgone' },
  { ...rec('g2', T3, 'skipped'), channelId: 'UCgone' }, // handled: goes all the same
  { ...rec('k2', T4, 'skipped'), channelId: 'UCkeep' },
];

test('unmirroredVideoIds selects every record of an unsubscribed channel, whatever its state', () => {
  assert.deepEqual(unmirroredVideoIds(MIXED, SUBS, {}), ['g1', 'g2']); // record order
  assert.deepEqual(unmirroredVideoIds(MIXED, SUBS, null), ['g1', 'g2']); // no prefs at all
});

test('unmirroredVideoIds selects an IGNORED channel too, and only for Ignore', () => {
  // Ignore is "stop fetching, and the backlog goes on the next Refresh all".
  const subs = [...SUBS, { channelId: 'UCgone' }]; // everything subscribed
  assert.deepEqual(unmirroredVideoIds(MIXED, subs, {}), []);
  assert.deepEqual(unmirroredVideoIds(MIXED, subs, { UCkeep: { ignored: true } }), ['k1', 'k2']);
  assert.deepEqual(unmirroredVideoIds(MIXED, subs, { UCkeep: { speed: 2 } }), []); // a speed is not Ignore
  // Unsubscribed and ignored together: the union, still in record order.
  assert.deepEqual(unmirroredVideoIds(MIXED, SUBS, { UCkeep: { ignored: true } }), [
    'k1',
    'g1',
    'g2',
    'k2',
  ]);
});

test('unmirroredVideoIds hands pruneChannels a record set it can drop the channel from', () => {
  // The pair: the videos go first, then an UNSUBSCRIBED channel (now drained)
  // prunes in the same pass. An ignored one is still in `subs`, so it keeps its
  // entry and its Ignore — that entry is how the user un-ignores it.
  const prefs = { UCkeep: { ignored: true } };
  const gone = new Set(unmirroredVideoIds(MIXED, SUBS, prefs));
  const left = MIXED.filter((r) => !gone.has(r.videoId));
  assert.deepEqual(left, []);
  const pruned = pruneChannels(CHANNELS, prefs, SUBS, left);
  assert.deepEqual(pruned.removed.sort(), ['UCdrain', 'UCgone']);
  assert.strictEqual(pruned.channels.UCkeep, CHANNELS.UCkeep); // ignored, subscribed: stays
  assert.strictEqual(pruned.prefs, prefs); // and so does its Ignore
  assert.equal(pruneChannels(CHANNELS, {}, SUBS, MIXED).removed.includes('UCgone'), false);
});

test('unmirroredVideoIds selects NOTHING when the subs list is empty or not an array', () => {
  // The whole queue would otherwise be wiped by a failed subscriptions fetch —
  // the same guard, and the same all-malformed case, as pruneChannels. Ignore
  // does not override it: with no subs there is no run to sweep for.
  for (const subs of [[], null, undefined, 'UCkeep', {}, [{ noChannelId: 1 }], [null]]) {
    assert.deepEqual(unmirroredVideoIds(MIXED, subs, { UCkeep: { ignored: true } }), []);
  }
});

test('unmirroredVideoIds skips a record with no channelId (it cannot be known unmirrored)', () => {
  const records = [
    null,
    { videoId: 'orphan' },
    { videoId: 'blank', channelId: '' },
    { channelId: 'UCgone' }, // no videoId: nothing to delete by
    ...MIXED,
  ];
  assert.deepEqual(unmirroredVideoIds(records, SUBS, {}), ['g1', 'g2']);
  assert.deepEqual(unmirroredVideoIds(null, SUBS, {}), []);
  assert.deepEqual(unmirroredVideoIds([], SUBS, {}), []);
});

test('unmirroredVideoIds never mutates its inputs', () => {
  const records = MIXED.map((r) => ({ ...r }));
  const subs = [null, { channelId: '' }, ...SUBS];
  const prefs = { UCkeep: { ignored: true } };
  const before = JSON.stringify({ records, subs, prefs });
  unmirroredVideoIds(records, subs, prefs);
  assert.equal(JSON.stringify({ records, subs, prefs }), before);
});

// --- preferredSpeed: an explicitly-set per-video speed always survives a refresh ---

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

// --- reconcileChannel: one channel's fetch applied to the stored set ---

const BOUND = T1; // the fetch's exclusive lower bound (the floor, for "Refresh all")
const CHAN = 'UCa';
// A stored record of the channel, and what its fetch hands back (no state).
const full = (videoId, publishedAt, state, extra = {}) => ({
  ...rec(videoId, publishedAt, state),
  channelId: CHAN,
  ...extra,
});
const fetched = (videoId, publishedAt, extra = {}) => {
  const { state, ...r } = full(videoId, publishedAt, undefined, extra);
  return r;
};

const STORED = [
  full('keep', T2, 'skipped', {
    positionSeconds: 30,
    liked: true,
    durationSeconds: 100,
    embeddable: true,
    description: 'd',
    preferredSpeed: 1,
  }), // re-returned, renamed
  full('gone', T3, 'new'), // in the window, NOT re-returned: deleted or hidden upstream
  full('atBound', T1, 'new'), // exactly AT the bound: outside the window
  full('older', '2026-01-01T00:00:00Z', 'new'), // below the bound
  { ...full('other', T4, 'new'), channelId: 'UCother' }, // another channel's
];
const RECEIVED = [
  fetched('keep', T2, { title: 'renamed', channelTitle: 'Ch!', thumbnailUrl: 'k.jpg' }),
  fetched('fresh', T4),
];
// Index the result by videoId so the assertions read like the store does.
const byId = (out) => new Map(out.records.map((r) => [r.videoId, r]));

test('reconcileChannel (Refresh all) removes the in-window records the fetch did not return, and only those', () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND, { removeMissing: true });
  assert.deepEqual(out.removedIds, ['gone']);
  assert.deepEqual(out.insertedIds, ['fresh']);
  assert.deepEqual(
    out.records.map((r) => r.videoId).sort(),
    ['atBound', 'fresh', 'keep', 'older', 'other']
  );
});

test('reconcileChannel keeps the record exactly AT the bound — the fetch excludes it by the same test', () => {
  // The fetch stops at compareIso(publishedAt, cutoff) <= 0; the removal window
  // is publishedAt > bound. One comparator, so a record on the bound can never
  // be "not received" AND "in the window" at once.
  assert.ok(compareIso(T1, BOUND) <= 0);
  const out = reconcileChannel(STORED, CHAN, [], BOUND, { removeMissing: true });
  assert.ok(out.records.some((r) => r.videoId === 'atBound'));
  assert.ok(!out.removedIds.includes('atBound'));
});

test('reconcileChannel hands back other channels and out-of-window records BY IDENTITY', () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND, { removeMissing: true });
  const got = byId(out);
  assert.strictEqual(got.get('other'), STORED[4]); // never this fetch's business
  assert.strictEqual(got.get('older'), STORED[3]);
  assert.strictEqual(got.get('atBound'), STORED[2]);
});

test("reconcileChannel refreshes a match's fetched fields and preserves every locally-owned one", () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND, { removeMissing: true });
  const keep = byId(out).get('keep');
  assert.equal(keep.title, 'renamed');
  assert.equal(keep.channelTitle, 'Ch!');
  assert.equal(keep.thumbnailUrl, 'k.jpg');
  assert.equal(keep.state, 'skipped');
  assert.equal(keep.positionSeconds, 30);
  assert.equal(keep.liked, true);
  assert.equal(keep.durationSeconds, 100);
  assert.equal(keep.embeddable, true);
  assert.equal(keep.description, 'd');
  assert.equal(keep.preferredSpeed, 1);
  assert.notStrictEqual(keep, STORED[0]); // a copy: the stored object is untouched
  assert.equal(STORED[0].title, 'keep');
  // An identical re-return is the same object, not a copy.
  const one = [full('a', T2, 'new')];
  assert.strictEqual(reconcileChannel(one, CHAN, [fetched('a', T2)], BOUND).records[0], one[0]);
});

test('reconcileChannel inserts an unmatched incoming record as new (an explicit state kept)', () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND);
  const fresh = byId(out).get('fresh');
  assert.equal(fresh.state, 'new');
  assert.notStrictEqual(fresh, RECEIVED[1]); // the 'new' lands on a copy
  assert.equal(RECEIVED[1].state, undefined);
  const explicit = reconcileChannel([], CHAN, [{ ...fetched('s', T2), state: 'skipped' }], BOUND);
  assert.equal(explicit.records[0].state, 'skipped');
});

test('reconcileChannel: an EMPTY fetch with removeMissing clears the window — a channel quiet since the floor', () => {
  const out = reconcileChannel(STORED, CHAN, [], BOUND, { removeMissing: true });
  assert.deepEqual(out.removedIds.sort(), ['gone', 'keep']);
  assert.deepEqual(out.records.map((r) => r.videoId).sort(), ['atBound', 'older', 'other']);
  assert.deepEqual(out.changed, []); // nothing to put, only deletes
});

test('reconcileChannel (Fetch new) with removeMissing off deletes nothing', () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND);
  assert.deepEqual(out.removedIds, []);
  assert.equal(out.records.length, STORED.length + 1);
  assert.ok(out.records.some((r) => r.videoId === 'gone'));
  // And an empty incremental fetch changes nothing at all.
  assert.strictEqual(reconcileChannel(STORED, CHAN, [], BOUND).records, STORED);
});

test('reconcileChannel returns the input array by identity, and nothing to write, when nothing differs', () => {
  const stored = [full('a', T2, 'new'), full('b', T3, 'skipped', { positionSeconds: 9 })];
  const out = reconcileChannel(stored, CHAN, [fetched('a', T2), fetched('b', T3)], BOUND, {
    removeMissing: true,
    sweepSpeeds: true,
    prefs: { UCa: { speed: 2 } },
  });
  // (the speed IS filled here — so `records` is new; without a pref it is not)
  assert.notStrictEqual(out.records, stored);
  const bare = reconcileChannel(stored, CHAN, [fetched('a', T2), fetched('b', T3)], BOUND, {
    removeMissing: true,
    sweepSpeeds: true,
  });
  assert.strictEqual(bare.records, stored);
  assert.deepEqual(bare.changed, []);
  assert.deepEqual(bare.removedIds, []);
  assert.deepEqual(bare.insertedIds, []);
});

test('reconcileChannel lists in `changed` exactly the records to write', () => {
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND, { removeMissing: true });
  assert.deepEqual(out.changed.map((r) => r.videoId).sort(), ['fresh', 'keep']);
  const got = byId(out);
  assert.strictEqual(out.changed.find((r) => r.videoId === 'keep'), got.get('keep'));
  assert.strictEqual(out.changed.find((r) => r.videoId === 'fresh'), got.get('fresh'));
});

test('reconcileChannel fills the channel speed on the inserted records ("Fetch new") …', () => {
  const prefs = { UCa: { speed: 2 }, UCother: { speed: 1.5 } };
  const got = byId(reconcileChannel(STORED, CHAN, RECEIVED, BOUND, { prefs }));
  assert.equal(got.get('fresh').preferredSpeed, 2); // inserted
  assert.equal(got.get('keep').preferredSpeed, 1); // explicit per-video speed wins
  assert.equal(got.get('gone').preferredSpeed, undefined); // already stored: untouched
  assert.equal(got.get('atBound').preferredSpeed, undefined);
  assert.equal(got.get('older').preferredSpeed, undefined);
  assert.equal(got.get('other').preferredSpeed, undefined); // another channel: never
});

test("reconcileChannel … and on the channel's WHOLE set with sweepSpeeds (\"Refresh all\")", () => {
  const prefs = { UCa: { speed: 2 }, UCother: { speed: 1.5 } };
  const out = reconcileChannel(STORED, CHAN, RECEIVED, BOUND, {
    removeMissing: true,
    sweepSpeeds: true,
    prefs,
  });
  const got = byId(out);
  assert.equal(got.get('fresh').preferredSpeed, 2);
  assert.equal(got.get('keep').preferredSpeed, 1); // explicit still wins
  assert.equal(got.get('atBound').preferredSpeed, 2); // the channel's, out of the window too
  assert.equal(got.get('older').preferredSpeed, 2);
  assert.equal(got.get('other').preferredSpeed, undefined); // another channel: never
  // The filled records are written too.
  assert.deepEqual(
    out.changed.map((r) => r.videoId).sort(),
    ['atBound', 'fresh', 'keep', 'older']
  );
});

test('reconcileChannel never overwrites or clears an explicitly-set preferredSpeed', () => {
  const existing = [
    full('a', T2, 'new', { preferredSpeed: 1 }),
    full('b', T3, 'skipped', { preferredSpeed: 2 }),
  ];
  const incoming = [
    fetched('a', T2, { preferredSpeed: 2 }), // speed on incoming: not a fetched field
    fetched('b', T3), // no speed on incoming
    fetched('c', T4, { preferredSpeed: 2 }), // genuinely new record
  ];
  const got = byId(
    reconcileChannel(existing, CHAN, incoming, BOUND, {
      removeMissing: true,
      sweepSpeeds: true,
      prefs: { UCa: { speed: 1.5 } },
    })
  );
  assert.equal(got.get('a').preferredSpeed, 1); // incoming speed ignored
  assert.equal(got.get('b').preferredSpeed, 2); // stored speed not cleared
  assert.equal(got.get('c').preferredSpeed, 2); // new record keeps its preset over the channel's
  assert.equal(got.get('b').state, 'skipped'); // and state stays preserved
});

test('reconcileChannel never mutates its inputs and tolerates garbage', () => {
  const stored = STORED.map((r) => ({ ...r }));
  const received = RECEIVED.map((r) => ({ ...r }));
  const before = JSON.stringify({ stored, received });
  reconcileChannel(stored, CHAN, received, BOUND, {
    removeMissing: true,
    sweepSpeeds: true,
    prefs: { UCa: { speed: 2 } },
  });
  assert.equal(JSON.stringify({ stored, received }), before);
  assert.deepEqual(reconcileChannel(undefined, CHAN, undefined, BOUND).records, undefined);
  assert.deepEqual(reconcileChannel(null, CHAN, [fetched('x', T2)], BOUND).records.length, 1);
  assert.deepEqual(reconcileChannel([], CHAN, [null, { title: 'no id' }], BOUND).records, []);
  assert.deepEqual(reconcileChannel([null], CHAN, [], BOUND, { removeMissing: true }).records, [null]);
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

// --- parseStartSeconds: a pasted link's ?t= / &start=, seeding the resume position ---

test('parseStartSeconds reads ?t= and &t= with or without the trailing s', () => {
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=42`), 42);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?v=${ID}&t=42s`), 42);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?t=90&v=${ID}`), 90);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?v=${ID}#t=15`), 15);
  assert.equal(parseStartSeconds(`  https://youtu.be/${ID}?t=7  `), 7); // pastes carry whitespace
});

test('parseStartSeconds finds t= after another parameter, and reads start=', () => {
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?si=AbCdEf&t=120`), 120);
  assert.equal(parseStartSeconds(`https://www.youtube.com/embed/${ID}?start=90`), 90);
  assert.equal(parseStartSeconds(`https://www.youtube.com/embed/${ID}?start=90&end=120`), 90);
});

test('parseStartSeconds returns null when there is no timestamp at all', () => {
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}`), null);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?v=${ID}`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?si=AbCdEf`), null);
  assert.equal(parseStartSeconds(ID), null); // a bare id
  assert.equal(parseStartSeconds(''), null);
});

test('parseStartSeconds returns null for a zero offset', () => {
  // Nothing to seed: resuming at 0 is what an unset position already means.
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=0`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=0s`), null);
});

test('parseStartSeconds returns null for a value that is not whole seconds', () => {
  // A composite is REJECTED, never truncated to its leading digits.
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=1m30s`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=1h2m3s`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=1.5`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=-5`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=abc`), null);
  assert.equal(parseStartSeconds(`https://youtu.be/${ID}?t=`), null);
});

test('parseStartSeconds does not mistake a longer parameter name for t or start', () => {
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?time_continue=100&v=${ID}`), null);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?v=${ID}&start_radio=1`), null);
  assert.equal(parseStartSeconds(`https://www.youtube.com/watch?v=${ID}&list=t=30`), null);
});

test('parseStartSeconds returns null for non-string input', () => {
  assert.equal(parseStartSeconds(null), null);
  assert.equal(parseStartSeconds(undefined), null);
  assert.equal(parseStartSeconds(42), null);
});

test('a link carrying a timestamp still yields its id', () => {
  // The two helpers read the same paste independently; neither disturbs the other.
  const link = `https://www.youtube.com/watch?v=${ID}&t=42s`;
  assert.equal(parseVideoId(link), ID);
  assert.equal(parseStartSeconds(link), 42);
  assert.equal(parseVideoId(`https://youtu.be/${ODD_ID}?t=8`), ODD_ID);
  assert.equal(parseStartSeconds(`https://youtu.be/${ODD_ID}?t=8`), 8);
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

// --- Premieres and live streams: sortTime, isUnaired, needsDetails ---

// A premiere published (announced) at A, airing at C; the queue burnt down to B.
const PA = '2026-03-01T00:00:00Z';
const PB = '2026-03-05T00:00:00Z';
const PC = '2026-03-10T00:00:00Z';
const premiere = (extra = {}) => ({ ...rec('prem', PA, 'new'), scheduledStartTime: PC, ...extra });

test('sortTime is the later of publishedAt and the start time, actual over scheduled', () => {
  assert.equal(sortTime(rec('v', PA, 'new')), PA); // an ordinary upload
  assert.equal(sortTime(premiere()), PC); // unaired: files at the schedule
  assert.equal(sortTime(premiere({ actualStartTime: PB })), PB); // aired: the actual start wins
  // A stream run BEFORE it went public files where it went public, never below it.
  assert.equal(sortTime({ ...rec('v', PC, 'new'), actualStartTime: PA }), PC);
  assert.equal(sortTime(premiere({ scheduledStartTime: 'garbage' })), PA);
});

test('computeVisible sorts an unaired premiere by its air time, past later uploads', () => {
  const list = [premiere(), rec('b', PB, 'new'), rec('a', '2026-03-02T00:00:00Z', 'new')];
  assert.deepEqual(computeVisible(list, null).map((r) => r.videoId), ['a', 'b', 'prem']);
});

test('the cutoff reaches B past a premiere published at A and airing at C, and cleanup keeps it', () => {
  const records = [
    rec('x', '2026-03-02T00:00:00Z', 'skipped'),
    rec('y', PB, 'skipped'),
    premiere(),
  ];
  const cutoff = computeCutoff(records, '2026-02-01T00:00:00Z');
  assert.equal(cutoff, PB);
  assert.deepEqual(videosToClean(records, cutoff).map((r) => r.videoId).sort(), ['x', 'y']);
  assert.deepEqual(computeVisible(records, cutoff).map((r) => r.videoId), ['prem']);
});

test('reconcileChannel (Refresh all) with bound B keeps a stored premiere published at A', () => {
  // The fetch never returns it (publishedAt A <= B), and that is not a deletion.
  const stored = [{ ...premiere(), channelId: CHAN }];
  const out = reconcileChannel(stored, CHAN, [], PB, { removeMissing: true });
  assert.deepEqual(out.removedIds, []);
  assert.strictEqual(out.records, stored);
});

test('incrementalSince ignores a future air time: it bounds by publishedAt', () => {
  const since = incrementalSince([premiere({ scheduledStartTime: '2099-01-01T00:00:00Z' })], null, 0);
  assert.equal(since, new Date(PA).toISOString());
});

test('isUnaired: a future schedule with no actual start, judged against the clock', () => {
  const before = Date.parse(PB);
  const after = Date.parse('2026-03-11T00:00:00Z');
  assert.equal(isUnaired(premiere(), before), true);
  assert.equal(isUnaired(premiere(), after), false); // self-heals once the time passes
  assert.equal(isUnaired(premiere({ actualStartTime: PB }), before), false);
  assert.equal(isUnaired(rec('v', PA, 'new'), before), false);
  assert.equal(isUnaired(null, before), false);
});

test('firstPlayable / nextPlayable skip an unaired video, and only when given the time', () => {
  const now = Date.parse(PB);
  const list = [premiere(), rec('b', PB, 'new')];
  assert.equal(firstPlayable(list, now).videoId, 'b');
  assert.equal(nextPlayable([rec('a', PA, 'new'), premiere()], 'a', now), null);
  assert.equal(firstPlayable(list).videoId, 'prem'); // no clock: no unaired check
  assert.equal(firstPlayable(list, Date.parse('2026-03-11T00:00:00Z')).videoId, 'prem');
});

test('needsDetails: a missing field, no live marker yet, or still upcoming/live', () => {
  const done = { durationSeconds: 60, embeddable: true, description: '', liveBroadcastContent: 'none' };
  assert.equal(needsDetails(done), false);
  assert.equal(needsDetails({ ...done, liveBroadcastContent: undefined }), true); // pre-existing record
  assert.equal(needsDetails({ ...done, liveBroadcastContent: 'upcoming' }), true);
  assert.equal(needsDetails({ ...done, liveBroadcastContent: 'live' }), true);
  assert.equal(needsDetails({ ...done, durationSeconds: undefined }), true);
});

console.log(`\n${passed} passed`);
