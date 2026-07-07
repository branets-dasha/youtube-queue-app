# YouTube Queue

A purely client-side, single-page web app that turns your YouTube subscription
feed into a **burn-down queue**: the oldest unwatched upload since your chosen
cutoff is shown first, you mark each item **Watched** or **Not interested**, and
the app advances a low-water-mark cutoff so handled videos are pruned and never
come back.

- **No backend. No framework. No build step. No bundler.** Plain HTML, CSS, and
  ES modules.
- The only external network resources are:
  1. The Google Identity Services script (`https://accounts.google.com/gsi/client`).
  2. The YouTube Data API v3 (`https://www.googleapis.com/youtube/v3`).
- Your OAuth **access token lives in memory only** — it is never written to
  `localStorage` or IndexedDB. Only your **Client ID** and **cutoff** are stored
  locally. There is **no client secret and no API key** anywhere.

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
   used is `https://www.googleapis.com/auth/youtube.readonly` (read-only).
4. Back in **Credentials**, click **Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, add the **exact** origin you will
     serve from, including the port, e.g.:

     ```
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

```
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
3. Click **Sign in**, approve the read-only YouTube permission in the Google
   popup, and the app fetches your subscriptions and their recent uploads.

---

## Using the queue

- The list is sorted **oldest → newest**. Work top-down.
- Each row has **Watched** and **Not interested** buttons.
- **Keyboard shortcuts:** `j` / `k` move focus between rows, `w` marks the
  focused row watched, `x` marks it not interested, `u` undoes your last action.
- **Refresh (fetch newer)** re-scans your subscriptions for anything newer than
  the current cutoff and appends it without duplicating or resetting items you
  already handled.

### How the cutoff advances (the burn-down)

After every action, the app walks your videos oldest-first and advances the
cutoff across the **contiguous run of handled videos** at the front of the
queue. It stops at the first video that is still `new` — it never jumps past a
still-unwatched older video. Everything at or before the new cutoff is pruned
from local storage. This keeps the store small and guarantees handled items do
not reappear on the next refresh.

Boundary rule: the comparison is strictly greater-than. A video with
`publishedAt > cutoff` is **in** the queue; `publishedAt == cutoff` is **out**.

---

## Quota notes

- The app uses only `subscriptions.list` and `playlistItems.list` (and, in the
  rare case of a non-`UC` channel id, one `channels.list`). Each page costs **1
  quota unit**. It **never** uses `search.list`.
- Uploads playlists are derived cheaply by replacing the leading `UC` of a
  channel id with `UU` — no extra API call.
- Per channel, paging stops as soon as it reaches a video at or older than your
  cutoff (uploads come newest-first), so a normal refresh is cheap.
- The default daily quota is **10,000 units**. If you hit it you'll see a
  friendly "daily quota reached" message; it resets at midnight Pacific time.
- Individual channels that return 404 (deleted/hidden) are skipped without
  aborting the whole refresh.

---

## Data & privacy

- **Access token:** in memory only; discarded when you close/refresh the tab.
  Re-requested on demand and silently refreshed when a call returns 401 or the
  token is near expiry.
- **Persisted locally:** your Client ID and cutoff (`localStorage`), and your
  video records with their state (`IndexedDB` database `yqa`, object store
  `videos`, keyed by `videoId`; falls back to `localStorage` if IndexedDB is
  unavailable).
- Nothing is ever sent to any server other than Google's.

To reset, use **Change Client ID** / **Change cutoff** in the toolbar, or clear
the site's storage in your browser dev tools.

---

## Project layout

```
index.html        DOM skeleton + loads GIS and js/app.js (module)
styles.css        Light/dark, responsive styling
README.md         This file
js/config.js      Constants (API base, scope, storage keys, IndexedDB names)
js/store.js       Persistence: IndexedDB video CRUD + localStorage for id/cutoff
js/auth.js        GIS token client: init, request/refresh/revoke, in-memory token
js/api.js         YouTube fetch: subscriptions + per-channel uploads, pagination, errors
js/queue.js       PURE queue logic (no browser globals; Node-importable & unit-testable)
js/ui.js          XSS-safe DOM building and state screens
js/app.js         Wiring: auth → fetch → store → queue → ui, event binding
```

### Testing the pure logic in Node

`js/queue.js` references no browser globals, so you can import it directly:

```js
// example.test.mjs
import assert from 'node:assert';
import {
  upsertVideos,
  computeQueue,
  advanceCutoff,
  sortAscending,
} from './js/queue.js';

const recs = [
  { videoId: 'a', publishedAt: '2026-01-01T00:00:00Z', state: 'watched' },
  { videoId: 'b', publishedAt: '2026-01-02T00:00:00Z', state: 'not_interested' },
  { videoId: 'c', publishedAt: '2026-01-03T00:00:00Z', state: 'new' },
];

// Cutoff advances across the contiguous handled prefix (a, b) and stops at c.
const { newCutoff, prunedIds } = advanceCutoff(recs, '2025-12-31T00:00:00Z');
assert.equal(newCutoff, '2026-01-02T00:00:00Z');
assert.deepEqual(prunedIds.sort(), ['a', 'b']);

// Queue = new & strictly after cutoff, oldest first.
assert.deepEqual(computeQueue(recs, newCutoff).map((r) => r.videoId), ['c']);

console.log('ok');
```

Run with `node example.test.mjs`.

---

## Known limitations

- **Undo** restores a video's previous state but does not roll the cutoff
  backward; if an item was already pruned it cannot be restored (you'll get a
  notice). Undo is intended for the most recent action.
- YouTube's uploads playlist can lag real-time by a short interval, so a very
  fresh upload may take a few minutes to appear on refresh.
- Shorts and regular uploads both appear (they share the uploads playlist);
  there is no separate Shorts filter.
- Concurrent use in multiple tabs shares the same IndexedDB; if a second tab
  holds an older DB version open, the app falls back to `localStorage` for that
  session.
