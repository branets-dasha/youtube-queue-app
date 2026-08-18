// js/config.js
// Central configuration constants. No secrets or IDs are hardcoded here.

// YouTube Data API v3 base URL. Every request is authorized by the OAuth
// access token via an Authorization: Bearer header (no API key needed).
export const API_BASE = 'https://www.googleapis.com/youtube/v3';

// OAuth 2.0 scope. youtube.force-ssl authorizes BOTH the app's reads
// (subscriptions, playlistItems, videos, getRating) AND writes (videos.rate —
// the player's Like button). Access tokens are memory-only and re-requested, so
// the next sign-in grants the scope; a rate call that hits 401/403 triggers a
// fresh interactive consent.
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

// Google Identity Services client library (loaded from index.html and
// stash.html).
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

// localStorage keys. All app keys are namespaced with the `yqa_` prefix.
export const LS_CLIENT_ID = 'yqa_client_id';
// FLOOR: deletion + fetch boundary (moves forward only, on cleanup). Reuses the
// original start-cutoff key so existing installs migrate seamlessly.
export const LS_START_CUTOFF = 'yqa_start_cutoff';
// CUTOFF: live handled-prefix marker (updates on mark/unmark; always >= floor).
export const LS_CUTOFF = 'yqa_cutoff';
// Persisted channel map (channelId -> { title, avatarUrl }) for card avatars.
export const LS_CHANNELS = 'yqa_channels';
// Per-channel preferences (channelId -> { ignored?: true, speed?: number }),
// edited on channels.html. Only non-default values are stored. Read FRESH at
// refresh time (never cached at startup): ignored channels are skipped in the
// fetch loop; a speed fills preferredSpeed on the records a fetch newly inserts,
// and on "Refresh all" over every stored record of that channel that has none
// (an explicitly-set per-video speed is never overwritten).
export const LS_CHANNEL_PREFS = 'yqa_channel_prefs';
// Persisted player playback speed (one of 1 / 1.5 / 2). Source of truth + default.
export const LS_PLAYBACK_SPEED = 'yqa_playback_speed';
export const DEFAULT_PLAYBACK_SPEED = 1;
// Persisted DEFAULT-speed setting for newly played videos (one of 1 / 1.5 / 2, or
// absent/null = unset). Distinct from LS_PLAYBACK_SPEED (the live/current speed):
// this is the fallback applied to a video that has no per-video preferredSpeed.
export const LS_DEFAULT_SPEED = 'yqa_default_speed';
// Persisted "hide handled (skipped) videos" view toggle. Default off.
export const LS_HIDE_MARKED = 'yqa_hide_marked';

// Web Lock names (NOT storage keys) for the single-tab guards. Each PAGE that
// WRITES an object store takes its own lock: a second tab of that same page
// cannot get it and stands down, while a tab of the OTHER page may stay open
// alongside, because the two never write each other's store — index.html owns
// `videos`, stash.html owns `stash`. channels.html writes no video records and
// asks for neither.
export const TAB_LOCK = 'yqa_tab';
export const STASH_TAB_LOCK = 'yqa_stash_tab';

// IndexedDB configuration.
export const IDB_NAME = 'yqa';
// Bumped 1 -> 2 to add the `stash` object store. A tab still running v1 code
// holds the database open at v1 and BLOCKS this upgrade — and is itself stood
// down by its `onversionchange` — so the changeover costs every user exactly one
// "close the other tabs and reload" screen, once.
export const IDB_VERSION = 2;
export const IDB_STORE_VIDEOS = 'videos';
// The manually-curated Stash queue. SAME keyPath and the same record shape as
// `videos`, plus `addedAt` and `channelAvatarUrl`. A SEPARATE object store so the
// two queues can never collide on a videoId and the two pages write disjoint
// data.
export const IDB_STORE_STASH = 'stash';
export const IDB_KEYPATH = 'videoId';

// Paging size used for both subscriptions and playlistItems requests.
export const PAGE_SIZE = 50;

// Max number of queue CARDS rendered by default — a pure display window. All
// videos are still fetched/stored and auto-advance runs over the full list; only
// the rendered cards are limited. "Show all" reveals the rest for the session.
// This is the single source of truth (and the default for a future user setting).
export const QUEUE_DISPLAY_LIMIT = 100;

// Re-request the access token when it is within this many milliseconds of
// expiring, so an in-flight batch of requests does not fail mid-refresh.
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// Safety buffer for the INCREMENTAL refresh ("Refresh new"): its per-channel
// lower bound is (newest stored publishedAt − this), clamped to the floor. The
// buffer covers YouTube's uploads-playlist lag so a video that appeared slightly
// out of order isn't missed. Tunable. Default: 6 hours.
export const INCREMENTAL_REFRESH_BUFFER_MS = 6 * 60 * 60 * 1000;

// A video whose length is at most this many seconds is treated as a "Short".
// Heuristic only — the API exposes no isShort flag.
export const SHORTS_MAX_SECONDS = 90;

// Resume thresholds for a stored watch position: a position must be more than
// this many seconds in to be worth resuming at all, and — when the duration is
// known — at least this many seconds before the end, so we never resume at the
// tail. Otherwise playback starts from the beginning.
export const RESUME_MIN_SECONDS = 5;
export const RESUME_END_MARGIN_SECONDS = 15;

// Valid video states. Within the app everything that's not STATE_NEW is considered
// "handled" (skipped).
export const STATE_NEW = 'new';
export const STATE_SKIPPED = 'skipped';
