---
name: browser-test
description: Verify a youtube-queue-app change in a real browser using the Playwright MCP tools — serve the pages, seed IndexedDB past onboarding, then check focus order, key handling, layout and what the page actually draws (the real YouTube player included). Use when a change can only be judged by what the browser does or renders, and you want to confirm it while working rather than store a test.
---

# Browser verification (Playwright MCP)

Drive the real app in a real browser to **confirm a change while you are making
it**. The evidence belongs in the conversation; nothing is saved as a test.

## Check this first — most questions are not browser questions

1. **Anything pure goes to the `node:assert` suites**, which stay the first
   stop: `node js/queue.test.mjs` and `node js/migrations.test.mjs`, from the
   repo root. All of `js/queue.js` is pure by rule, and new pure logic goes
   there **with a matching test**. `computeCutoff`, `addToStash`,
   `reconcileStash`, `parseVideoId` — not one of them needs a browser.
2. **Reading the code beats automating it.** A planned performance fix here was
   already in the file — `loading="lazy"` on the card thumbnails — which one
   `grep` settled and no browser check would have surfaced.
3. Reach for the browser when the question is genuinely **what the browser
   does** (real focus order, key handling, `preventDefault`, layout at a
   breakpoint, IndexedDB-backed rendering) or **what it draws**.

This browser drives the **real YouTube player** — actual sign-in, a real embed,
real playback. Nothing here stubs it, so what you are looking at is what a user
gets, iframe behaviour included.

## Getting the app into a testable state

### 1. Serve the repo root over http

Never `file://` — ES-module CORS refuses it, and IndexedDB there is
opaque-origin. From the repo root, in the background:

```
python -m http.server 5273 --bind 127.0.0.1
```

(5273 rather than the README's 5173, which is often already taken on this
machine.)

### 2. Navigate, seed, navigate again

Three calls in this order. The first `browser_navigate` exists **only to get the
origin** — you cannot write an origin's `localStorage`/IndexedDB before you are
on it. One `browser_evaluate` then seeds, and the second `browser_navigate`
reloads into the seeded state.

`browser_navigate` to `http://localhost:5273/index.html`, then `browser_evaluate`:

```js
async () => {
  const FLOOR = '2025-12-31T00:00:00.000Z';   // BEFORE every record below
  localStorage.setItem('yqa_client_id', 'x.apps.googleusercontent.com');
  localStorage.setItem('yqa_start_cutoff', FLOOR);

  // Record shape is js/api.js's — do not invent fields. `state` is what the
  // page adds; a stash record also carries `addedAt` + `channelAvatarUrl`.
  const mk = (i) => ({
    videoId: `SEED${String(i).padStart(7, '0')}`.slice(0, 11),
    title: `Seeded video ${i} — long enough to look like a real one`,
    channelId: 'UC000000000000000000000',
    channelTitle: 'Test Channel',
    publishedAt: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    thumbnailUrl: 'https://i.ytimg.com/vi/x/mqdefault.jpg',
    durationSeconds: 300,          // >90s, so no SHORTS badge
    embeddable: true,
    description: `Seeded description ${i}.`,
    state: 'new',
  });
  const videos = Array.from({ length: 20 }, (_, i) => mk(i));

  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('yqa', 2);      // name + version from js/config.js
    r.onupgradeneeded = () => {              // mirrors store.js's openDb()
      for (const n of ['videos', 'stash']) {
        if (!r.result.objectStoreNames.contains(n)) {
          r.result.createObjectStore(n, { keyPath: 'videoId' });
        }
      }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('seed blocked — another tab holds the DB'));
  });

  await new Promise((res, rej) => {          // AWAIT the commit, or the reload
    const tx = db.transaction(['videos', 'stash'], 'readwrite');   // races it
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.objectStore('videos').clear();        // start from empty every time
    tx.objectStore('stash').clear();
    for (const rec of videos) tx.objectStore('videos').put(rec);
  });

  db.close();                                // release before the app opens it
  return videos.length;
}
```

Then `browser_navigate` to the same URL again. For `stash.html`, put records
carrying `addedAt` + `channelAvatarUrl` into the `stash` store instead.

Confirm the seed took — one `browser_evaluate` returning
`document.querySelectorAll('#queue-list .row').length` — before trusting
anything downstream.

### Seeding traps — each of these costs real time

- **`publishedAt` must be AFTER the floor** (`yqa_start_cutoff`), or the record
  is *deleted*, not merely hidden. Measured: a record at `2025-06-01` under a
  `2025-12-31` floor was gone from the DOM **and** from IndexedDB after one load.
- **A HANDLED record seeded at the FRONT of the queue is deleted before the
  first render.** `init()` runs `cleanup()`, which prunes the whole handled
  prefix — the app working correctly, not the seed failing. Worse, **the floor
  moves with it**: seeding card 0 as `skipped` advanced `yqa_start_cutoff` from
  `2025-12-31` to that card's own `publishedAt`, so a re-seed at the same
  timestamps silently loses more. **Mark cards mid-session instead of seeding
  them handled** — and re-write the floor on every re-seed regardless.
