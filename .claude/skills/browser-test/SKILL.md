---
name: browser-test
description: Drive youtube-queue-app in a real browser with the local, gitignored Playwright rig in .browser-tests/ — focus/keyboard navigation, card menus, IndexedDB-backed rendering, and visual (screenshot) baselines. Use when a change can only be judged by what the browser actually does or draws, when asked to run/update/repair the browser tests or snapshots, or before deciding to hand-verify something in a browser by eye.
---

# Browser testing (local-only Playwright rig)

## What this is, and why it is outside git

`.browser-tests/` at the repo root is a Playwright rig for driving the real app
in a real Chrome. **It is gitignored in its entirety** (see the `.browser-tests/`
entry in `.gitignore`) and it must stay that way.

The reason is the first line of `CLAUDE.md`: this app has **no build step, no
framework, no bundler, no `package.json`, no `node_modules`**. That is a
deliberate property of the product — three static HTML pages and a folder of ES
modules, served straight off GitHub Pages from the committed repo root, with the
only runtime dependencies being three Google-hosted scripts. A `package.json` at
the root, or a committed `node_modules`, would end that. Deploy = push to
`main`, so anything committed is *shipped*; keeping the rig out of git is what
keeps it out of production.

The cost, stated plainly: **the rig's source is local-only too, not just its
snapshots.**

> **If `.browser-tests/` is missing (a fresh clone has none at all), the install
> is broken, or Playwright starts downloading browsers — stop and read
> [`references/rebuilding.md`](references/rebuilding.md) beside this file.** It
> rebuilds the rig from an empty directory: install commands, the verbatim
> `package.json` and `playwright.config.mjs`, and the full fixture contract.

## Running it

All commands from `.browser-tests/`. The static server starts and stops itself —
never start one by hand first (or if you do, `reuseExistingServer` will adopt it,
which is fine for debugging).

```powershell
npx playwright test                          # everything
npx playwright test tests/focus-nav.spec.mjs # one file
npx playwright test -g "Show all"            # by title
npx playwright test --headed                 # watch it happen
npx playwright test --debug                  # step through, with the inspector
npx playwright test --update-snapshots       # accept new visual baselines
npx playwright show-report                   # the HTML report from the last run
npx playwright show-trace test-results/<dir>/trace.zip   # a failed run, frame by frame
```

Traces are captured on failure only (`trace: 'retain-on-failure'`), so a failing
test always leaves a `trace.zip` under `test-results/` with the DOM, the network
log and a screenshot at every step. Open it before guessing.

## The fixture

`fixtures/app.mjs` exports a `test` with an `app` fixture. It exists so no spec
has to think about seeding, onboarding or the network:

```js
import { test, expect } from '../fixtures/app.mjs';

test('…', async ({ app, page }) => {
  const { videos } = await app.open({ videos: 5 });      // seeds + navigates + waits
  await app.open({ stash: 3, path: '/stash.html' });
  await app.open({ videos: [makeRecord(0, { state: 'skipped' })] });
  await app.open({ videos: 3, localStorage: { yqa_hide_marked: '1' } });
  app.cards();            // locator for #queue-list .row
  app.showAll();          // locator for the "Show all (N)" footer button
  await app.focusedCardId();      // videoId of the card CONTAINING activeElement
  await app.focusDescription();   // where focus is, as a readable string
});
```

`app.open()` seeds IndexedDB *and* localStorage on a blank same-origin document,
navigates, and waits for the first card to be visible. It returns
`{ videos, stash }` — the records as seeded, so a spec can assert against them.
Anything you pass as `localStorage` is merged **over** the fixture's own defaults
(`yqa_client_id`, `yqa_start_cutoff`, `yqa_channels`) rather than replacing them;
the first two are what get the app past onboarding, so do not null them out
unless testing onboarding is the point.

Everything off-origin is stubbed: Google Identity Services and the YouTube IFrame
API are empty scripts — so `window.YT` never appears and **no player is ever
created**, deliberately — and thumbnails/avatars are flat local PNGs.

`fixtures/fake-player.mjs` is the **opt-in exception** to that last part, for the
one question no-player cannot answer: whether keyboard focus can get *past* the
player frame.

```js
import { installFakePlayer, where, pressTrail, pressTrailNodes } from '../fixtures/fake-player.mjs';

await installFakePlayer(page);   // BEFORE app.open()
await where(page);               // document.activeElement, described
await pressTrail(page, 'Tab', 6);      // where focus landed after each press
await pressTrailNodes(page, 'Tab', 6); // same, plus samePrev — compared by NODE
```

