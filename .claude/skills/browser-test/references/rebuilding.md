# Rebuilding `.browser-tests/` from nothing

Read this when the rig is **missing or broken**: a fresh clone (which has no
`.browser-tests/` at all — the whole directory is gitignored), an `npm` install
that has gone wrong, or Playwright trying to download browsers.

Nothing here is needed to *run* or *write* tests. That is `SKILL.md`, next to
this file. This document is the reconstruction recipe, and it is the only thing
standing between a future session and a working rig.

## Prerequisites

Everything runs from `.browser-tests/`. Node 24 / npm 11 and Python 3 (for the
static server) are already on this machine, and so is Chrome at
`C:\Program Files\Google\Chrome\Application\chrome.exe`.

## 1. Install

```powershell
mkdir .browser-tests
cd .browser-tests
# package.json: private, ESM, one devDependency.
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
npm install --save-dev @playwright/test
```

(bash: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --save-dev @playwright/test`)

`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is the point. The rig uses
**`channel: 'chrome'` — the system Chrome** — so Playwright's ~300MB browser
bundle is never downloaded. Total on-disk cost is the npm package alone,
**about 19MB**. If you ever see Playwright trying to download browsers, the
channel setting has been lost; fix that rather than letting the download run.

## 2. `.browser-tests/package.json`

```json
{
  "name": "yqa-browser-tests",
  "private": true,
  "type": "module",
  "description": "Local-only Playwright rig for youtube-queue-app. NEVER committed: the app itself has zero dependencies and no build step.",
  "scripts": {
    "test": "playwright test",
    "test:headed": "playwright test --headed",
    "update-snapshots": "playwright test --update-snapshots",
    "report": "playwright show-report"
  },
  "devDependencies": {
    "@playwright/test": "^1.56.0"
  }
}
```

## 3. `.browser-tests/playwright.config.mjs`

Port **5273**, not 5173 — 5173 (what `README.md` suggests for manual serving) is
occupied by something else on this machine. Change it in one place, or override
per-run with `YQA_TEST_PORT`.

```js
// .browser-tests/playwright.config.mjs
//
// Local-only browser-testing rig for youtube-queue-app. This whole directory is
// gitignored: the app has ZERO runtime/build dependencies and that invariant is
// deliberate. Nothing in here may ever move up into the repo root.
//
// See .claude/skills/browser-test/SKILL.md for the full story.

import { defineConfig, devices } from '@playwright/test';

// The static server's port. 5173 (the README's suggestion) has been seen
// occupied by something else on this machine, so the rig uses its own. Override
// with YQA_TEST_PORT=NNNN if this one is taken too.
export const PORT = Number(process.env.YQA_TEST_PORT || 5273);

// The app MUST be reached over http:// — ES-module CORS refuses file://, and
// IndexedDB on file:// is opaque-origin. `localhost` (not 127.0.0.1) keeps the
// origin identical to the one the README tells users to serve on, so anything
// origin-scoped (IndexedDB, Web Locks, BroadcastChannel) behaves the same.
export const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // The specs are independent (each gets a fresh browser context), but the
  // single-tab Web Lock guard is per-ORIGIN and shared across contexts of the
  // same browser: two index.html pages alive at once means the second one paints
  // "another tab is already open". Workers are separate browser instances, so
  // parallel FILES are fine; parallel tests inside a file are not worth the risk.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  expect: {
    toHaveScreenshot: {
      // Playwright's BUILT-IN transition/animation freeze — preferred over
      // injecting a `* { transition: none }` stylesheet, which would change the
      // very rendering we are baselining. It finishes finite animations and
      // rewinds infinite ones before the shot.
      animations: 'disabled',
      // Hides the caret so a focused text field never flickers a baseline.
      caret: 'hide',
      // Sub-pixel text antialiasing differs a hair between Chrome builds.
      maxDiffPixelRatio: 0.01,
    },
  },

  use: {
    baseURL: BASE_URL,
    // SYSTEM CHROME, not a downloaded Chromium: `channel: 'chrome'` skips
    // Playwright's ~300MB browser download entirely (install with
    // PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). Cost of the rig is then just the npm
    // package (~19MB).
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        // Pinned for screenshot determinism. 1280x800 is comfortably above the
        // 900px breakpoint, so this is the SIDE-BY-SIDE two-pane layout — the
        // one the arrow-key rules are written for.
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        // styles.css is light/dark aware; pin one so baselines don't depend on
        // the OS theme. A dark baseline would be a second project.
        colorScheme: 'light',
        // A card prints its publish date through toLocaleString, so both of
        // these are visible pixels in a baseline.
        timezoneId: 'UTC',
        locale: 'en-US',
      },
    },
  ],

  webServer: {
    // Serves the REPO ROOT — hence cwd one level up. No build step exists, so
    // this is the whole "build": hand the committed files to a static server.
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    cwd: '..',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: 30_000,
  },
});
```

## 4. `.browser-tests/fixtures/records.mjs`

The record factory. **The record shape is copied from `js/api.js`, not
invented** — it is exactly what `fetchChannelUploads` (the playlist path) and
`getVideosByIds` (the by-id path) assemble, plus the fields the page writes onto
a stored record afterwards (`state`, and optionally `preferredSpeed` / `liked` /
`watchedSeconds`).

It **mirrors** app constants rather than importing `js/config.js`, so the rig can
never become a reason to change a module's shape. Keep the copies in step by hand.

Exports:

- `STATE_NEW = 'new'`, `STATE_SKIPPED = 'skipped'` — mirrored from `js/config.js`.
- `IDB = { name: 'yqa', version: 2, stores: { videos: 'videos', stash: 'stash' }, keyPath: 'videoId' }`
  — mirrored from `js/config.js`.
- `LS` — the localStorage keys the rig touches, mirrored from `js/config.js`:
  `clientId: 'yqa_client_id'`, `startCutoff: 'yqa_start_cutoff'`,
  `cutoff: 'yqa_cutoff'`, `channels: 'yqa_channels'`,
  `channelPrefs: 'yqa_channel_prefs'`, `playbackSpeed: 'yqa_playback_speed'`,
  `defaultSpeed: 'yqa_default_speed'`, `hideMarked: 'yqa_hide_marked'`.
- `videoIdFor(i)` — a deterministic 11-character YouTube-shaped id:
  `` `SEED${String(i).padStart(7, '0')}`.slice(0, 11) ``. Real ids are
  `[A-Za-z0-9_-]{11}` and `parseVideoId()` in `js/queue.js` accepts exactly that,
  so a seeded id survives being pasted into the stash's add form too.
- `makeRecord(i, overrides = {})` — one video record, `overrides` merged **last**
  so a spec can set `state` / `embeddable` / anything else:

```js
const channelIndex = i % 3;
{
  // --- assembled by js/api.js ---
  videoId: videoIdFor(i),
  title: `Seeded video ${i} — a title long enough to look like a real one`,
  channelId: `UC${String(channelIndex).repeat(22).slice(0, 22)}`,
  channelTitle: `Test Channel ${channelIndex}`,
  // Derived from `i` so the queue's oldest-first order is exactly ascending `i`
  // (index 0 is the top card), and based at 2026-01-01 so every seeded video is
  // comfortably AFTER FLOOR_ISO (below).
  publishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 3600_000).toISOString(),
  thumbnailUrl: `https://i.ytimg.com/vi/${videoIdFor(i)}/maxresdefault.jpg`,
  durationSeconds: 300 + i * 7,   // > SHORTS_MAX_SECONDS (90): no SHORTS badge
  embeddable: true,
  description: `Seeded description for video ${i}.`,
  // --- written by the page onto a stored record ---
  state: STATE_NEW,
  ...overrides,
}
```

- `makeStashRecord(i, overrides = {})` — `makeRecord(i)` plus the two fields a
  stash record carries, `overrides` merged last:

```js
{
  ...makeRecord(i),
  // the stash's sort key
  addedAt: new Date(Date.UTC(2026, 1, 1, 0, 0, 0) + i * 60_000).toISOString(),
  // the record-carried avatar stashChannelInfo prefers over the channel map
  channelAvatarUrl: `https://yt3.ggpht.com/seed-avatar-${i % 3}=s240`,
  ...overrides,
}
```

- `recordsFrom(countOrArray, factory = makeRecord)` — an array passes straight
  through; a number `n` becomes `Array.from({ length: n }, (_, i) => factory(i))`.
- `channelMapFor(records)` — the map the pages persist in `yqa_channels`:
  `channelId -> { title, avatarUrl }`, skipping records with no `channelId` and
  ones already seen, with `avatarUrl` numbered by insertion order
  (`` `https://yt3.ggpht.com/seed-avatar-${n}=s240` ``).

