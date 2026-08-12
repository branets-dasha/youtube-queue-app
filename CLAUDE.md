# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A pure client-side, single-page "burn-down queue" for YouTube subscriptions: fetch videos from your subscriptions up to a moving cutoff, display them oldest→newest, and play/skip through them. Vanilla HTML/CSS/ES modules — **no build step, no framework, no bundler, no `package.json`, no `node_modules`**. The only runtime dependencies are three Google-hosted scripts (Google Identity Services, YouTube IFrame API, YouTube Data API v3).

## Working style — delegate, act as overseer

The repo owner wants Claude to act as an **orchestrator/overseer**, not do the hands-on work directly. For any non-trivial task — research, design, implementation, review, verification — **spawn subagents (Agent tool) or author a Workflow** rather than investigating and editing in the main thread. Keep the main thread for decisions, oversight, and concise reporting; have agents return compact structured results instead of pulling large file/output dumps into context. This was an explicit, standing instruction ("use agents and workflows for everything… keep your context clear and compact. you only oversee process").

- Default to delegating **even for seemingly small edits** — a one-line CSS tweak or a button reorder still goes to an agent. Reserve direct action for the truly trivial (reading a file to decide *what* to delegate, a single-line fix mid-conversation) — past drift happened by treating small tasks as exceptions.
- Still surface genuinely user-facing decisions (architecture, ambiguous requirements) via AskUserQuestion before a big build — the owner engages actively on those.
- Before each commit, inspect the staged diff — the owner makes their own manual edits. Commit the owner's manual edits under their name with **no** Claude co-author trailer; commit Claude's work **with** a `Co-Authored-By: Claude <model name and context window> <noreply@anthropic.com>` trailer naming the model actually running the session. Only commit/push when asked.

## Commands

**Run locally** — must be served over `http://localhost` (never `file://`; ES-module CORS and Google OAuth both require an http(s) origin). No build step; from the repo root:
```
python -m http.server 5173      # or: npx serve -l 5173
```
Then open `http://localhost:5173`. The served port must match an **Authorized JavaScript origin** on your OAuth Client ID (see OAuth setup in README.md — each user brings their own Client ID; there is no shared one, no API key, no client secret).

**Test:**
```
node js/queue.test.mjs
node js/migrations.test.mjs
```
Two suites, both plain Node `node:assert`, no test framework, zero dependencies. Each runs every test top-to-bottom and throws on the first failure — there is **no filter/single-test runner**; to isolate one, comment out the others in the file. Only `js/queue.js` and `js/migrations.js` are tested because they are the only modules with no browser globals at import time (`migrations.js` touches `localStorage` inside one function body, which its tests stub).

**Deploy:** GitHub Pages serves the repo root of `main` directly. There is no CI and no build/deploy step — **deployment = push to `main`**. Live at `https://branets-dasha.github.io/youtube-queue-app/`.

## Issue tracking

Issues live in **Linear**, not GitHub Issues — the repo is on GitHub and deploys from it via Pages, but never reach for `gh issue create`.

