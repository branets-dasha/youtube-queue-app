// js/api.js
//
// YouTube Data API v3 access layer. Every request is a plain fetch() to
// https://www.googleapis.com/youtube/v3 with an Authorization: Bearer header
// carrying the in-memory OAuth access token. No API key is used.
//
// Cost awareness: subscriptions.list, playlistItems.list and videos.list each
// cost 1 quota unit per call (videos.list batches up to 50 ids/call, so fetching
// durations stays cheap). search.list is NEVER used.

import { API_BASE, PAGE_SIZE } from './config.js';
import { ensureToken, getToken, requestToken } from './auth.js';
import { uploadsPlaylistId, compareIso, parseIsoDuration } from './queue.js';

/**
 * Error thrown for API-level failures, carrying a machine-usable `kind`:
 *   'auth'      -> 401 / token problem (caller should re-auth)
 *   'quota'     -> 403 quotaExceeded / rateLimitExceeded
 *   'forbidden' -> other 403
 *   'notfound'  -> 404 (channel/playlist gone)
 *   'network'   -> fetch failed (offline, CORS, etc.)
 *   'http'      -> other non-2xx
 */
export class ApiError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Build a v3 request URL with query params.
 * @param {string} path e.g. 'subscriptions'
 * @param {Record<string,string|number>} params
 * @returns {string}
 */
function buildUrl(path, params) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Perform an authorized GET, transparently refreshing the token once on 401.
 * @param {string} path
 * @param {Record<string,string|number>} params
 * @returns {Promise<object>} parsed JSON body
 */
async function apiGet(path, params, _retried = false) {
  let token = getToken();
  if (!token) {
    token = await ensureToken();
  }

  const url = buildUrl(path, params);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  } catch (netErr) {
    throw new ApiError(
      `Network error contacting YouTube: ${netErr.message}`,
      'network',
      0
    );
  }

  if (resp.ok) {
    return resp.json();
  }

  // Non-2xx: classify.
  let body = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const reason =
    body && body.error && body.error.errors && body.error.errors[0]
      ? body.error.errors[0].reason
      : null;
  const apiMessage =
    (body && body.error && body.error.message) || resp.statusText || 'Error';

  if (resp.status === 401) {
    if (!_retried) {
      // Token likely expired/invalid: refresh once and retry silently.
      try {
        await requestToken({ interactive: true });
      } catch {
        throw new ApiError('Your session expired. Please sign in again.', 'auth', 401);
      }
      return apiGet(path, params, true);
    }
    throw new ApiError('Your session expired. Please sign in again.', 'auth', 401);
  }

  if (resp.status === 403) {
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') {
      throw new ApiError(
        'YouTube daily quota reached. Try again after the quota resets (midnight Pacific time).',
        'quota',
        403
      );
    }
    throw new ApiError(apiMessage, 'forbidden', 403);
  }

  if (resp.status === 404) {
    throw new ApiError(apiMessage, 'notfound', 404);
  }

  throw new ApiError(apiMessage, 'http', resp.status);
}

/**
 * Fetch ALL of the signed-in user's subscriptions.
 * Returns an array of { channelId, channelTitle, avatarUrl }. The avatar rides
 * along in snippet.thumbnails at NO extra quota cost.
 * @param {(fetched:number)=>void} [onProgress] called with running count
 * @returns {Promise<Array<{channelId:string, channelTitle:string, avatarUrl:string}>>}
 */
