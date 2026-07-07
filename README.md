# YouTube Queue

A purely client-side, single-page web app that turns your YouTube subscription
feed into a **burn-down queue**: the oldest unwatched upload since your chosen
cutoff is shown first, you mark each item **Watched** or **Not interested** (or
just let it play), and the app burns down a low-water-mark cutoff so handled
videos are eventually pruned and never come back. A built-in two-pane player lets
you watch without leaving the page.

> **Built by Claude.** This app was designed and built end to end by Claude
> (Anthropic's Claude Code, Opus) — from the initial architecture through every
> feature, refactor, and bug fix — working at its owner's direction. The whole
> codebase, including this README, is Claude's work.

- **No backend. No framework. No build step. No bundler.** Plain HTML, CSS, and
  ES modules.
- The only external network resources are:
  1. The Google Identity Services script (`https://accounts.google.com/gsi/client`).
  2. The YouTube IFrame Player API (`https://www.youtube.com/iframe_api`), for the
     on-page player.
  3. The YouTube Data API v3 (`https://www.googleapis.com/youtube/v3`).
- Your OAuth **access token lives in memory only** — it is never written to
  `localStorage` or IndexedDB. Only your **Client ID**, **cutoff**, and your local
  video records are stored locally. There is **no client secret and no API key**
  anywhere; the OAuth token authorizes every call.
- The OAuth scope is `https://www.googleapis.com/auth/youtube.force-ssl`. This
  grants **read** access (subscriptions, uploads, video details) **and** the
  ability to **like/unlike** a video (`videos.rate`), which powers the player's
  Like button. It is not `youtube.readonly`.

---

## Important: it must be served over http(s)

OAuth via Google Identity Services will **not** work if you open `index.html`
directly as a `file://` URL. You must serve the folder over `http://localhost`
and register that exact origin with Google (see below).

---

## 1. Create an OAuth 2.0 Client ID (Web application)

1. Go to the
   [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
   and create or select a project.
2. In **APIs & Services → Library**, enable the **YouTube Data API v3**.
3. Configure the **OAuth consent screen** (User type: External is fine). Add
   your own Google account under **Test users** (or publish the app). The scope
   used is `https://www.googleapis.com/auth/youtube.force-ssl` — it covers reading
   your subscriptions/uploads **and** liking videos from the player.
4. Back in **Credentials**, click **Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add the **exact** origin you will
     serve from, including the port, e.g.:

     ```text
     http://localhost:5173
     ```

     No path, no trailing slash. If you use a different port, register that one.
   - You do **not** need to set an Authorized redirect URI for the token model.
5. Click **Create** and copy the **Client ID** (it looks like
   `1234567890-abcdefg.apps.googleusercontent.com`).

The app's first-run setup panel shows the exact origin it is running on, so you
can copy it straight into "Authorized JavaScript origins".

---

## 2. Serve the folder over localhost

Pick one (run from inside this project directory):

```bash
# Python 3
python -m http.server 5173

# or Node
npx serve -l 5173

# or
npx http-server -p 5173
```

Then open:

```text
http://localhost:5173
```

Make sure the port matches the origin you registered in step 1.

---

## 3. First run

1. **Paste your Client ID** into the setup panel and save it (stored in
   `localStorage` under `yqa_client_id`).
2. **Pick a start cutoff** (defaults to 7 days ago). Everything published **at
   or before** this instant is treated as already handled and will never enter
   your queue. Saved under `yqa_start_cutoff`.
3. Click **Sign in** and approve the YouTube permission in the Google popup.
   Signing in only authorizes; it does **not** auto-fetch.
4. Click **Refresh (fetch newer)** to pull your subscriptions and their recent
   uploads into the queue.

---

## Using the queue

The main view is a **two-pane layout**: the queue on the left, an embedded player
on the right. On narrow screens the panes stack (player on top, queue below).

- The list is sorted **oldest → newest**. Work top-down.
- Each card shows the thumbnail (with a duration badge and a **SHORTS** badge for
  clips at or under the Shorts threshold — 90 seconds, a heuristic since the API
  exposes no `isShort` flag), the channel **avatar** and a **channel link**, and a
  **title that links to the video on YouTube**. Card buttons: **▶ Play**, per-card
  preferred-speed **1× / 2×**, **✓ Watched**, **✕ Not interested**.
- **Marking greys a card in place** — the list does not immediately prune or
  reshuffle, so rapid marking down the list stays stable. Marking again toggles
  back to `new`; the `u` key silently undoes the last mark.
- The queue renders the **first 100** cards by default with a **Show all (N)**
  button; auto-advance still runs over the full list, not just the rendered
  window.
- **Hide handled** toggles whether marked (watched / not-interested) videos stay
  visible (greyed) or are hidden from the list.
- **Refresh (fetch newer)** re-scans your subscriptions for anything newer than
  the current cutoff and appends it without duplicating or resetting items you
  already handled.

### The player

- **Play** a video in the embedded player via a card's thumbnail, its **▶**
  button, or **Enter** on the focused card.
- **Auto-advance:** when a video ends it is auto-marked **Watched** and the next
  **eligible** video plays automatically — the first still-`new` video after it,
  skipping **Not interested**, already-**Watched**, and **non-embeddable** videos.
  Non-embeddable videos open on YouTube instead of framing.
- **Skip to next** (⏭) marks the current video watched and advances, same path as
  auto-advance.
- **Resume:** your in-app watch position is remembered per video, so replaying
  resumes near where you left off (unless you were at the very start or end).
- **Like / unlike** (👍) writes to YouTube via `videos.rate`. The visual state is
  tracked **locally** (see Storage), so it is instant and survives reload with no
  extra fetch.
- **Playback speed** has three layers, applied by priority **per-card preferred →
  Default-speed setting → previous video's speed**:
  - The player's **1× / 1.5× / 2×** buttons set the current/live speed.
  - Each card's **1× / 2×** buttons set a *per-video preferred* speed.
  - The toolbar **Default speed** button cycles **off → 1× → 1.5× → 2× → off** and
    is applied to any video that has no per-card preference.

### Keyboard shortcuts

**Queue** (focus a card first with `j` / `k`):

- `j` / `k` — move focus to the previous / next card.
- `w` — mark the focused card **Watched**.
- `x` — mark the focused card **Not interested**.
- `u` — **undo** the last mark.
- `Enter` — **play** the focused card.
- `1` / `2` — set the focused card's **preferred speed** (1× / 2×).

**Player:**

- `Space` — play / pause.
- `←` / `→` — seek back / forward 5 seconds.
- `−` / `+` — step playback speed down / up through 1× / 1.5× / 2×.
- `n` — skip to next.
- `l` — like / unlike.
- `m` — mute / unmute.
- `f` — fullscreen.

### How the cutoff advances (the burn-down)

There are **two** boundary values:

- **Floor** (`yqa_start_cutoff`) — the deletion + fetch boundary. Everything at or
  before the floor is gone for good and is never re-fetched. The floor **only
  moves forward, during cleanup**.
- **Cutoff** (`yqa_cutoff`) — a live marker that tracks the boundary of the
  **contiguous run of handled videos** at the front of the queue. It moves
  **forward** as you mark videos off the front and **back** when you un-mark one
  inside that run. It stops at the first video still `new` — it never jumps past a
  still-unwatched older video, and it is **tie-safe** (a handled video sharing a
  timestamp with a still-`new` one never pulls the cutoff onto it).

Marking a video does **not** delete anything immediately; it only greys the card
and updates the live cutoff. **Cleanup** — the only place videos are deleted and
the floor advances — deletes every present video at or before the cutoff and
advances the floor to it. Cleanup runs in exactly three places: **on page load**,
**on refresh/sync**, and when you click **Trim front (N)** in the queue header
(the button shows how many videos it would remove).

Boundary rule: the comparison is strictly greater-than. A video with
`publishedAt > cutoff` is **in** the queue; `publishedAt == cutoff` is **out**.

---

## Quota notes

The app is deliberately quota-frugal and **never** uses `search.list`:

- `subscriptions.list` and `playlistItems.list` — **1 unit** per page. Uploads
  playlists are derived cheaply by replacing the leading `UC` of a channel id with
  `UU` (no extra call); the rare non-`UC` channel costs one `channels.list`.
- Per channel, paging stops as soon as it reaches a video at or older than your
  cutoff (uploads come newest-first), so a normal refresh is cheap.
- `videos.list?part=contentDetails,status` — batched **≤ 50 ids per call, 1 unit**
  each — backfills video **durations** (badges) and **embeddability**. Adding the
  `status` part is 0 extra quota.
- `videos.rate` (the Like button) — roughly **50 units** per like/unlike.
- Channel avatars ride along in the `subscriptions.list` snippets at **no extra
  quota**.
- The default daily quota is **10,000 units**. If you hit it you'll see a friendly
  "daily quota reached" message; it resets at midnight Pacific time.
- Individual channels that return 404 (deleted/hidden) are skipped without
  aborting the whole refresh.

---

## Data & privacy

- **Access token:** in memory only; discarded when you close/refresh the tab.
  Re-requested on demand and silently refreshed when a call returns 401 or the
  token is near expiry. Signing out revokes it with Google.
- **Persisted in `localStorage`:**
  - `yqa_client_id` — your OAuth Client ID.
  - `yqa_start_cutoff` — the floor (deletion/fetch boundary).
  - `yqa_cutoff` — the live handled-prefix cutoff marker.
  - `yqa_channels` — channel id → `{ title, avatarUrl }` map for avatars.
  - `yqa_playback_rate` — the current player speed.
  - `yqa_default_rate` — the Default-speed setting (absent when off).
  - `yqa_hide_marked` — the Hide-handled toggle.
  - `yqa_videos_fallback` — video records, **only** when IndexedDB is unavailable.
- **Persisted in IndexedDB:** your video records in database `yqa`, object store
  `videos`, keyed by `videoId` (falls back to `localStorage` if IndexedDB is
  unavailable). Each record holds: `videoId`, `title`, `channelId`,
  `channelTitle`, `publishedAt`, `thumbnailUrl`, `state` (`new` / `watched` /
  `not_interested`), `durationSeconds`, `embeddable`, `preferredRate`,
  `positionSeconds` (resume), and `liked`.
- The **like** state is stored **locally** and is never fetched back from YouTube,
  so a like/unlike you make directly on YouTube will **not** be reflected here.
- Nothing is ever sent to any server other than Google's.

To reset, use **Change Client ID** / **Change cutoff** in the toolbar, or clear
the site's storage in your browser dev tools.

---

## Project layout

```text
index.html          DOM skeleton + loads GIS, the IFrame API (via player.js), and js/app.js
styles.css          Light/dark, responsive two-pane styling; player container query
README.md           This file
js/config.js        Constants (API base, OAuth scope, storage keys, IndexedDB names, limits)
js/store.js         Persistence: IndexedDB video CRUD + localStorage for id/cutoff/settings/channels
js/auth.js          GIS token client: init, request/refresh/revoke, in-memory token
js/api.js           YouTube fetch: subscriptions, uploads, videos.list details, videos.rate; errors
js/queue.js         PURE queue logic (no browser globals; Node-importable & unit-testable)
js/queue.test.mjs   Node unit tests for js/queue.js (run: node js/queue.test.mjs)
js/player.js        YouTube IFrame Player API wrapper (load/play, rate, seek, resume, fullscreen)
js/ui.js            XSS-safe DOM building (cards, player meta) and state screens
js/toast.js         Top-right toast notifications (progress / success / error / info)
js/app.js           Wiring: auth → fetch → store → queue → ui/player, event binding, shortcuts
```

### Testing the pure logic in Node

`js/queue.js` references no browser globals, so it is imported directly by the
test file. Run the suite from the repo root:

```bash
node js/queue.test.mjs
```

It exercises the real exports. A minimal example using the current function names:

```js
// example.test.mjs
import assert from 'node:assert';
import {
  computeCutoff,
  videosToClean,
  computeQueue,
  computeVisible,
  effectiveRate,
} from './js/queue.js';

const recs = [
  { videoId: 'a', publishedAt: '2026-01-01T00:00:00Z', state: 'watched' },
  { videoId: 'b', publishedAt: '2026-01-02T00:00:00Z', state: 'not_interested' },
  { videoId: 'c', publishedAt: '2026-01-03T00:00:00Z', state: 'new' },
];
const floor = '2025-12-31T00:00:00Z';

// The cutoff advances across the contiguous handled prefix (a, b) and stops at c.
const cutoff = computeCutoff(recs, floor);
assert.equal(cutoff, '2026-01-02T00:00:00Z');

// Cleanup would delete everything at or before the cutoff (a, b).
assert.deepEqual(videosToClean(recs, cutoff).map((r) => r.videoId).sort(), ['a', 'b']);

// Queue = still-'new' videos strictly after the floor, oldest first.
assert.deepEqual(computeQueue(recs, floor).map((r) => r.videoId), ['c']);

// Render list = ALL in-window videos (any state), oldest first.
assert.deepEqual(computeVisible(recs, floor).map((r) => r.videoId), ['a', 'b', 'c']);

// Effective speed: per-card preferred > default > current.
assert.equal(effectiveRate(2, 1.5, 1), 2); // per-card wins
assert.equal(effectiveRate(undefined, 1.5, 1), 1.5); // default when no per-card
assert.equal(effectiveRate(undefined, null, 1), 1); // else the current rate

console.log('ok');
```

Run it with `node example.test.mjs`.

---

## Known limitations

- **Likes made on YouTube are not reflected here.** The like state is tracked
  locally (never fetched), so liking/unliking in the YouTube app or website won't
  show up on the card, and vice-versa is one-way (this app → YouTube).
- **Shorts** are detected by a **heuristic** (duration ≤ 90s) and merely badged —
  there is no separate Shorts filter, and the API exposes no true `isShort` flag,
  so the badge can be wrong for edge cases.
- **Resume** only covers **in-app** playback position (tracked by the embedded
  player); it does not sync with YouTube's own watch history.
- **Undo** is a **silent** revert of your most recent mark (`u`). It restores the
  video's previous state and rolls the live cutoff back, but a video already
  deleted by cleanup cannot be restored.
- **Non-embeddable** videos can't play in the on-page player and open on YouTube
  instead; auto-advance skips them.
- YouTube's uploads playlist can lag real-time by a short interval, so a very
  fresh upload may take a few minutes to appear on refresh.
- Concurrent use in multiple tabs shares the same IndexedDB; if a second tab holds
  an older DB version open, the app falls back to `localStorage` for that session.
</content>
</invoke>