It installs a `window.YT.Player` that mirrors the one structural fact `player.js`
depends on — the constructor **replaces the mount `<div>` with an `<iframe>`
carrying the same id, synchronously**, and `loadVideoById` never touches the
element — and points that iframe at **`http://127.0.0.1:PORT`** while the app is
served on `http://localhost:PORT`. Same static server, **different origin**. That
matters more than it looks: focus entering a *same-origin* iframe does not blur
the top-level window, so a local stub would quietly "pass" a test of a bug it
cannot even reproduce. `pressTrailNodes` exists because a description is not an
identity — the topbar renders two `a.topbar__nav-link`s back to back, so "no
repeats" has to be asked of the node.

`fixtures/records.mjs` is the record factory (`makeRecord(i, overrides)`,
`makeStashRecord(i, overrides)`, `videoIdFor(i)`, re-exported from
`fixtures/app.mjs` so a spec has one import). **The record shape is copied from
`js/api.js`, not invented** — `videoId, title, channelId, channelTitle,
publishedAt, thumbnailUrl, durationSeconds, embeddable, description`, plus
`state` (and `addedAt` + `channelAvatarUrl` for a stash record). Keep it in step
with `js/api.js` when that changes. Records are index-derived and ordered:
`publishedAt` ascends with `i`, so index 0 is the top card.

## The specs

- `tests/focus-nav.spec.mjs` — the two-pane keyboard navigation
  (`initQueueFocus` in `js/page-chrome.js`, driven from `onGlobalKeydown` in
  `js/subscriptions-page.js`): the ArrowUp/ArrowDown walk, the "Show all (N)"
  footer as the walk's last item, the clamp at both ends (which **places focus
  but does not `preventDefault`** — both halves matter), re-entry at the
  remembered card, resolving by `closest('.row')`, and `/` throwing focus
  between the panes. Plus the jump keys: PageUp/PageDown stepping
  `QUEUE_PAGE_STEP` walk items and landing the destination at the **top** of the
  pane, their clamp at both ends, the reported bug they fix (a PageDown from the
  second-to-last card with the bottom already in view must still advance),
  Home/End at the ends of the walk, all four declining inside the player pane and
  inside a text field, and the point of the whole thing — an ArrowDown after a
  PageDown continuing from the NEW position. These rules are emergent — a media
  query, real focus order, a windowed list and native scrolling — so none of them
  is reachable from the `node:assert` suites, and every one was got wrong at
  least once by reading the code alone.
- `tests/player-tab-order.spec.mjs` — **the player frame is out of the tab
  order** (`detachIframeFromTabOrder()` in `js/player.js`), run over BOTH player
  pages. The bug it locks down: `.workspace__player` is `tabindex="-1"`, so Tab
  from the pane fell into the cross-origin frame, `bindIframeFocusGuard` bounced
  focus to `<body>`, but Chrome's sequential-focus starting point stayed on the
  iframe — the next Tab re-entered and bounced again, forever. It covers the
  attribute being set at construction and surviving a video change, the verified
  Tab order through the island (now-playing title link → channel link → Like →
  1x/1.5x/2x → Skip → description timestamp → description URL — the title link
  leads because it is first in the DOM, and exists *because* the frame is out of
  the tab order), consecutive Tabs progressing rather
  than looping, Shift+Tab reversing, "Start the queue" being reachable with
  **nothing playing**, that a **click** on the video still bounces to `<body>`
  (the guard is untouched and must stay), and that `/` plus the arrow walk are
  unaffected. Needs `fixtures/fake-player.mjs` — see above for why a same-origin
  stub cannot test any of it.
- `tests/player-meta.spec.mjs` — the now-playing bar, over BOTH player pages:
  the title being a LINK (`renderPlayerTitle` in `js/ui.js` — right href/target/
  rel, the card's own `.row__title` class, an `<a>` *inside* the unchanged
  `<p id="player-title">`, gone again when nothing plays) and looking like the
  plain text it replaced (the stylesheet's bare `a { color: var(--accent) }` is
  one missing class away from turning it blue); plus the geometry underneath it
  — the bar flush with the video, the badge flush with the bar, the 6px flex gap
  to the `·`, and, the point of the file, **every focus ring in the pane landing
  inside the pane's clip box**. `.workspace__player` is a scroll container, so it
  clips at its padding box, and both those links sit on the content edge; the
  fix grows the pane's box 4px (padding plus an equal negative margin) so the
  clip edge moves and the content does not. Mutation-checked both ways: drop the
  padding and the ring tests fail, drop the negative margin and the geometry
  tests fail.
