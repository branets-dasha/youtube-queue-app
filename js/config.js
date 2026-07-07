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

// Google Identity Services client library (loaded from index.html).
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

// localStorage keys. All app keys are namespaced with the `yqa_` prefix.
export const LS_CLIENT_ID = 'yqa_client_id';
// FLOOR: deletion + fetch boundary (moves forward only, on cleanup). Reuses the
// original start-cutoff key so existing installs migrate seamlessly.
export const LS_START_CUTOFF = 'yqa_start_cutoff';
// CUTOFF: live handled-prefix marker (updates on mark/unmark; always >= floor).
export const LS_CUTOFF = 'yqa_cutoff';
// Fallback video store key, used only when IndexedDB is unavailable.
export const LS_VIDEOS_FALLBACK = 'yqa_videos_fallback';
// Persisted channel map (channelId -> { title, avatarUrl }) for card avatars.
export const LS_CHANNELS = 'yqa_channels';
// Persisted player playback rate (one of 1 / 1.5 / 2). Source of truth + default.
export const LS_PLAYBACK_RATE = 'yqa_playback_rate';
export const DEFAULT_PLAYBACK_RATE = 1;

// IndexedDB configuration.
export const IDB_NAME = 'yqa';
export const IDB_VERSION = 1;
export const IDB_STORE_VIDEOS = 'videos';
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

// Valid video states.
export const STATE_NEW = 'new';
export const STATE_WATCHED = 'watched';
export const STATE_NOT_INTERESTED = 'not_interested';