export async function getSubscriptions(onProgress) {
  const results = [];
  let pageToken = '';
  do {
    const data = await apiGet('subscriptions', {
      part: 'snippet',
      mine: 'true',
      maxResults: PAGE_SIZE,
      order: 'alphabetical',
      pageToken,
    });
    for (const item of data.items || []) {
      const snip = item.snippet || {};
      const channelId =
        snip.resourceId && snip.resourceId.channelId
          ? snip.resourceId.channelId
          : null;
      if (channelId) {
        results.push({
          channelId,
          channelTitle: snip.title || '',
          avatarUrl: channelAvatar(snip.thumbnails),
        });
      }
    }
    if (typeof onProgress === 'function') onProgress(results.length);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return results;
}

/**
 * Fetch a channel's uploaded videos NEWER than `cutoff`.
 *
 * playlistItems are returned newest-first, so we page until we hit an item
 * whose publish time is <= cutoff, then stop (everything after is older).
 *
 * @param {string} channelId
 * @param {string|null} cutoff ISO timestamp low-water mark (exclusive)
 * @param {string} [subscriptionTitle] fallback channel title
 * @returns {Promise<Array<object>>} video records (state omitted; assigned by queue upsert)
 */
export async function getChannelVideosSince(channelId, cutoff, subscriptionTitle) {
  const playlistId = uploadsPlaylistId(channelId);
  if (!playlistId) {
    // Rare: channel id not starting with "UC". Resolve its uploads playlist
    // via channels.list (costs 1 unit). Then recurse with a synthetic id.
    const resolved = await resolveUploadsPlaylist(channelId);
    if (!resolved) return [];
    return getChannelVideosByPlaylist(resolved, cutoff, channelId, subscriptionTitle);
  }
  return getChannelVideosByPlaylist(playlistId, cutoff, channelId, subscriptionTitle);
}

async function resolveUploadsPlaylist(channelId) {
  try {
    const data = await apiGet('channels', {
      part: 'contentDetails',
      id: channelId,
      maxResults: 1,
    });
    const item = (data.items || [])[0];
    if (
      item &&
      item.contentDetails &&
      item.contentDetails.relatedPlaylists &&
      item.contentDetails.relatedPlaylists.uploads
    ) {
      return item.contentDetails.relatedPlaylists.uploads;
    }
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'notfound') return null;
    throw err;
  }
  return null;
}

async function getChannelVideosByPlaylist(playlistId, cutoff, channelId, subscriptionTitle) {
  const records = [];
  let pageToken = '';
  let stop = false;

  do {
    const data = await apiGet('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: PAGE_SIZE,
      pageToken,
    });

    for (const item of data.items || []) {
      const snip = item.snippet || {};
      const cd = item.contentDetails || {};
      const videoId = cd.videoId || (snip.resourceId && snip.resourceId.videoId);
      // Prefer contentDetails.videoPublishedAt for the true publish time.
      const publishedAt = cd.videoPublishedAt || snip.publishedAt;

      if (!videoId || !publishedAt) continue;

      // Newest-first: once we reach the cutoff, everything after is older.
      if (cutoff && compareIso(publishedAt, cutoff) <= 0) {
        stop = true;
        break;
      }

      records.push({
        videoId,
        title: snip.title || '(untitled)',
        channelId,
        channelTitle: snip.videoOwnerChannelTitle || subscriptionTitle || '',
        publishedAt,
        thumbnailUrl: bestThumbnail(snip.thumbnails),
      });
    }

    pageToken = stop ? '' : data.nextPageToken || '';
  } while (pageToken);

  return records;
}

/**
 * Pick the best available thumbnail URL from a thumbnails object.
 * Prefers the LARGEST size (maxres > standard > high > medium > default) so the
 * stored URL stays sharp on the large 16:9 cards. ui.js additionally derives a
 * high-res URL from the video id at render time, so this mainly benefits the
 * onerror fallback and any future direct use of the stored URL.
 * @param {object|undefined} thumbnails
 * @returns {string}
 */
function bestThumbnail(thumbnails) {
  if (!thumbnails) return '';
  const order = ['maxres', 'standard', 'high', 'medium', 'default'];
  for (const key of order) {
    if (thumbnails[key] && thumbnails[key].url) return thumbnails[key].url;
  }
  // Any url we can find.
  for (const key of Object.keys(thumbnails)) {
    if (thumbnails[key] && thumbnails[key].url) return thumbnails[key].url;
  }
  return '';
}