- `tests/card-visual.spec.mjs` — the visual baseline: a card plain / focused /
  now-playing / playing+focused / handled, the card's channel badge focused, the
  now-playing title idle and focused, the player-bar channel badge focused, and
  the player pane's focus ring.

All four run at 1280×800, i.e. the **side-by-side** layout. The stacked (≤900px)
layout has genuinely different arrow-key rules and would be a second project,
not a variation smuggled into these files.

### Screenshots

- **Baselines are local-only.** `.browser-tests/` is gitignored, so the PNGs
  under `tests/*.spec.mjs-snapshots/` are a development aid — "nothing moved
  since I last looked" — and never a shared contract. A fresh clone starts by
  generating its own; the first run reports *failed* with "A snapshot doesn't
  exist … writing actual", and the second run passes. A diff on a machine that
  has never run this before means nothing.
- **Disable animations with Playwright's built-in option**, `animations:
  'disabled'` (set once in the config's `expect.toHaveScreenshot`), not by
  injecting a `* { transition: none }` stylesheet — injected CSS changes the very
  rendering being baselined.
- **Shoot a clipped PAGE screenshot, not the element**, whenever a ring is
  involved. Both of this app's focus rings are painted *outside* the element's
  border box — `.row:focus` draws its ring as a `box-shadow` with no inset, and
  `.workspace__player` uses an outline with a **positive** `outline-offset` — and
  an element screenshot is clipped to the bounding box, so it crops the ring
  clean out. `shotWithMargin()` in `card-visual.spec.mjs` re-measures the box and
  clips the page around it with a 10px margin. An element shot would have made
  "focused" pixel-identical to "plain" and asserted nothing.
- **`:focus-visible` needs the KEYBOARD to have been the last interaction** — a
  bare `locator.focus()` does not match it. Chrome paints a focus-visible ring on
  a programmatic focus only when the most recent user interaction was a keypress,
  so any shot or measurement of one of those rings must press a key first
  (`focusVisibly()` in `card-visual.spec.mjs` and `player-meta.spec.mjs` does one
  `Tab`, then focuses). Get this wrong and the baseline is a picture of the
  *unfocused* element — the same silent-nothing failure as the element-shot trap
  above, and it caught this rig once already. `.row:focus` is the exception: it
  is plain `:focus` on purpose (see styles.css), so `card.focus()` is enough.
- **Determinism** comes from the pinned viewport / scale / colour scheme /
  timezone / locale in the config (a card prints a locale-formatted publish
  date), the local stub images, and index-derived record text. Fonts still come
  from the OS, so baselines do not travel between machines.
- The now-playing state is applied as the `row--playing` class directly, the way
  `markPlayingCard()` does — a real YouTube embed is neither offline-safe nor
  frame-stable, and the marker *is* that class.

## App-specific gotchas

- **Must be served over http.** `file://` fails twice over: ES-module CORS
  refuses it, and IndexedDB there is opaque-origin. The `webServer` block handles
  this; never open an HTML file directly.
- **IndexedDB seeding is required for anything past onboarding.** Without it you
  are testing the setup panel. `app.open()` is the only sanctioned way in.
- **`--virtual-time-budget` is unusable for this app.** Under headless Chrome's
  virtual time, IndexedDB callbacks never run, so the app never gets past its
  first store read — and CSS transitions do not advance either, which has
  previously produced a *passing* hit-test against an element that had not
  actually moved. Playwright's real-time auto-waiting is the replacement; do not
  reintroduce virtual time.
- **Focus events do work here.** Raw-CDP headless Chrome fires neither `focus`
  nor `focusin` unless `Emulation.setFocusEmulationEnabled` is sent first — which
  is what made an earlier hand-rolled CDP rig unable to test any of this.
  **Playwright sends it for us**; `document.hasFocus()` is true and `focusin`
  fires normally. `focus-nav.spec.mjs` *asserts* this rather than assuming it,
  because `initQueueFocus` remembers the current card from a `focusin` and would
  silently fall back to card 0 forever without it. If a future
  Playwright/Chrome combination regresses, fix it once in `fixtures/app.mjs`.
- **`document.body.focus()` does not blur anything** — `<body>` carries no
  `tabindex`, so it is a no-op. Use `document.activeElement.blur()` to reproduce
  where `bindIframeFocusGuard` puts focus after a click on the video.
