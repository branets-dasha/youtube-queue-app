// js/migrations.test.mjs
//
// Node unit tests for the data migrations (js/migrations.js touches no browser
// globals at module level, so it imports directly; the localStorage tests
// install a stub around themselves). Run from the repo root with:
//     node js/migrations.test.mjs
// No dependencies beyond Node's built-in assert.

import assert from 'node:assert';
import { migrateVideos, migrateChannelPrefs, migrateLocalStorage } from './migrations.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

// --- migrateVideos: legacy preferredRate -> preferredSpeed --------------------

test('migrateVideos fills preferredSpeed from the legacy preferredRate', () => {
  const recs = [{ videoId: 'a', preferredRate: 1.5 }];
  const out = migrateVideos(recs);
  assert.equal(out[0].preferredSpeed, 1.5);
  assert.ok(!('preferredRate' in out[0])); // old name never lingers
});

test('migrateVideos mutates in place and returns the same array', () => {
  const recs = [{ videoId: 'a', preferredRate: 2 }];
  assert.equal(migrateVideos(recs), recs);
  assert.equal(recs[0].preferredSpeed, 2);
});

test('migrateVideos never clobbers an existing preferredSpeed', () => {
  const recs = [{ videoId: 'a', preferredSpeed: 1, preferredRate: 2 }];
  migrateVideos(recs);
  assert.equal(recs[0].preferredSpeed, 1);
  assert.ok(!('preferredRate' in recs[0])); // dropped either way
});

test('migrateVideos treats a preferredSpeed of 0 as SET, not unset', () => {
  const recs = [{ videoId: 'a', preferredSpeed: 0, preferredRate: 2 }];
  migrateVideos(recs);
  assert.equal(recs[0].preferredSpeed, 0); // == null, so 0 counts as set (as in queue.js)
});

test('migrateVideos fills a legacy rate of 0 (0 != null)', () => {
  const recs = [{ videoId: 'a', preferredRate: 0 }];
  migrateVideos(recs);
  assert.equal(recs[0].preferredSpeed, 0);
});

test('migrateVideos leaves records with no speed fields alone', () => {
  const recs = [{ videoId: 'a', state: 'new' }];
  migrateVideos(recs);
  assert.deepEqual(recs[0], { videoId: 'a', state: 'new' });
});

test('migrateVideos is idempotent on a second run', () => {
  const recs = [{ videoId: 'a', preferredRate: 1.5 }, { videoId: 'b' }];
  const first = JSON.stringify(migrateVideos(recs));
  assert.equal(JSON.stringify(migrateVideos(recs)), first);
});

test('migrateVideos survives null / undefined / non-object entries', () => {
  const recs = [null, undefined, 'nope', 7, [], { videoId: 'a', preferredRate: 2 }];
  assert.doesNotThrow(() => migrateVideos(recs));
  assert.equal(recs[5].preferredSpeed, 2);
  assert.doesNotThrow(() => migrateVideos([])); // empty store
});

test('migrateVideos does NOT normalize state (normalization was removed)', () => {
  const recs = [{ videoId: 'a', state: 'watched' }];
  migrateVideos(recs);
  assert.equal(recs[0].state, 'watched'); // any non-'new' value already means handled
});

test('migrateVideos returns a NON-ARRAY argument unchanged instead of throwing', () => {
  assert.strictEqual(migrateVideos(null), null);
  assert.strictEqual(migrateVideos(undefined), undefined);
  assert.strictEqual(migrateVideos('nope'), 'nope');
  assert.strictEqual(migrateVideos(7), 7);
  const obj = { videoId: 'a', preferredRate: 2 }; // a bare record, not a list
  assert.strictEqual(migrateVideos(obj), obj);
  assert.deepEqual(obj, { videoId: 'a', preferredRate: 2 }); // and left untouched
});

// --- migrateChannelPrefs: legacy inner rate -> speed --------------------------

test('migrateChannelPrefs moves rate to speed and preserves ignored', () => {
  const prefs = { c1: { rate: 2, ignored: true } };
  const out = migrateChannelPrefs(prefs);
  assert.deepEqual(out, { c1: { ignored: true, speed: 2 } });
  assert.ok(!('rate' in out.c1));
});

