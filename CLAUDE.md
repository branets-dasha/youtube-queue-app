# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pure client-side, single-page "burn-down queue" for YouTube subscriptions: fetch videos from your subscriptions up to a moving cutoff, display them oldest→newest, and play/skip through them. Vanilla HTML/CSS/ES modules — **no build step, no framework, no bundler, no `package.json`, no `node_modules`**. The only runtime dependencies are three Google-hosted scripts (Google Identity Services, YouTube IFrame API, YouTube Data API v3).

## Working style — delegate, act as overseer

The repo owner wants Claude to act as an **orchestrator/overseer**, not do the hands-on work directly. For any non-trivial task — research, design, implementation, review, verification — **spawn subagents (Agent tool) or author a Workflow** rather than investigating and editing in the main thread. Keep the main thread for decisions, oversight, and concise reporting; have agents return compact structured results instead of pulling large file/output dumps into context. This was an explicit, standing instruction ("use agents and workflows for everything… keep your context clear and compact. you only oversee process").

- Default to delegating **even for seemingly small edits** — a one-line CSS tweak or a button reorder still goes to an agent. Reserve direct action for the truly trivial (reading a file to decide *what* to delegate, a single-line fix mid-conversation) — past drift happened by treating small tasks as exceptions.
- Still surface genuinely user-facing decisions (architecture, ambiguous requirements) via AskUserQuestion before a big build — the owner engages actively on those.
- Before each commit, inspect the staged diff — the owner makes their own manual edits. Commit the owner's manual edits under their name with **no** Claude co-author trailer; commit Claude's work **with** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Only commit/push when asked.

## Commands

**Run locally** — must be served over `http://localhost` (never `file://`; ES-module CORS and Google OAuth both require an http(s) origin). No build step; from the repo root:
```
python -m http.server 5173      # or: npx serve -l 5173
```
Then open `http://localhost:5173`. The served port must match an **Authorized JavaScript origin** on your OAuth Client ID (see OAuth setup in README.md — each user brings their own Client ID; there is no shared one, no API key, no client secret).

**Test:**
```
node js/queue.test.mjs
```
Plain Node `node:assert`, no test framework, zero dependencies. It runs every test top-to-bottom and throws on the first failure — there is **no filter/single-test runner**; to isolate one, comment out the others in the file. Only `js/queue.js` is tested because it is the only module with zero browser globals.

**Deploy:** GitHub Pages serves the repo root of `main` directly. There is no CI and no build/deploy step — **deployment = push to `main`**. Live at `https://branets-dasha.github.io/youtube-queue-app/`.

## Architecture

### The FLOOR vs live CUTOFF model (core domain concept)

Two distinct ISO timestamps, both in localStorage, are the heart of the app. Understand these before touching queue logic:

- **FLOOR** (`LS_START_CUTOFF` = `yqa_start_cutoff`) — the deletion + fetch boundary. **Moves forward only**, and only inside `cleanup()`. It is the lower bound for the render list, the queue count, and the per-channel lower bound when fetching.
- **CUTOFF** (`LS_CUTOFF` = `yqa_cutoff`) — the live "handled-prefix" marker shown in the stats. **Bidirectional**: `computeCutoff(records, floor)` recomputes it from scratch each call, so it advances as you mark the oldest videos handled and **retreats** when you un-mark one. Always `>= floor`.

`computeCutoff` walks the contiguous *handled* (`state !== 'new'`) prefix strictly after the floor and stops at the first `new` video. It is **tie-safe**: the returned cutoff is always strictly less than the earliest still-`new` video's `publishedAt`, so a handled video sharing a timestamp with a `new` one never pulls the cutoff onto it. Window membership is **strictly after** the cutoff.

`cleanup()` (in `app.js`) is the **only** place videos are deleted and the floor advances: it deletes every present record with `publishedAt <= cutoff`, then sets `floor = cutoff`. It runs in exactly three sites: page-load `init()` (prune-on-reload), after a refresh sync, and the "Trim front" button. Consequence: marked videos stay greyed *in place* (never reordered/removed) until the next cleanup prunes the whole handled prefix.

### Module layering (respect these boundaries)

Data flows `auth → api → store → queue → ui/app → player`. Each module owns one concern:

- `config.js` — constants only (storage keys, `API_BASE`, `OAUTH_SCOPE`, tunables).
- `auth.js` — Google Identity Services **token model**. Access token is **in-memory only, never persisted** (so sign-in re-approves on every fresh load); silently re-requested near expiry / on 401. Scope is `youtube.force-ssl` (read + `videos.rate` write for the Like button).
- `api.js` — `fetch` to the YouTube Data API v3, `Bearer` token, **no API key**. **`search.list` is never used** (too expensive). Uploads playlist id is derived with the **UC→UU trick** (`uploadsPlaylistId()` swaps the leading `UC` of a channelId for `UU`) — no API call. Channel avatars ride along free in `subscriptions.list`. `videos.list` is batched ≤50 ids/call. Errors are `ApiError` with a `kind` (`auth`/`quota`/`forbidden`/`notfound`/`network`/`http`). Quota is 10,000 units/day.
- `store.js` — video records in **IndexedDB** (`yqa` db, `videos` store, keyPath `videoId`), with a transparent localStorage fallback when IndexedDB is genuinely **unavailable** (private browsing, `open()` throws, or `onerror`). **Exception:** `onblocked` (another tab holds the DB open at a different schema version) does **not** fall back — the real data is in IndexedDB but inaccessible, so every video API throws `DbBlockedError` and `app.js` halts startup with a blocking full-screen error (`#blocked-overlay`) telling the user to close the other tabs and reload. Settings/floor/cutoff/channels/rates all in localStorage. `migrateStates()` runs on every read (normalizes any legacy non-`new` state → `skipped`).
- `queue.js` — **pure functions only** (see purity rule below). All the derivations: `computeCutoff`, `computeQueue`, `computeVisible`, `videosToClean`, `nextPlayable`, `incrementalSince`, `resumeStart`, `effectiveRate`, duration/shorts helpers.
- `ui.js` — XSS-safe DOM construction. `toast.js` — notifications.
- `player.js` — YouTube IFrame API wrapper; holds **no queue/app state** (callbacks wire it to `app.js`). Uses the **standard `youtube.com`** IFrame API, not `youtube-nocookie` (standard domain feeds watch history when signed in).
- `app.js` — the wiring/state hub (`state` object + `dom` refs); the only module that reaches into every layer. Owns event binding, all keyboard shortcuts, onboarding, `cleanup()`, `markVideo`, refresh orchestration.

### State & marking

`STATE_NEW='new'` vs `STATE_SKIPPED='skipped'` are the only states; **"handled" everywhere means `state !== 'new'`**. `computeQueue` (still-`new` after floor) drives the "Queued" count; `computeVisible` (all states after floor) is the render list. `markVideo` has **toggle** semantics (re-skipping reverts to `new`) except auto-mark-on-video-end which forces `skipped`. UI updates optimistically (grey in place, no re-render) then persists async, reverting on failure. `u` undoes the last mark.

### Player behavior

Auto-advance on `ENDED` marks the finished video `skipped` and plays `nextPlayable` (next later `new` **and embeddable** video; non-embeddable ones open on youtube.com). Watch position is polled every 5s and persisted for resume. Playback rate carries across videos via `effectiveRate` (per-video preferred > default-speed setting > current). Like is a `videos.rate` write; the liked flag is stored **locally only** and never fetched back.

### Refresh: "Fetch new" vs "Refresh all"

Both call the same `runRefresh(bound)`; only the per-channel lower bound differs — the floor for "Refresh all" (full), or `incrementalSince(records, floor, buffer)` for "Fetch new" (newest stored `publishedAt` minus a 6h buffer). Upsert-by-`videoId` preserves existing state; neither resets or duplicates. Known limit: "Fetch new" won't pull the back-catalog of a newly-subscribed channel — use "Refresh all".

## Conventions

- **`queue.js` must stay pure** — no `window`/`document`/`fetch`/`localStorage`/`IndexedDB` anywhere in it, so `queue.test.mjs` can import it under Node. New pure logic goes here **with a matching test**.
- **XSS-safe DOM** in `ui.js`/`toast.js` — all API-derived strings go through `textContent`/text nodes; never `innerHTML` for API data; ids go through `encodeURIComponent`.
- Keep the layering: persistence in `store.js`, network in `api.js`, DOM in `ui.js`, orchestration in `app.js`, `player.js` state-free.
- All localStorage keys are namespaced `yqa_`.
- The app **never auto-fetches** — signing in only authorizes; the user triggers fetches explicitly.

## Gotchas

- **Cross-origin iframe swallows keyboard/wheel/pointer events.** Clicking the video moves focus into the youtube.com iframe and kills document-level shortcuts (including Esc). `onWindowBlur` in `app.js` detects focus landing on the iframe and blurs it back — preserve this contract when touching focus/keyboard code.
- **Privacy curtain** (`#curtain`): wheel-down outside the queue raises a full-viewport overlay, wheel-up lifts it, Esc toggles. Disabled in the stacked layout ≤900px. Purely visual — it does not pause the player.
- All keyboard shortcuts live in `app.js` `onGlobalKeydown` (ignored while typing in inputs and for Ctrl/Cmd/Alt combos).
- Shorts detection is a duration ≤90s heuristic (badge only — the API exposes no isShort flag).
