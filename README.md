# YouTube Queue

**Live app: <https://branets-dasha.github.io/youtube-queue-app/>**

A purely client-side, single-page web app that turns your YouTube subscription feed into a chronological queue that plays in succession.

 Features:

- Loads all videos from your subscriptions back to a chosen cutoff point.
- Plays videos in a built-in YouTube player, automatically advancing through the queue.
- Videos can be marked to skip, or play at a certain speed.
- Advances the cutoff as the videos are watched or skipped, so handled videos are eventually pruned and never come back.
- Remembers the watch position per video.
- Keyboard support.
- Data is stored locally. Nothing is sent to any server other than Google's.

> **Built by Claude.** This app was designed and built end to end by Claude (Anthropic's Claude Code, Opus) — from the initial architecture through every feature, refactor, and bug fix — working at its owner's direction. The whole codebase is Claude's work.

Anyone can use this app **hosted at <https://branets-dasha.github.io/youtube-queue-app/>** or host it wherever they please.

No backend. No framework. No build step. No bundler. Plain HTML, CSS, and ES modules.

The only external network resources are:

  1. The Google Identity Services script (`https://accounts.google.com/gsi/client`).
  2. The YouTube Data API v3 (`https://www.googleapis.com/youtube/v3`), for loading subscriptions and enabling "like" button.
  3. The YouTube IFrame Player API (`https://www.youtube.com/iframe_api`), for the on-page player.

To use the app you need to provide your own Google OAuth Client ID (see below). Your OAuth **access token lives in memory only** — it is never written to `localStorage` or IndexedDB. There is **no client secret and no API key** anywhere; the OAuth token authorizes every call.

The OAuth scope is `https://www.googleapis.com/auth/youtube.force-ssl` ("see, edit, and permanently delete your YouTube videos, ratings, comments and captions"). Such a permissive scope is needed to enable the "like" button. All the other operations the app does using YouTube Data API are read-only.

## Part 1 — For users: using the hosted app

The app runs entirely in your browser, but YouTube still needs to know *which* OAuth app is contacting the API on your behalf. Google does not allow a single shared Client ID for an app like this, so **each user brings their own** Client ID from their own free Google Cloud project. The setup is a bit complicated, but you only need to do it once.

### 1. Create your OAuth 2.0 Client ID (Web application)

1. Go to the [Google Cloud Console](https://console.cloud.google.com) and create or select a project (the button next to "Google Cloud").
2. Go to **APIs and services → Library**, enable the **YouTube Data API v3**.
3. Got to **OAuth consent screen** and configure it (User type: **External** is fine). In the **Audience** tab add your own Google account under **Test users**. In the **Data access** tab add the scope `https://www.googleapis.com/auth/youtube.force-ssl` — it covers reading your subscriptions/uploads **and** liking videos from the player.
4. Go to the **Clients** tab and create a new client.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add **exactly**:

     ```text
     https://branets-dasha.github.io
     ```

   - You do **not** need to set an Authorized redirect URI for the token model.
5. Click **Create** and copy the **Client ID** (it looks like `1234567890-abcdefg.apps.googleusercontent.com`).

### 2. First run

1. Open **<https://branets-dasha.github.io/youtube-queue-app/>**.
2. **Paste your Client ID** into the setup panel and save it. The panel shows the exact origin it is running on, so you can confirm it matches what you registered.
3. **Pick a start cutoff** (defaults to 7 days ago). Everything published **at or before** this instant is treated as already handled and will never enter your queue.
4. Click **Sign in** and approve the YouTube permission in the Google popup. Because the app is unverified and the scope is sensitive, Google shows a **"Google hasn't verified this app"** screen — click **Advanced → continue**. Signing in only authorizes; it does **not** auto-fetch.
   - Since the OAuth token is **memory-only**, you'll re-approve on each fresh load of the page.
5. Click **Refresh (fetch newer)** to pull your subscriptions and their recent uploads into the queue. The app does not auto-refresh, so you'll need to use this button manually whenever you want to re-scan your subscriptions. It will append newer videos without duplicating or resetting items you already handled.

### Connect the player to your YouTube account (optional)

The embedded video player is a **cross-origin YouTube iframe** (from `youtube.com`), so it's a *third party* relative to the app's own origin. By default, modern browsers' tracking prevention / third-party-cookie blocking stops that iframe from seeing your YouTube login: the player runs **signed-out**, so it doesn't register the videos as watched by your account, and if you have YouTube Premium you'll still see ads.

This is separate from signing into the app. **Signing in** with Google OAuth only authorizes the **Data API** (your subscriptions, marking, likes) — it does **not** sign the *player* in. Whether the player recognizes your account and Premium depends entirely on whether your browser lets the `youtube.com` iframe use its cookies as a third party.

This step is **optional** — playback works without it. It only affects account-connected / Premium (ad-free) playback, and it only relaxes protection for **this one site**; tracking prevention stays on everywhere else. To connect the player, allow YouTube's third-party cookies for the app:

- **Edge:** turn **off** Tracking prevention for `https://branets-dasha.github.io` — via the site-info / shield icon in the address bar, or **Settings → Privacy, search, and services → Tracking prevention → Exceptions**. Alternatively, allow-list `[*.]youtube.com` under cookies.
- **Chrome / others:** allow **third-party cookies** for the site — via the cookie / tune icon in the address bar — or add a site exception for `[*.]youtube.com`.

### Quota notes

Each YouTube Data API call spends quota units associated with your Client. The default daily quota is **10,000 units**. If you hit it you'll see a friendly "daily quota reached" message; it resets at midnight Pacific time.

The app is deliberately quota-frugal and **never** uses `search.list`:

- `subscriptions.list` and `playlistItems.list` — **1 unit** per page. Upload playlists are derived cheaply by replacing the leading `UC` of a channel id with `UU` (no extra call); the rare non-`UC` channel costs one `channels.list`.
- Per channel, paging stops as soon as it reaches a video at or older than your cutoff (uploads come newest-first), so a normal refresh is cheap.
- `videos.list?part=contentDetails,status` — batched **≤ 50 ids per call, 1 unit** each — backfills video **durations** (badges) and **embeddability**. Adding the `status` part is 0 extra quota.
- `videos.rate` (the Like button) — roughly **50 units** per like/unlike.
- Channel avatars ride along in the `subscriptions.list` snippets at **no extra quota**.

### Data & privacy

- **Access token:** in memory only; discarded when you close/refresh the tab. Re-requested on demand and silently refreshed when a call returns 401 or the token is near expiry. Signing out revokes it with Google.
- **Persisted in `localStorage`:**
    - `yqa_client_id` — your OAuth Client ID.
    - `yqa_start_cutoff` — the floor (deletion/fetch boundary).
    - `yqa_cutoff` — the live handled-prefix cutoff marker.
    - `yqa_channels` — channel id → `{ title, avatarUrl }` map for avatars.
    - `yqa_playback_rate` — the current player speed.
    - `yqa_default_rate` — the Default-speed setting (absent when off).
    - `yqa_hide_marked` — the Hide-handled toggle.
    - `yqa_videos_fallback` — video records, **only** when IndexedDB is unavailable.
- **Persisted in IndexedDB:** your video records in database `yqa`, object store `videos`, keyed by `videoId` (falls back to `localStorage` if IndexedDB is unavailable). Each record holds: `videoId`, `title`, `channelId`, `channelTitle`, `publishedAt`, `thumbnailUrl`, `state` (`new` / `skipped`), `durationSeconds`, `embeddable`, `preferredRate`, `positionSeconds` (resume), and `liked`.
- The **like** state is stored **locally** and is never fetched back from YouTube, so a like/unlike you make directly on YouTube will **not** be reflected here.
- Nothing is ever sent to any server other than Google's.

To reset, use **Change Client ID** / **Change cutoff** in the toolbar, or clear the site's storage in your browser dev tools.

### Known limitations

- **Likes made on YouTube are not reflected here.** The like state is tracked locally (never fetched), so liking/unliking in the YouTube app or website won't show up in the app, and vice-versa is one-way (this app → YouTube).
- **Shorts** are detected by a **heuristic** (duration ≤ 90s) and merely badged — there is no separate Shorts filter, and the API exposes no true `isShort` flag, so the badge can be wrong for edge cases.
- **Resume** only covers **in-app** playback position (tracked by the embedded player); it does not sync with YouTube's own watch history.
- **Undo** is a **silent** revert of your most recent mark (`u`). It restores the video's previous state and rolls the live cutoff back, but a video already deleted by cleanup cannot be restored.
- **Non-embeddable** videos can't play in the on-page player and open on YouTube instead; auto-advance skips them.
- YouTube's uploads playlist can lag real-time by a short interval, so a very fresh upload may take a few minutes to appear on refresh.
- Concurrent use in multiple tabs shares the same IndexedDB; if a second tab holds an older DB version open, the app falls back to `localStorage` for that session.

## Part 2 — For developers: running it yourself

### Serving locally

There is **no build step** — it's static HTML, CSS, and ES modules — but OAuth via Google Identity Services will **not** work if you open `index.html` directly as a `file://` URL. You must serve the folder over `http://localhost`.

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

For **local development**, register your localhost origin instead of the hosted one: in your OAuth client's **Authorized JavaScript origins**, add `http://localhost:5173` (or whichever port you serve on — `localhost` is a valid OAuth origin). Make sure the port matches. You can register both the localhost origin and the `https://branets-dasha.github.io` origin on the same Client ID.

### Project layout

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

`js/queue.js` references no browser globals, so it is imported directly by the test file. Run the suite from the repo root:

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
  { videoId: 'a', publishedAt: '2026-01-01T00:00:00Z', state: 'skipped' },
  { videoId: 'b', publishedAt: '2026-01-02T00:00:00Z', state: 'skipped' },
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

Run it with `node example.test.mjs`. </content>