## 5. `.browser-tests/fixtures/app.mjs`

The one fixture every spec uses. It exports `test` (a `base.extend` carrying an
`app` fixture), re-exports `expect`, and re-exports `makeRecord`,
`makeStashRecord`, `videoIdFor`, `LS`, `STATE_NEW` and `STATE_SKIPPED` from
`records.mjs`, so a spec has exactly one import.

It does four things, so no spec has to. None of them is optional:

### 1. Stubs every off-origin request

The app pulls Google Identity Services, the YouTube IFrame API, thumbnails
(`i.ytimg.com`) and avatars (`yt3.ggpht.com`) off the network. Left alone those
make tests slow, flaky and — for screenshots — nondeterministic (the thumbnail
path is a two-step `maxresdefault` -> `mqdefault` probe that depends on what
YouTube happens to return). `page.route()` serves everything locally instead:

- `https://accounts.google.com/**` -> `200 application/javascript`, body
  `/* GIS stub */`. An empty script is enough: nothing in a test signs in, because
  every API-backed control authorizes on demand and no test clicks one.
- `https://www.youtube.com/**` -> the same empty-script fulfilment. So `window.YT`
  never appears, `onYouTubeIframeAPIReady` never fires, and `player.js` creates
  **no player at all**. Deliberate: a real embedded player is neither
  deterministic nor necessary — the "now playing" state a card renders is a CSS
  class.