- **`routeFirstRun()` gates on those two localStorage keys, in order** —
  `yqa_client_id` absent gives the "paste your OAuth Client ID" panel,
  `yqa_start_cutoff` absent the "pick a cutoff" panel. **Records alone leave you
  sitting on onboarding.** Any non-empty client id gets past it; nothing signs in.

## Browser traps

- **Chrome ANIMATES a native keyboard scroll — never read a scroll position
  once.** Measured here: an ArrowDown at the end of the walk (where the app
  declines the key and native scrolling takes over) crept `.workspace__queue`
  2000 → 2040 over **eight frames**; sample them with a `requestAnimationFrame`
  collector. **The app's OWN scrolls are instant** — a PageDown moved the pane
  `0 → 3861` in one frame — so the animation only bites where the walk
  *declines* the key: inside `.workspace__player`, and at the clamp ends.
- **The MCP round-trip is itself a timing problem.** You cannot press a key from
  inside `browser_evaluate`, so sampling is three calls — install the rAF
  collector, `browser_press_key`, read it back — and it collects **hundreds of
  idle frames** while those calls travel. Find the transition
  (`s.findIndex(v => v !== s[0])`); never read the front of the array.
- **An ELEMENT screenshot clips to the bounding box, which crops this app's
  focus rings** — every one of them is painted *outside* its border box, so an
  element shot makes "focused" look identical to "plain" and proves nothing. Use
  a viewport or full-page shot, or a clip (see Magnifying).
- **`:focus-visible` is the ring check.** The card ring draws on
  `:focus-visible` OR `.row--pointed`, so `el.matches(':focus-visible')`
  answers "is it ringed" without a screenshot. **Drive the gesture the user
  would make** — a real click for a click, `browser_press_key` for a key —
  because the input modality is what the property reports, and a bare
  `.focus()` out of `browser_evaluate` stands for neither.
- **`document.body.focus()` blurs nothing** — `<body>` carries no `tabindex`.
  Use `document.activeElement.blur()` to reproduce where `bindIframeFocusGuard`
  puts focus after a click on the video.
- **The single-tab Web Lock is per origin.** A second `index.html` in the same
  browser paints "another tab is already open". If a check goes strangely quiet,
  look for a stray tab (`browser_tabs` → `close`): a card's channel link opens
  one, being `target="_blank"`.

## Confirming a visual change

Capture, change, capture again with the **same** framing, and compare the two in
the conversation:

1. `browser_take_screenshot` of the region as it stands.
2. Make the edit; reload.
3. **Prove the edit is live by reading a computed style** — never by looking at
   the page — then `browser_take_screenshot` again, same viewport, same framing.

Step 3 is not ceremony: **a reload serves the OLD `styles.css` for minutes at a
time**, and the tell is a full set of "after" measurements identical to the
"before" ones, with a plausible diff sitting in the file. Cache-disabling takes
**two** CDP calls on one session, in order — `Network.enable`, *then*
`Network.setCacheDisabled({ cacheDisabled: true })`; the second alone is a no-op.

Pin the viewport whenever the answer depends on layout: 1280×800 is the
side-by-side two-pane layout, ≤900px the stacked one, and the two have genuinely
different arrow-key rules.

### Magnifying, and the override that then owns the viewport

A 2px ring against a 36px avatar cannot be judged at 1×, and element shots crop
rings. `browser_run_code_unsafe` — raw Playwright/CDP against the live page — is
the way up:

```js
const s = await page.context().newCDPSession(page);
await s.send('Emulation.setDeviceMetricsOverride',
  { width: 1280, height: 800, deviceScaleFactor: 3, mobile: false });
await page.screenshot({ clip: { x, y, width: 240, height: 140 }, scale: 'device' });
```

A `clip` beats an element target: you choose the margin. Same hatch for **dark
mode**, which has no in-app toggle — the app is `prefers-color-scheme` only, so
`page.emulateMedia({ colorScheme: 'dark' })` is the only route to a dark shot.

- **The override then owns the viewport, and `browser_resize` goes silently
  inert.** `page.setViewportSize` stops moving `innerWidth`, and clearing the
  override from a *new* CDP session does not undo it; the tell is a responsive
  sweep whose 900/600/360 rows all agree (all still 1280). Re-send the override
  with the new size instead, and **assert `innerWidth` and
  `matchMedia('(max-width: 900px)').matches` whenever width is the question.**
- **Let the viewport settle before measuring.** A `getBoundingClientRect` read
  straight after a size change was ~90px off; re-probe until two agree.

## Artifacts

The MCP server writes page snapshots and console logs into **`.playwright-mcp/`
in the repo root**. It is gitignored. Read the console log when something will
not render — that is where a seeding mistake shows up first.

## There is no test suite here, on purpose

There is **no regression suite and no screenshot baselines.** That is the
owner's decision, not an omission: this app is used and verified daily by the
person who owns it, and a maintained suite plus baselines was a recurring tax
buying protection they do not need. **Do not helpfully rebuild one.** Confirm
the change in front of you, show the evidence, and move on.