test('migrateChannelPrefs never clobbers an existing speed', () => {
  const prefs = { c1: { speed: 1.5, rate: 2 } };
  migrateChannelPrefs(prefs);
  assert.deepEqual(prefs, { c1: { speed: 1.5 } });
});

test('migrateChannelPrefs drops a rate of null without filling speed', () => {
  const prefs = { c1: { rate: null, ignored: true } };
  migrateChannelPrefs(prefs);
  assert.deepEqual(prefs, { c1: { ignored: true } });
});

test('migrateChannelPrefs is idempotent on a second run', () => {
  const prefs = { c1: { rate: 2 }, c2: { ignored: true } };
  const first = JSON.stringify(migrateChannelPrefs(prefs));
  assert.equal(JSON.stringify(migrateChannelPrefs(prefs)), first);
});

test('migrateChannelPrefs survives string / number / null / array entries', () => {
  const prefs = { a: 'x', b: 7, c: null, d: [], e: { rate: 1.5 } };
  assert.doesNotThrow(() => migrateChannelPrefs(prefs));
  assert.equal(prefs.e.speed, 1.5);
  assert.doesNotThrow(() => migrateChannelPrefs({}));
});

test('migrateChannelPrefs DROPS an entry the rename left with no properties', () => {
  const prefs = { c1: { rate: null }, c2: { rate: 2 }, c3: {} };
  migrateChannelPrefs(prefs);
  assert.deepEqual(prefs, { c2: { speed: 2 } }); // no '{}' entry survives
  assert.ok(!('c1' in prefs)); // deleted, not left empty
  assert.deepEqual(migrateChannelPrefs({ c1: { rate: null } }), {}); // map can now empty
});

test('migrateChannelPrefs leaves pre-existing default-ish entries alone', () => {
  // {ignored:false} is data this migration did not create — not its cruft to clean.
  const prefs = { c1: { ignored: false }, c2: { ignored: false, rate: null } };
  migrateChannelPrefs(prefs);
  assert.deepEqual(prefs, { c1: { ignored: false }, c2: { ignored: false } });
});

test('migrateVideos and migrateChannelPrefs return the very value passed in', () => {
  // store.js / migrateLocalStorage rely on the mutate-and-return convention.
  const recs = [{ videoId: 'a', preferredRate: 2 }];
  assert.strictEqual(migrateVideos(recs), recs);
  const prefs = { c1: { rate: 2 } };
  assert.strictEqual(migrateChannelPrefs(prefs), prefs);
  const emptied = { c1: { rate: null } }; // same object even when entries are dropped
  assert.strictEqual(migrateChannelPrefs(emptied), emptied);
});

// --- migrateLocalStorage: the one-shot on-load localStorage pass --------------
//
// A minimal localStorage stub, installed only for the tests below so importing
// the module stays clean (no browser globals at import time).

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Run fn with `storage` installed as globalThis.localStorage, always removing it. */
function withStorage(storage, fn) {
  globalThis.localStorage = storage;
  try {
    fn(storage);
  } finally {
    delete globalThis.localStorage;
  }
}

test('migrateLocalStorage removes both legacy speed keys without carrying values', () => {
  withStorage(
    makeStorage({ yqa_playback_rate: '2', yqa_default_rate: '1.5' }),
    (ls) => {
      migrateLocalStorage();
      assert.equal(ls.getItem('yqa_playback_rate'), null);
      assert.equal(ls.getItem('yqa_default_rate'), null);
      assert.equal(ls.getItem('yqa_playback_speed'), null); // values NOT carried over
      assert.equal(ls.getItem('yqa_default_speed'), null);
    }
  );
});

test('migrateLocalStorage leaves the current speed keys untouched', () => {
  withStorage(
    makeStorage({
      yqa_playback_rate: '2',
      yqa_playback_speed: '1.5',
      yqa_default_speed: '2',
    }),
    (ls) => {
      migrateLocalStorage();
      assert.equal(ls.getItem('yqa_playback_speed'), '1.5');
      assert.equal(ls.getItem('yqa_default_speed'), '2');
    }
  );
});