- `https://i.ytimg.com/**` -> `200 image/png`, a **flat 480×270 PNG** held as a
  `Buffer.from(<base64>, 'base64')` module constant. Any solid-colour PNG will
  do; the **width is load-bearing**: ≥320 makes `ui.js`'s "is this the tiny grey
  `maxresdefault` stub?" onload probe pass, so it never swaps to `mqdefault` and
  each card loads exactly one image, once — a card that is stable for a shot.
- `yt3.ggpht.com`, `yt4.ggpht.com` and `yt3.googleusercontent.com` (loop over the
  three hosts) -> `200 image/png`, a flat **96×96** PNG for the circular avatars.
- `**/__yqa_seed__` -> `200 text/html`, body
  `<!doctype html><meta charset="utf-8"><title>seed</title>`. A blank document on
  the app's own origin to seed storage from. It is a routed path rather than the
  static server's 404 body so the seed page's content is our own.

### 2. Seeds IndexedDB *and* localStorage before the app boots

`seedApp(page, { videos, stash, localStorage })` navigates to the blank seed page
(`SEED_PATH = '/__yqa_seed__'`) and then, in one `page.evaluate`:

- writes each localStorage entry — a string set as-is, anything else
  `JSON.stringify`d, `null`/`undefined` **removed**;