- **A Tab trail parks on `<body>` exactly once, at the document boundary.** A
  headless page has no browser chrome to Tab into, so after the last focusable
  Chrome gives one press to `<body>` and the next lands on the document's first
  (`a.skip-link`). That single `BODY` is a wrap, not a trap — the way to tell
  them apart is what FOLLOWS it, which is what
  `player-tab-order.spec.mjs` asserts. Do not "assert no BODY ever".
- **The focus guard is asynchronous.** `bindIframeFocusGuard` runs off `window`
  blur through a `setTimeout(0)`, so the bounce to `<body>` lands a task after
  the click resolves. `expect.poll` it, or give each key press a small settle
  wait (`pressTrail` does).
- **Chrome ANIMATES a keyboard scroll.** Smooth scrolling is on by default, so
  the scroll a key triggers is not applied by the time the press resolves:
  measured in this rig, one native PageDown walked `.workspace__queue` from 0 to
  460px over **about nine frames** (`[0, 0, 24, 71, 141, 226, 311, 383, 432, 457,
  460, 460…]`). Never assert a scroll position by reading it once after
  `keyboard.press` — `expect.poll` it. A single `requestAnimationFrame` is not
  enough either, which is what killed an earlier design of the page keys (the app
  no longer depends on native scroll timing at all — it moves focus and lets the
  scroll follow — but a spec measuring geometry still does). Focus-driven scrolls
  are a different path and *are* instant here, since the stylesheet sets no
  `scroll-behavior: smooth`. Also beware `Math.round()` of a small negative
  overshoot: it yields `-0`, and `expect(-0).toBe(0)` **fails**.
- **A handled record seeded at the FRONT of the queue is deleted before the
  first render.** `init()` runs `cleanup()`, which prunes the whole handled
  prefix at or below the cutoff. That is the app working correctly. Mark cards
  mid-test instead of seeding them handled.
- **Seeded `publishedAt` must be after the floor** (`yqa_start_cutoff`), for the
  same reason. The fixture's `FLOOR_ISO` is a day before the first record.
- **The single-tab Web Lock is per origin.** Two `index.html` pages alive at once
  in the same browser and the second paints "another tab is already open" —
  hence `fullyParallel: false`. Separate workers are separate browsers, so
  parallel *files* are fine.
- **The repo is CRLF** (most files; `index.html` is the exception, and
  `core.autocrlf=true`). Any scripted or regex-driven edit to a committed file
  must match `\r?\n` or it silently no-ops — which has previously made a mutation
  test report false-green. Files inside `.browser-tests/` are not committed and
  need not care.

## When NOT to use this

Reach for it last, not first.

- **Anything pure belongs in the `node:assert` suites**, which stay the first
  stop: `node js/queue.test.mjs` and `node js/migrations.test.mjs`, run from the
  repo root, no framework and no dependencies. All of `js/queue.js` is pure by
  rule, and new pure logic goes there **with a matching test**. A browser test
  for something `computeCutoff` or `addToStash` could have answered is slower,
  flakier and worse documentation.
- **Reading the code beats automating it.** The single most valuable finding of
  the session that produced this rig was that `loading="lazy"` was *already*
  present on the card thumbnails — a fact no browser test would ever have
  surfaced, and which one `grep` did.
- **Do not use it to check something you can see by looking at the app.** Serve
  it (`python -m http.server 5173` from the repo root) and open it.
- Use it when the question is genuinely about **what the browser does**: real
  focus order, key handling, layout at a breakpoint, `preventDefault` behaviour,
  IndexedDB-backed rendering — or **what it draws**, when you are about to
  iterate on a visual detail and would otherwise be building comparison sheets
  by hand.

## House rules

1. **Never `git add .browser-tests/`.** Not the config, not the specs, not the
   snapshots. If it ever shows up in `git status`, the ignore is broken — fix the
   ignore, do not commit the folder.
2. **Never add a dependency to the app.** Nothing in `.browser-tests/` may be
   imported by anything under `js/`, and no `js/` module may grow an import that
   only the rig provides. The rig reads the app; the app does not know it exists.
3. **Never create a `package.json` at the repo root.** The only one is
   `.browser-tests/package.json`.
4. **Mirror app constants, do not import them.** `records.mjs` re-declares the
   IndexedDB identity and the localStorage keys rather than importing
   `js/config.js`, so the rig can never become a reason to change a module's
   shape. Keep the copies in step by hand.
5. Snapshots are yours alone. Do not treat a colleague's diff, or a CI's, as
   meaningful — there is no CI, and deploy is a push to `main`.
