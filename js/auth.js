// js/auth.js
//
// OAuth 2.0 via Google Identity Services (GIS) "token model".
//   - Uses google.accounts.oauth2.initTokenClient with the youtube.readonly
//     scope.
//   - The access token is kept in memory ONLY. It is never written to
//     localStorage / IndexedDB.
//   - Callers request a token on demand (Sign in), and the API layer can force
//     a silent refresh when a call returns 401 or the token is near expiry.
//
// No client secret and no API key are used anywhere: the OAuth access token
// authorizes every YouTube Data API call.

import { OAUTH_SCOPE, TOKEN_EXPIRY_MARGIN_MS } from './config.js';

let tokenClient = null; // google.accounts.oauth2 token client
let accessToken = null; // in-memory only
let tokenExpiresAt = 0; // epoch ms when the token expires
let currentClientId = null;

// Pending request bookkeeping so concurrent requestToken() calls share one
// GIS popup/callback instead of racing.
let pendingResolve = null;
let pendingReject = null;

/**
 * Return true once the GIS script has loaded and exposed google.accounts.
 */
export function isGisReady() {
  return (
    typeof google !== 'undefined' &&
    google.accounts &&
    google.accounts.oauth2 &&
    typeof google.accounts.oauth2.initTokenClient === 'function'
  );
}

/**
 * Wait (poll) until the GIS library is available. Rejects after `timeoutMs`.
 * @param {number} [timeoutMs=10000]
 * @returns {Promise<void>}
 */
export function waitForGis(timeoutMs = 10000) {
  if (isGisReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (isGisReady()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            'Google Identity Services failed to load. Check your network ' +
              'connection and that the page is served over http(s), not file://.'
          )
        );
      }
    }, 100);
  });
}

/**
 * Initialize (or re-initialize) the GIS token client for a given Client ID.
 * Safe to call multiple times; re-inits if the client id changed.
 * @param {string} clientId OAuth 2.0 Web-application Client ID
 */
export function initAuth(clientId) {
  if (!isGisReady()) {
    throw new Error('Google Identity Services is not loaded yet.');
  }
  if (tokenClient && currentClientId === clientId) {
    return; // already initialized for this client id
  }
  currentClientId = clientId;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: OAUTH_SCOPE,
    callback: handleTokenResponse,
    error_callback: handleTokenError,
  });
}

function handleTokenResponse(resp) {
  if (resp && resp.error) {
    const err = new Error(resp.error_description || resp.error);
    err.code = resp.error;
    settleReject(err);
    return;
  }
  accessToken = resp.access_token;
  // expires_in is in seconds; convert and store an absolute expiry instant.
  const expiresInMs = (Number(resp.expires_in) || 3600) * 1000;
  tokenExpiresAt = Date.now() + expiresInMs;
  settleResolve(accessToken);
}

function handleTokenError(err) {
  // GIS error_callback (e.g. popup closed / blocked).
  const e = new Error(
    (err && (err.message || err.type)) || 'Authorization was cancelled.'
  );
  e.code = (err && err.type) || 'auth_error';
  settleReject(e);
}

function settleResolve(value) {
  const r = pendingResolve;
  pendingResolve = null;
  pendingReject = null;
  if (r) r(value);
}

function settleReject(err) {
  const r = pendingReject;
  pendingResolve = null;
  pendingReject = null;
  if (r) r(err);
}

/**
 * Request an access token.
 * @param {object} [opts]
 * @param {boolean} [opts.interactive=true] Maps to the GIS `prompt` option:
 *        - interactive:true  -> prompt: ''     (reuse an existing grant, but
 *          allow GIS to show consent/select UI when interaction is needed).
 *        - interactive:false -> prompt: 'none' (fully silent refresh; no UI,
 *          rejects if user interaction would be required).
 * @returns {Promise<string>} the access token
 */
export function requestToken({ interactive = true } = {}) {
  if (!tokenClient) {
    return Promise.reject(
      new Error('Auth is not initialized. Provide a Client ID first.')
    );
  }
  if (pendingResolve) {
    // A request is already in flight; reject the new caller to avoid clobbering
    // GIS's single callback slot. Callers should await the original.
    return Promise.reject(new Error('A token request is already in progress.'));
  }

  return new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
    try {
      // prompt: '' asks GIS to reuse an existing grant silently when possible.
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (err) {
      settleReject(err);
    }
  });
}

/**
 * Return the current in-memory access token if it exists and is not within the
 * expiry margin; otherwise return null (caller should refresh).
 * @returns {string|null}
 */
export function getToken() {
  if (!accessToken) return null;
  if (Date.now() >= tokenExpiresAt - TOKEN_EXPIRY_MARGIN_MS) return null;
  return accessToken;
}

/**
 * True if we currently hold a usable (non-expired) token.
 * @returns {boolean}
 */
export function isSignedIn() {
  return getToken() !== null;
}

/**
 * True if the user has an ACTIVE authorized session this page-load — i.e. we
 * still hold an access token in memory, EVEN IF it is now within/after its
 * expiry margin. Unlike isSignedIn() (a currently-USABLE token), this stays true
 * across the token's ~1h expiry until sign-out/revoke (or an unrecoverable auth
 * failure) clears it. The UI derives its single "signed in" state from this so
 * the status label and the Like button never disagree as the token silently
 * ages: an expired token is refreshed on demand by the next API call
 * (getToken() -> ensureToken()), so keeping the session presented as signed-in
 * is safe.
 * @returns {boolean}
 */
export function hasSession() {
  return accessToken !== null;
}

/**
 * Ensure a valid token, refreshing silently if needed. If a silent refresh
 * fails and `interactiveFallback` is true, fall back to an interactive prompt.
 * @param {object} [opts]
 * @param {boolean} [opts.interactiveFallback=false]
 * @returns {Promise<string>}
 */
export async function ensureToken({ interactiveFallback = false } = {}) {
  const existing = getToken();
  if (existing) return existing;
  try {
    // Attempt a genuinely silent refresh first (prompt: 'none', no UI).
    return await requestToken({ interactive: false });
  } catch (err) {
    // Only escalate to an interactive prompt when the caller opted in.
    if (interactiveFallback) {
      return requestToken({ interactive: true });
    }
    throw err;
  }
}

/**
 * Forget the in-memory token (does not revoke the grant with Google).
 */
export function clearToken() {
  accessToken = null;
  tokenExpiresAt = 0;
}

/**
 * Revoke the current access token with Google and clear it locally.
 * @returns {Promise<void>}
 */
export function revoke() {
  return new Promise((resolve) => {
    if (accessToken && isGisReady() && google.accounts.oauth2.revoke) {
      google.accounts.oauth2.revoke(accessToken, () => {
        clearToken();
        resolve();
      });
    } else {
      clearToken();
      resolve();
    }
  });
}