- opens `indexedDB.open(IDB.name, IDB.version)` with an
  **existence-guarded upgrade** that creates whichever of the two stores is
  missing at `keyPath: 'videoId'` — mirroring `openDb()` in `js/store.js` — and
  rejects on `onerror` and on `onblocked`;
- runs **one** `readwrite` transaction over both stores that first `clear()`s
  each (start from empty every time: contexts are fresh per test, but a headed
  debugging run against a reused profile is not), then `put`s the video records
  into `videos` and the stash records into `stash`, awaiting `tx.oncomplete`;
- `db.close()`s.

**Why not `addInitScript`:** an init script cannot block the page's module
scripts, so its own `indexedDB.open()` would race the app's — two opens of `yqa`
at v2 from one document, with the seed still writing while `store.js` is already
reading. Seeding on a separate same-origin document first has no race at all: the
connection is closed before the app is ever loaded.

**What it takes to boot past onboarding** is exactly two localStorage keys —
`routeFirstRun()` in `js/subscriptions-page.js` checks `yqa_client_id` (absent =>
the "paste your OAuth Client ID" panel) and then `yqa_start_cutoff` (absent =>
the "pick a start cutoff" panel). With both present the app renders; records
alone are **not** enough. Two module constants supply them:

- `FLOOR_ISO = '2025-12-31T00:00:00.000Z'` — **exported**; a day before the first
  seeded record. The floor is the deletion boundary (`init()` runs `cleanup()`,
  which deletes every record with `publishedAt <=` the live cutoff), so seeded
  videos must be published after it or they are gone before the first render.
- `TEST_CLIENT_ID = '000000000000-testtesttesttest.apps.googleusercontent.com'` —
  any non-empty value gets past the Client ID panel; it is never used, because
  nothing signs in.

### 3. Navigates and waits for the first render

`app.open()` builds the records (`recordsFrom` over each of `videos` and `stash`),
derives the channel map with `channelMapFor` over the **union** of both lists,
calls `seedApp` with `{ [LS.clientId]: TEST_CLIENT_ID, [LS.startCutoff]:
FLOOR_ISO, [LS.channels]: JSON.stringify(channels), ...extraLs }` — caller keys
merged **over** the defaults — then `page.goto(path)`. When the page being opened
is expected to have records (`path.includes('stash')` picks which list to count),
it awaits `expect(page.locator('#queue-list .row').first()).toBeVisible()`: the
first card appearing is the proof that onboarding was skipped, the store read
succeeded and `render()` ran. It returns `{ videos, stash }` — the records as
seeded.

The rest of the `app` object is a thin locator/`page.evaluate` surface; its
signatures are documented in SKILL.md under "The fixture" and must match:
`page`, `cards()` (`#queue-list .row`), `showAll()`
(`#queue-list .queue-more__btn`), `focusedCardId()`
(`document.activeElement.closest('.row')?.dataset.videoId ?? null`) and
`focusDescription()` (the same walk rendered as
`tag#id.classes (in card <videoId>)`, for readable failures).

### 4. Turns focus events on

Headless Chrome driven over raw CDP does not fire `focus`/`focusin` unless
`Emulation.setFocusEmulationEnabled` is sent first. **Playwright sends it for
us** — verified, and `tests/focus-nav.spec.mjs` asserts it rather than trusting
it — so there is nothing to do here beyond that assertion. If a future
Playwright/Chrome combination regresses, the fix belongs **here, in the fixture**,
not in a spec.

## 6. The specs, and the first run

Recreate `tests/focus-nav.spec.mjs` and `tests/card-visual.spec.mjs` from "The
specs" and "Screenshots" in SKILL.md, which describe what each one covers and the
rules a visual spec must follow (clipped page shots via `shotWithMargin()`, the
`row--playing` class rather than a real embed).

Snapshots need no seeding of their own: `.browser-tests/` is gitignored, so a
rebuilt rig starts with no baselines, the first run reports *failed* with "A
snapshot doesn't exist … writing actual", and the second run passes.