- One team in the workspace: **Owls**, key `OWL`, id `53f5e1c0-f1b2-464c-a707-7b99f24b7b1a` — nothing to disambiguate, don't enumerate teams.
- Default project: **YouTube Queue**, id `3f52fab5-8f05-4643-a31e-ce393556c45d` (`https://linear.app/branets-dasha/project/youtube-queue-4b1b3b8b9ad0`); new issues default to it and to the **Backlog** state unless told otherwise.
- The ids are recorded here so `list_teams`/`list_projects` are **not** re-queried every time — go straight to creating the issue.
- The Linear MCP `save_issue` create is **not idempotent**, and a `502 upstream_unavailable` can still have created the issue — if a create appears to fail, search for it before retrying (a blind retry produced duplicates OWL-10 / OWL-11 on 2026-08-09).

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
- `store.js` — video records in **IndexedDB** (`yqa` db, `videos` store, keyPath `videoId`). **IndexedDB is required — there is no localStorage fallback for videos.** Three triggers in `openDb()` mean genuinely **unavailable** — no `indexedDB` global, `indexedDB.open()` throws, or `req.onerror` — and each sets a sticky module flag, after which every video API throws `DbUnavailableError` and `app.js` halts startup with a blocking full-screen error naming the likely causes (site data blocked for this origin, corrupt DB, full disk). **Distinct case:** `onblocked` (another tab holds the DB open at a different schema version) — the real data is in IndexedDB but inaccessible, so every video API throws `DbBlockedError` and `app.js` halts startup with a blocking full-screen error (`#blocked-overlay`, shared by both via `showFatalStorageError`) telling the user to close the other tabs and reload. The open success path installs `db.onversionchange` (a future schema upgrade started by another tab): it closes this connection and flips the same sticky blocked flag, so the other tab's upgrade is never blocked and subsequent video APIs here throw `DbBlockedError`. The **third** setter of that same flag is the exported `standDownForOtherTab()` — called only by `app.js`'s single-tab guard (below), it sets `dbBlocked` and closes this connection, deliberately reusing the flag rather than adding a fourth one: the condition is identical (the data is there, this page must not touch it, close the other tab and reload), so no new guard lines are needed. All four video APIs run the same two guards in the same order — `dbBlocked` **before** `dbUnavailable` — because an aborted blocked upgrade can set both flags and "close the other tab(s)" is then the actionable message. Settings/floor/cutoff/channels/speeds all in localStorage (`getPlaybackSpeed`/`setPlaybackSpeed` for `yqa_playback_speed`, `getDefaultSpeed`/`setDefaultSpeed` for `yqa_default_speed`), plus `loadChannelPrefs()`/`saveChannelPrefs()` for `yqa_channel_prefs` (an empty map removes the key). Holds **no migration logic of its own**: the read paths are plain parse/`getAll`, and `getAllVideos()` — still the only video read path — hands its result to `migrateVideos()` from `migrations.js`.
- `migrations.js` — **every** data migration, so retiring them later is deleting this file plus its three call sites (`store.js` `getAllVideos()`, `app.js` `init()`, `channels-page.js` `init()`). No browser globals at import time, so `migrations.test.mjs` imports it under Node; `localStorage` is touched only inside one function body. Exports exactly three, all idempotent, all tolerant of malformed entries: `migrateVideos(records)` — record shape, run on **every** IndexedDB read (mutates + returns, nothing written back, so no `IDB_VERSION` bump — the next `putVideos` persists the new shape). `migrateChannelPrefs(prefs)` — the same per channel-prefs entry, in memory (an entry a migration leaves with no properties is dropped: it reads identically to an absent one). `migrateLocalStorage()` — the one-shot on-load pass **both** entry points run before anything reads prefs, and the only one that rewrites storage **on disk** (write only if the shape changed; empty map removes the key), so the read paths stay plain parses; never throws when storage is unavailable. **Documentation convention:** a function's JSDoc states only its general contract, while each individual migration is a date-marked `// YYYY-MM-DD — <name>: …` comment inside the body and is explained **nowhere else** — retiring one is deleting its block plus its tests; the file goes when the last block does. Imports `config.js` only — **never `store.js`**, which imports it.
- `queue.js` — **pure functions only** (see purity rule below). All the derivations: `computeCutoff`, `computeQueue`, `computeVisible`, `videosToClean`, `nextPlayable`, `incrementalSince`, `resumeStart`, `effectiveSpeed`, `applyChannelSpeeds`, `mergeRefresh`, duration/shorts helpers.
- `ui.js` — XSS-safe DOM construction. `toast.js` — notifications.
- `player.js` — YouTube IFrame API wrapper; holds **no queue/app state** (callbacks wire it to `app.js`). Uses the **standard `youtube.com`** IFrame API, not `youtube-nocookie` (standard domain feeds watch history when signed in).
- `app.js` — the wiring/state hub (`state` object + `dom` refs); the only module that reaches into every layer. Owns event binding, all keyboard shortcuts, onboarding, `cleanup()`, `setVideoState`/`toggleSkip`, refresh orchestration, and the **single-tab guard** (see Gotchas) — the sole user of the `yqa_tab` Web Lock.
- `channels-page.js` — entry point for the standalone **`channels.html`** page (the channel list, opened from the toolbar's "Channels" link — plain same-tab navigation, with a "← Back to the queue" link back to `index.html`): channels alphabetically with per-channel prefs — an Ignore toggle and a preferred-speed toggle mirroring the card 1× / 1.5× / 2× buttons. Imports only `config`/`store`/`queue`/`ui` — **never `app.js`** (importing it boots the whole app). No auth, no API calls, and it **never writes video records** (multi-tab safe): it only reads `loadChannels()` and reads/writes `yqa_channel_prefs` (`LS_CHANNEL_PREFS`; shape `{ [channelId]: { ignored?: true, speed?: number } }`, only non-default values stored — pure helpers `sortChannels`/`setChannelPref`/`isChannelIgnored`/`channelPreferredSpeed` live in `queue.js`).

### State & marking

`STATE_NEW='new'` vs `STATE_SKIPPED='skipped'` are the only states; **"handled" everywhere means `state !== 'new'`**. There is **no state normalization on read** — it was safe to delete because nothing anywhere compares `=== STATE_SKIPPED` (it is only ever a value *written*; every read is `=== 'new'` or `!== 'new'`), so a legacy `watched`/`not_interested` record already behaves exactly like `skipped`. `computeQueue` (still-`new` after floor) drives the "Queued" count; `computeVisible` (all states after floor) is the render list. Marking is **two functions**: `setVideoState(videoId, nextState, opts)` does the actual work and **never toggles** — it sets the state as given; `toggleSkip(videoId, opts)` is the Skip button / `x` key wrapper that picks `rec.state !== STATE_NEW ? STATE_NEW : STATE_SKIPPED` (so **any** handled value returns to `new` in one press) and delegates. Auto-mark-on-video-end calls `setVideoState` directly and always SETS `skipped`. UI updates optimistically (grey in place, no re-render) then persists async, reverting on failure. `u` undoes the last mark.

### Player behavior

Auto-advance on `ENDED` marks the finished video `skipped` and plays `nextPlayable` (next later `new` **and embeddable** video; non-embeddable ones open on youtube.com). Watch position is polled every 5s and persisted for resume. Playback speed carries across videos via `effectiveSpeed` (per-video preferred > default-speed setting > current), applied through `player.js`'s `setSpeed`/`getSpeed`. Like is a `videos.rate` write; the liked flag is stored **locally only** and never fetched back.

### Refresh: "Fetch new" vs "Refresh all"

Both call the same `runRefresh(bound, sweepSpeeds)`; only two things differ — the per-channel lower bound (the floor for "Refresh all" (full), or `incrementalSince(records, floor, buffer)` for "Fetch new": newest stored `publishedAt` minus a 6h buffer) and the channel-speed sweep flag (see below). Upsert-by-`videoId` preserves existing state; neither resets or duplicates. Known limit: "Fetch new" won't pull the back-catalog of a newly-subscribed channel — use "Refresh all".

Per-channel prefs (`yqa_channel_prefs`, edited on `channels.html`) are read **fresh inside `runRefresh`** — never cached at startup — so edits made in a Channels tab apply to the next fetch without reloading the main tab. Ignored channels are skipped entirely in the per-channel loop (no uploads request at all — saves quota; their existing records are untouched).

A refresh is also the **only** channel-pruning site (`pruneStaleChannels` → the pure `pruneChannels` in `queue.js`, called after the merge **and** the post-sync `cleanup()`, so it sees that refresh's final record set): a `yqa_channels` entry — and its `yqa_channel_prefs` entry — is dropped only when the channel is **both** absent from the freshly-fetched subscriptions **and** has zero stored records, so an unsubscribed channel with videos still queued keeps its avatar/title and drops on a later refresh once they drain. The sweep covers the **union** of both maps (deduped, channels keys first), so an **orphan** prefs entry — one with no `yqa_channels` entry, from a hand edit or from before pruning existed — is judged by those same two conditions rather than lingering forever; each map is written only when it actually changed, since a prune can touch just one. **An empty (or non-array) subs list prunes nothing** — that reads as a failed fetch, not as "unsubscribed from everything" — and the prune never runs on the `init()` or "Trim front" cleanup paths, which have no subs list. It is silent (no toast) and re-reads the prefs fresh at the prune site.

The whole merge lives in the pure `mergeRefresh(existing, incoming, prefs, { sweepSpeeds })` in `queue.js`: it upserts, then applies each channel's `speed` via `applyChannelSpeeds(records, prefs, onlyVideoIds)` — applied to the **merged** set, so brand-new arrivals are included. `mergeAndPersist` in `app.js` is only `mergeRefresh` + one write + `recompute`, so `queue.test.mjs` exercises the real composition rather than a mirror of it. The rule is **fill-if-absent**: a record whose `preferredSpeed` is unset (`undefined` *or* `null`) and whose channel has a speed gets it; a record with an explicit per-video speed is **never** overwritten or cleared; ignored channels are excluded.

**How far the fill reaches depends on the refresh mode**, passed explicitly as `runRefresh(bound, sweepSpeeds)` — never inferred from the bound:

- **"Refresh all"** (`sweepSpeeds = true` → `onlyVideoIds = null`) sweeps the **whole stored record set**, so older already-stored videos get the channel's speed too.
- **"Fetch new"** (`sweepSpeeds = false`) passes only the videoIds this fetch **newly inserted** (computed inside `mergeRefresh` as incoming ids minus the **stored** ids — the merged set no longer tells arrivals apart). It doesn't touch the older part of the queue, so it doesn't re-speed it either — videos re-returned inside the 6h buffer window count as already-stored and keep what they have.

Either way it stays one write — `mergeRefresh(...)` then a single `putVideos`. `mergeAndPersist` has one call site per exit path — normal completion, and the quota-abort branch that merges what it has and then throws — so exactly one of them runs per refresh, and both derive the scope the same way from `sweepSpeeds`. Known limits (accepted): after un-ignoring a channel, "Fetch new" won't backfill videos published while it was ignored — use "Refresh all"; and toggling a card's speed OFF just removes `preferredSpeed` (`onCardSpeed` sets it to `undefined`, with no "cleared by user" marker), so a later **"Refresh all"** re-applies the channel speed to that video ("Fetch new" does not).

## Conventions

- **`queue.js` must stay pure** — no `window`/`document`/`fetch`/`localStorage`/`IndexedDB` anywhere in it, so `queue.test.mjs` can import it under Node. New pure logic goes here **with a matching test**.
- **XSS-safe DOM** in `ui.js`/`toast.js` — all API-derived strings go through `textContent`/text nodes; never `innerHTML` for API data; ids go through `encodeURIComponent`.
- Keep the layering: persistence in `store.js`, network in `api.js`, DOM in `ui.js`, orchestration in `app.js`, `player.js` state-free.
- All localStorage keys are namespaced `yqa_`.
- The app **never auto-fetches** — signing in only authorizes; the user triggers fetches explicitly.

## Gotchas

- **Cross-origin iframe swallows keyboard/wheel/pointer events.** Clicking the video moves focus into the youtube.com iframe and kills document-level shortcuts (including Esc). `onWindowBlur` in `app.js` detects focus landing on the iframe and blurs it back — preserve this contract when touching focus/keyboard code.
- **Privacy curtain** (`#curtain`): wheel-down outside the queue covers the page with a full-viewport overlay, wheel-up lifts it, Esc toggles. In the stacked layout (≤900px) scroll-down no longer covers (it would fight page scrolling), but scroll-up still lifts and Esc still toggles. Purely visual — it does not pause the player.
- **Single-tab guard** (`app.js` only): one named Web Lock (`yqa_tab`), so only one `index.html` tab runs — the newly-opened tab yields, the holder is never interrupted. `init()` requests it `ifAvailable` at the top and awaits the answer at its checkpoint, immediately after `cacheDom()` — before the store read, the settings restores and `bindEvents()`; not granted → `standDownForOtherTab()` + halt behind the shared `#blocked-overlay`, having read no videos, written nothing and bound no handlers. `cacheDom()` is the checkpoint's only prerequisite: `showFatalStorageError` needs just those refs and wires its Reload button inline. The grant is held for the document's lifetime by a callback promise that never settles (so `request()` never settles either — the answer comes out through a separate promise), and the browser releases it when the document dies. Race-free by construction: no handshake, no simultaneous-open window, and a frozen background tab still holds its lock. A superseded tab binds no shortcuts at all (the checkpoint precedes `bindEvents()`), so there is nothing live behind the overlay; `standDownForOtherTab()` stays as depth-in-defense, making any write that somehow ran throw rather than persist. Decided once at startup — no mid-session halt, nothing to do about the player. `channels.html` never asks for the lock (it writes no video records, so it may be open alongside). **Fails open, never closed:** without `navigator.locks`, or if the request throws, the tab boots normally — the guard must never lock the owner out of their own queue.
- All keyboard shortcuts live in `app.js` `onGlobalKeydown` (ignored while typing in inputs and for Ctrl/Cmd/Alt combos).
- Shorts detection is a duration ≤90s heuristic (badge only — the API exposes no isShort flag).