test('migrateLocalStorage rewrites the channel prefs to the speed shape ON DISK', () => {
  const raw = JSON.stringify({ c1: { rate: 2 }, c2: { ignored: true } });
  withStorage(makeStorage({ yqa_channel_prefs: raw }), (ls) => {
    migrateLocalStorage();
    assert.deepEqual(JSON.parse(ls.getItem('yqa_channel_prefs')), {
      c1: { speed: 2 },
      c2: { ignored: true },
    });
  });
});

test('migrateLocalStorage is idempotent across two runs', () => {
  const raw = JSON.stringify({ c1: { rate: 2 } });
  withStorage(makeStorage({ yqa_channel_prefs: raw, yqa_playback_rate: '2' }), (ls) => {
    migrateLocalStorage();
    const after = ls.getItem('yqa_channel_prefs');
    migrateLocalStorage();
    assert.equal(ls.getItem('yqa_channel_prefs'), after);
    assert.deepEqual(ls.data, { yqa_channel_prefs: after });
  });
});

test('migrateLocalStorage leaves already-current prefs byte-identical', () => {
  const raw = JSON.stringify({ c1: { speed: 1.5, ignored: true } });
  withStorage(makeStorage({ yqa_channel_prefs: raw }), (ls) => {
    migrateLocalStorage();
    assert.equal(ls.getItem('yqa_channel_prefs'), raw);
  });
});

test('migrateLocalStorage removes an EMPTY prefs map (no {} garbage)', () => {
  withStorage(makeStorage({ yqa_channel_prefs: '{}' }), (ls) => {
    migrateLocalStorage();
    assert.equal(ls.getItem('yqa_channel_prefs'), null);
  });
});

test('migrateLocalStorage never PERSISTS an entry the migration emptied', () => {
  const raw = JSON.stringify({ c1: { rate: null }, c2: { ignored: true } });
  withStorage(makeStorage({ yqa_channel_prefs: raw }), (ls) => {
    migrateLocalStorage();
    const written = ls.getItem('yqa_channel_prefs');
    assert.equal(written.includes('{}'), false); // no empty entry reaches the disk
    assert.deepEqual(JSON.parse(written), { c2: { ignored: true } });
  });
});

test('migrateLocalStorage REMOVES the key when the migration empties every entry', () => {
  const raw = JSON.stringify({ c1: { rate: null }, c2: { rate: null } });
  withStorage(makeStorage({ yqa_channel_prefs: raw }), (ls) => {
    migrateLocalStorage();
    assert.equal(ls.getItem('yqa_channel_prefs'), null); // not '{}'
    assert.deepEqual(ls.data, {});
  });
});

test('migrateLocalStorage does not CREATE the prefs key when it is absent', () => {
  withStorage(makeStorage({ yqa_playback_rate: '2', yqa_default_rate: '1.5' }), (ls) => {
    migrateLocalStorage();
    assert.equal(ls.getItem('yqa_channel_prefs'), null);
    assert.deepEqual(ls.data, {}); // legacy keys gone, nothing invented
  });
});

test('migrateLocalStorage ignores unparseable / non-object prefs', () => {
  withStorage(makeStorage({ yqa_channel_prefs: 'not json' }), (ls) => {
    assert.doesNotThrow(() => migrateLocalStorage());
    assert.equal(ls.getItem('yqa_channel_prefs'), 'not json');
  });
  withStorage(makeStorage({ yqa_channel_prefs: '[1,2]' }), (ls) => {
    assert.doesNotThrow(() => migrateLocalStorage());
    assert.equal(ls.getItem('yqa_channel_prefs'), '[1,2]');
  });
});

test('migrateLocalStorage does not throw when storage throws on get/set/remove', () => {
  const boom = () => {
    throw new Error('storage disabled');
  };
  withStorage({ getItem: boom, setItem: boom, removeItem: boom }, () => {
    assert.doesNotThrow(() => migrateLocalStorage());
  });
  // ...and when it throws only on the WRITE back of a migrated map.
  const ls = makeStorage({ yqa_channel_prefs: JSON.stringify({ c1: { rate: 2 } }) });
  withStorage({ ...ls, setItem: boom }, () => {
    assert.doesNotThrow(() => migrateLocalStorage());
  });
});

test('migrateLocalStorage does not throw when localStorage is absent entirely', () => {
  assert.doesNotThrow(() => migrateLocalStorage()); // no stub installed here
});

console.log(`\n${passed} passed`);