/**
 * Pick a channel avatar URL from a subscriptions snippet.thumbnails object.
 * Prefers medium (240px) then default (88px) then high — ample for a small
 * circular avatar. Returns '' if none present.
 * @param {object|undefined} thumbnails
 * @returns {string}
 */
function channelAvatar(thumbnails) {
  if (!thumbnails) return '';
  for (const key of ['medium', 'default', 'high']) {
    if (thumbnails[key] && thumbnails[key].url) return thumbnails[key].url;
  }
  for (const key of Object.keys(thumbnails)) {
    if (thumbnails[key] && thumbnails[key].url) return thumbnails[key].url;
  }
  return '';
}

/**
 * Batch-fetch video details via videos.list?part=contentDetails,status, UP TO 50
 * ids per call (1 quota unit each — adding the `status` part is 0 extra quota).
 * Returns a Map videoId -> { durationSeconds, embeddable }. IDs the API omits
 * (deleted/private) are simply absent from the map; fields it omits are undefined.
 * @param {Array<string>} videoIds
 * @returns {Promise<Map<string, {durationSeconds:(number|undefined), embeddable:(boolean|undefined)}>>}
 */
export async function getVideoDetails(videoIds) {
  const out = new Map();
  const ids = Array.from(new Set((videoIds || []).filter(Boolean)));
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await apiGet('videos', {
      part: 'contentDetails,status',
      id: batch.join(','),
    });
    for (const item of data.items || []) {
      if (!item.id) continue;
      const cd = item.contentDetails || {};
      const st = item.status || {};
      out.set(item.id, {
        durationSeconds: cd.duration ? parseIsoDuration(cd.duration) : undefined,
        embeddable: typeof st.embeddable === 'boolean' ? st.embeddable : undefined,
      });
    }
  }
  return out;
}

/**
 * Classify a non-2xx response and throw an ApiError (no token retry). Shared by
 * the rating write call.
 * @param {Response} resp
 */
async function throwApiError(resp) {
  let body = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  const reason =
    body && body.error && body.error.errors && body.error.errors[0]
      ? body.error.errors[0].reason
      : null;
  const apiMessage =
    (body && body.error && body.error.message) || resp.statusText || 'Error';

  if (resp.status === 401) {
    throw new ApiError(
      'Your session expired or is missing a required permission.',
      'auth',
      401
    );
  }
  if (resp.status === 403) {
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') {
      throw new ApiError(
        'YouTube daily quota reached. Try again after the quota resets (midnight Pacific time).',
        'quota',
        403
      );
    }
    throw new ApiError(apiMessage, 'forbidden', 403);
  }
  if (resp.status === 404) throw new ApiError(apiMessage, 'notfound', 404);
  throw new ApiError(apiMessage, 'http', resp.status);
}

/**
 * Rate a video: POST videos/rate?id=<id>&rating=<like|none> (no body; 204 on
 * success). Quota ~50 units. Throws ApiError on failure — a 401/403 means the
 * write scope was not granted, so the caller should re-consent.
 * @param {string} videoId
 * @param {'like'|'none'} rating
 * @returns {Promise<void>}
 */
export async function rateVideo(videoId, rating) {
  let token = getToken();
  if (!token) token = await ensureToken();
  const url = buildUrl('videos/rate', { id: videoId, rating });
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch (netErr) {
    throw new ApiError(`Network error contacting YouTube: ${netErr.message}`, 'network', 0);
  }
  if (resp.ok) return; // 204 No Content
  await throwApiError(resp);
}

/**
 * Get the signed-in user's rating for a video: GET videos/getRating?id=<id>.
 * Returns 'like' | 'dislike' | 'none' | 'unspecified'. Quota 1 unit.
 * @param {string} videoId
 * @returns {Promise<string>}
 */
export async function getVideoRating(videoId) {
  const data = await apiGet('videos/getRating', { id: videoId });
  const item = (data.items || [])[0];
  return item && item.rating ? item.rating : 'none';
}
