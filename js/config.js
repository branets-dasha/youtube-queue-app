// js/config.js
// Central configuration constants. No secrets or IDs are hardcoded here.

// YouTube Data API v3 base URL. Every request is authorized by the OAuth
// access token via an Authorization: Bearer header (no API key needed).
export const API_BASE = 'https://www.googleapis.com/youtube/v3';

// OAuth 2.0 scope. Read-only access to the signed-in user's YouTube account.
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Google Identity Services client library (loaded from index.html).
export const GIS_SRC = 'https://accounts.google.com/gsi/client';

// localStorage keys. All app keys are namespaced with the `yqa_` prefix.
export const LS_CLIENT_ID = 'yqa_client_id';
export const LS_START_CUTOFF = 'yqa_start_cutoff';
// Fallback video store key, used only when IndexedDB is unavailable.
export const LS_VIDEOS_FALLBACK = 'yqa_videos_fallback';

// IndexedDB configuration.
export const IDB_NAME = 'yqa';
export const IDB_VERSION = 1;
export const IDB_STORE_VIDEOS = 'videos';
export const IDB_KEYPATH = 'videoId';

// Paging size used for both subscriptions and playlistItems requests.
export const PAGE_SIZE = 50;

// Re-request the access token when it is within this many milliseconds of
// expiring, so an in-flight batch of requests does not fail mid-refresh.
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

// Valid video states.
export const STATE_NEW = 'new';
export const STATE_WATCHED = 'watched';
export const STATE_NOT_INTERESTED = 'not_interested';
