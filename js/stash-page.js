// js/stash-page.js
//
// Entry point for the Stash page (stash.html): a second, HAND-CURATED queue,
// filled one pasted YouTube link at a time. Same cards, same player and the
// same marking gesture as the subscriptions queue, and deliberately a SIBLING
// of subscriptions-page.js rather than a subclass of it — importing that module
// would boot the whole other page.
//
// What it does NOT have, and why it is the smaller file: no fetching (nothing
// arrives by subscription), no FLOOR/CUTOFF (the order is arrival order, so
// there is no position-based window to keep), no stats panel, no hide-marked
// filter and no jump-to-last-skipped. "Skip" is called REMOVE here, and the
// Clean up button deletes every marked record from ANYWHERE in the list — the
// state-based stashToClean, not the prefix-based videosToClean. The same sweep
// runs on every reload, before the first paint.

import {
  STATE_NEW,
  STATE_SKIPPED,
  QUEUE_DISPLAY_LIMIT,
  DEFAULT_PLAYBACK_SPEED,
  STASH_TAB_LOCK,
} from './config.js';
import { migrateLocalStorage } from './migrations.js';
import {
  getClientId,
  setClientId,
  getAllStashVideos,
  putStashVideo,
  deleteStashVideos,
  loadChannels,
  loadChannelPrefs,
  getPlaybackSpeed,
  setPlaybackSpeed,
  getDefaultSpeed,
  setDefaultSpeed,
  standDownForOtherTab,
  DbBlockedError,
  DbUnavailableError,
} from './store.js';
import {
  waitForGis,
  initAuth,
  requestToken,
  ensureToken,
  hasSession,
  clearToken,
  revoke,
} from './auth.js';
import { getVideosByIds, getChannelAvatars, rateVideo, ApiError } from './api.js';
import {
  parseVideoId,
  sortStash,
  stashToClean,
  addToStash,
  firstPlayable,
  nextPlayable,
  resumeStart,
  effectiveSpeed,
} from './queue.js';
import {
  showStatus,
  hideStatus,
  renderQueue,
  renderPlayerMeta,
  renderDescription,
  setCardState,
  setCardSpeed,
  setVisible,
} from './ui.js';
import {
  initPlayer,
  loadVideo as playerLoad,
  setSpeed as playerSetSpeed,
  capturePosition,
  togglePlay,
  seekBy,
  seekTo,
  toggleMute,
  requestFullscreen,
  getIframe as getPlayerIframe,
} from './player.js';
import { showToast } from './toast.js';
import {
  requestTabLock,
  showBlockedError,
  showDbUnavailableError,
  showSupersededError,
  showDbReadError,
  reportIfFatalDb,
  initCurtain,
  bindIframeFocusGuard,
} from './page-chrome.js';

// ---------------------------------------------------------------------------
// Application state (in-memory)
// ---------------------------------------------------------------------------

const state = {
  clientId: null,
  records: [], // the whole stash, kept sorted by sortStash (oldest addedAt first)
  channels: {}, // channelId -> { title, avatarUrl }; READ-ONLY here (never written)
  booted: false, // the store read + settings restore have run once this load
  adding: false, // an add is in flight (guards the form AND the token request)
  lastAction: null, // { videoId, prevState } for undo
  playing: null, // videoId currently loaded in the on-page player
  playerInited: false,
  playerCaughtUp: false, // TEXT-selector only: playback stopped because the stash ran out
  speed: 1, // player playback speed (1 / 1.5 / 2)
  defaultSpeed: null, // default-speed setting for new videos (1 / 1.5 / 2 or null = unset)
  showAll: false, // render window: false = first QUEUE_DISPLAY_LIMIT cards (in-memory only)
};

// Privacy curtain controls, from page-chrome.js's initCurtain(); it owns the
// covering flag, so `state` does not mirror it. Set in bindEvents().
let curtain = null;

// GIS is prepared once per load, keyed by the Client ID it was prepared FOR, so
// "Change Client ID" mid-session re-initializes the token client instead of
// authorizing against the old one.
let authReadyFor = null;

// DOM references, populated in init().
const dom = {};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Single-tab guard, first thing: this page owns the `stash` object store, so
  // it takes its OWN lock (STASH_TAB_LOCK) — a subscriptions tab writes a
  // different store and may stay open alongside.
  const tabLockGranted = requestTabLock(STASH_TAB_LOCK);

  // The overlay is all a superseded tab needs: page-chrome resolves
  // #blocked-overlay by id and wires its Reload button inline, never through
  // bindEvents(). Caching the refs here keeps the checkpoint below the only
  // thing separating a live tab from a superseded one.
  cacheDom();

  // Single-tab CHECKPOINT, as early as that prerequisite allows. Nothing above
  // it touches storage or binds a handler, so a tab that did not get the lock
  // paints the overlay having read no records, written nothing (in particular:
  // having run NO remove-sweep) and bound no shortcuts. standDownForOtherTab()
  // stays as depth — anything that somehow reached the store must throw rather
  // than persist.
  if (!(await tabLockGranted)) {
    standDownForOtherTab();
    showSupersededError();
    return;
  }

  bindEvents();

  // Show the current origin in the setup instructions so the user can copy the
  // exact "Authorized JavaScript origins" value.
  if (dom.originHint) dom.originHint.textContent = window.location.origin;

  state.clientId = getClientId();
  if (!state.clientId) {
    // First run on this browser: this page is self-sufficient, so the Client ID
    // is collected right here and bootApp() resumes from onSaveClientId.
    openSetupPanel();
    return;
  }

  await bootApp();
}

/**
 * The rest of startup, once a Client ID exists: load the stash, restore the
 * shared player settings, sweep everything marked Remove, then reveal the app.
 * Re-entrant — "Change Client ID" routes back through here, and the one-time
 * load is guarded by state.booted so it never runs twice.
 */
async function bootApp() {
  if (!state.booted) {
    // One-shot on-load storage migrations (what they do lives in migrations.js).
    // Runs before anything reads channel prefs (the add flow is the only reader).
    migrateLocalStorage();

    // Load the stash up front. EVERY rejection is FATAL: an empty store is not
    // an error (getAll() resolves [] on a first run), so a rejection always means
    // the store is unusable — and continuing would show an empty stash and then
    // write over rows that may still be in the DB. Each case HALTS startup
    // behind the shared full-screen error, BEFORE the sweep below deletes
    // anything.
    try {
      state.records = sortStash(await getAllStashVideos());
    } catch (err) {
      if (err instanceof DbBlockedError) showBlockedError();
      else if (err instanceof DbUnavailableError) showDbUnavailableError();
      else showDbReadError(err);
      return;
    }

    // Channel avatars/titles from the subscriptions side, read-only: a stash
    // record carries its OWN channelAvatarUrl (which wins in buildAvatar), so
    // this is only a fallback for records whose channel is also subscribed.
    state.channels = loadChannels();

    // Restore the persisted playback speed and DEFAULT-speed setting. Both keys
    // are SHARED with the subscriptions page — one global player setting.
    const storedSpeed = getPlaybackSpeed();
    state.speed = [1, 1.5, 2].includes(storedSpeed) ? storedSpeed : DEFAULT_PLAYBACK_SPEED;
    playerSetSpeed(state.speed);
    const storedDefault = getDefaultSpeed();
    state.defaultSpeed = [1, 1.5, 2].includes(storedDefault) ? storedDefault : null;
    updateDefaultSpeedButton();

    // The on-reload sweep: everything marked Remove is deleted BEFORE the first
    // render, so a removed card never flashes on screen. Same implementation as
    // the Clean up button (see sweepRemoved).
    try {
      await sweepRemoved();
    } catch (err) {
      // The only await is deleteStashVideos(), so a throw here is a fatal DB
      // condition — it must surface, not be swallowed. Memory is already pruned,
      // so the next reload re-reads and re-sweeps.
      reportIfFatalDb(err);
    }

    state.booted = true;
  }

  showMainApp();
  ensurePlayer();
  render();
}

function cacheDom() {
  const byId = (id) => document.getElementById(id);
  dom.setupPanel = byId('setup-panel');
  dom.clientIdInput = byId('client-id-input');
  dom.saveClientIdBtn = byId('save-client-id-btn');
  dom.originHint = byId('origin-hint');
  dom.setupError = byId('setup-error');

  dom.appMain = byId('app-main');
  dom.signinBtn = byId('signin-btn');
  dom.signoutBtn = byId('signout-btn');
  dom.authStatus = byId('auth-status');
  dom.defaultSpeedBtn = byId('default-speed-btn');
  dom.changeClientBtn = byId('change-client-btn');

  dom.addForm = byId('stash-add-form');
  dom.urlInput = byId('stash-url-input');
  dom.addBtn = byId('stash-add-btn');
  dom.addStatus = byId('stash-add-status');

  dom.cleanupBtn = byId('cleanup-btn');
  dom.scrollPlayingBtn = byId('scroll-playing-btn');

  dom.queueList = byId('queue-list');
  dom.emptyState = byId('empty-state');
  dom.curtain = byId('curtain');

  // Player pane. The pane itself is the scroll container (selected by class,
  // there's no id) so a new video can reset it to the top.
  dom.playerPane = document.querySelector('.workspace__player');
  dom.playerTitle = byId('player-title');
  dom.playerMeta = byId('player-meta');
  dom.playerDescription = byId('player-description');
  dom.playerBar = byId('player-bar');
  dom.playerEmpty = byId('player-empty');
  dom.playerEmptyText = byId('player-empty-text');
  dom.startQueueBtn = byId('start-queue-btn');
  dom.speed1x = byId('speed-1x');
  dom.speed15x = byId('speed-15x');
  dom.speed2x = byId('speed-2x');
  dom.skipBtn = byId('skip-btn');
  dom.likeBtn = byId('like-btn');
}

function bindEvents() {
  dom.saveClientIdBtn.addEventListener('click', onSaveClientId);
  dom.clientIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSaveClientId();
  });

  dom.signinBtn.addEventListener('click', onSignIn);
  dom.signoutBtn.addEventListener('click', onSignOut);
  dom.changeClientBtn.addEventListener('click', openSetupPanel);
  if (dom.defaultSpeedBtn) dom.defaultSpeedBtn.addEventListener('click', onCycleDefaultSpeed);

  // A real <form>, so Enter submits for free; the handler preventDefault()s.
  if (dom.addForm) dom.addForm.addEventListener('submit', onAddSubmit);
  // Typing clears the last inline message (and any invalid marking) — no timers.
  if (dom.urlInput) dom.urlInput.addEventListener('input', clearAddStatus);

  if (dom.cleanupBtn) dom.cleanupBtn.addEventListener('click', onCleanup);
  if (dom.scrollPlayingBtn) dom.scrollPlayingBtn.addEventListener('click', onScrollToPlaying);

  if (dom.speed1x) dom.speed1x.addEventListener('click', () => onSpeed(1));
  if (dom.speed15x) dom.speed15x.addEventListener('click', () => onSpeed(1.5));
  if (dom.speed2x) dom.speed2x.addEventListener('click', () => onSpeed(2));
  if (dom.startQueueBtn) dom.startQueueBtn.addEventListener('click', onStartQueue);
  if (dom.skipBtn) dom.skipBtn.addEventListener('click', onSkipNext);
  if (dom.likeBtn) dom.likeBtn.addEventListener('click', onLike);

  document.addEventListener('keydown', onGlobalKeydown);

  // The curtain binds its own wheel handler and keeps its own covering flag; Esc
  // stays here, in onGlobalKeydown, because page-chrome owns no shortcuts. The
  // defaults ('.workspace', <=900px, cover on wheel-down) are right for this
  // page: it IS the 100dvh `app-active` two-pane layout.
  curtain = initCurtain({ node: dom.curtain });

  // Clicking the video moves keyboard focus INTO the cross-origin player iframe,
  // which swallows keydown so the page's shortcuts (incl. the Esc curtain) stop
  // firing — page-chrome hands it back on window blur.
  bindIframeFocusGuard(getPlayerIframe);

  // Save the current watch position on hide/unload so a reload can resume.
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });

  // Safety net: never let an async failure vanish silently.
  window.addEventListener('unhandledrejection', (event) => {
    handleError(event.reason);
  });
}

// ---------------------------------------------------------------------------
// Setup panel (Client ID) + app routing
// ---------------------------------------------------------------------------

function openSetupPanel() {
  setVisible(dom.setupPanel, true);
  setVisible(dom.appMain, false);
  document.body.classList.remove('app-active'); // onboarding scrolls normally
  if (state.clientId) dom.clientIdInput.value = state.clientId;
  dom.clientIdInput.focus();
}

function onSaveClientId() {
  const value = dom.clientIdInput.value.trim();
  if (!value) {
    showStatus(dom.setupError, 'Please paste your OAuth Client ID.', 'error');
    return;
  }
  // Light sanity check: Web-application client ids look like
  // NNN-xxxx.apps.googleusercontent.com
  if (!/\.apps\.googleusercontent\.com$/.test(value)) {
    showStatus(
      dom.setupError,
      'That does not look like a Web-application Client ID (it should end in ".apps.googleusercontent.com"). Saving anyway.',
      'error'
    );
  } else {
    hideStatus(dom.setupError);
  }
  setClientId(value);
  state.clientId = value;
  setVisible(dom.setupPanel, false);
  bootApp();
}

function showMainApp() {
  setVisible(dom.setupPanel, false);
  setVisible(dom.appMain, true);
  document.body.classList.add('app-active'); // two-pane full-height layout
  updateAuthUi();
  // The URL field is deliberately NOT focused at load: it would swallow the
  // j / k / x shortcuts before the user ever pressed one.
}

function updateAuthUi() {
  // SINGLE source of truth for every auth-gated indicator: the status label, the
  // sign in/out buttons and the Like button all derive from hasSession() (an
  // active authorized session), NOT from live-token validity — a token silently
  // expires ~1h in while the session stays alive (the next API call refreshes it
  // on demand). The Add button is NOT gated: adding a link signs you in.
  const signed = hasSession();
  dom.authStatus.textContent = signed ? 'Signed in' : 'Not signed in';
  dom.authStatus.classList.toggle('is-signed-in', signed);
  setVisible(dom.signinBtn, !signed);
  setVisible(dom.signoutBtn, signed);
  updateLikeButton(); // re-evaluate: signing out disables it (visual liked stays)
}

/**
 * Prepare Google Identity Services for the CURRENT Client ID, once per load.
 * Keyed by the id rather than a bare boolean so "Change Client ID" mid-session
 * re-initializes the token client (initAuth is itself idempotent per id).
 */
async function ensureAuthReady() {
  if (authReadyFor === state.clientId) return;
  await waitForGis();
  initAuth(state.clientId);
  authReadyFor = state.clientId;
}

async function onSignIn() {
  try {
    await ensureAuthReady();
    await requestToken({ interactive: true });
    updateAuthUi();
  } catch (err) {
    handleError(err);
    updateAuthUi();
  }
}

async function onSignOut() {
  await revoke();
  updateAuthUi();
  showToast('Signed out.', { type: 'info' });
}

// ---------------------------------------------------------------------------
// Add a video (the ONLY way records enter the stash)
//
// Feedback is INLINE, on #stash-add-status, never a toast: the message belongs
// next to the field it is about, and it is cleared by the next keystroke rather
// than by a timer. Toasts stay for events with no field (Clean up, sign-out).
// ---------------------------------------------------------------------------

/** Write an inline message under the add field (no-op without the node). */
function setAddStatus(message, kind) {
  if (!dom.addStatus) return;
  showStatus(dom.addStatus, message, kind);
}

/** Clear the inline message AND the field's invalid marking (on input). */
function clearAddStatus() {
  if (dom.addStatus) hideStatus(dom.addStatus);
  if (dom.urlInput) dom.urlInput.removeAttribute('aria-invalid');
}

/** Mark the URL field invalid (parse failures only) and explain why, inline. */
function rejectInput(message) {
  if (dom.urlInput) dom.urlInput.setAttribute('aria-invalid', 'true');
  setAddStatus(message, 'error');
}

/** Reflect an in-flight add on the form (the button is the only visible part). */
function setAdding(adding) {
  state.adding = adding;
  if (dom.addBtn) dom.addBtn.disabled = adding;
}

async function onAddSubmit(e) {
  e.preventDefault();
  // A second submit while one is in flight would hit auth.js's single callback
  // slot ("A token request is already in progress."), so it never starts.
  if (state.adding) return;

  const raw = dom.urlInput ? dom.urlInput.value : '';
  if (!raw.trim()) {
    rejectInput('Paste a YouTube link (or a bare video id) first.');
    return;
  }
  const videoId = parseVideoId(raw);
  if (!videoId) {
    rejectInput('That does not look like a YouTube video link or id.');
    return;
  }

  // DUPLICATE: leave the existing record EXACTLY as it is — same position, same
  // addedAt, same Remove mark — and just point at it. No write, no API call.
  const existing = state.records.find((r) => r.videoId === videoId);
  if (existing) {
    setAddStatus('That video is already in your stash.', 'info');
    scrollToCard(videoId);
    return;
  }

  if (!state.clientId) {
    setAddStatus('Add your OAuth Client ID first (Change Client ID).', 'error');
    return;
  }

  setAdding(true);
  try {
    if (!hasSession()) setAddStatus('Authorizing with Google…', 'progress');
    await ensureAuthReady();
    // Silent when a token is already live; falls back to the consent prompt.
    await ensureToken({ interactiveFallback: true });
    updateAuthUi(); // a fresh token flips the label + the Like button

    setAddStatus('Looking up the video…', 'progress');
    const [incoming] = await getVideosByIds([videoId]);
    if (!incoming) {
      // getVideosByIds simply omits ids the API does not return.
      setAddStatus(
        'YouTube has no such video — it may be private, deleted, or the link may be wrong.',
        'error'
      );
      return;
    }

    await attachAvatar(incoming);

    // Channel prefs are read FRESH (never cached at startup), so a speed set in
    // a Channels tab applies to this add without reloading. The Ignore flag is
    // deliberately NOT consulted — addToStash reads the leaf
    // channelPreferredSpeed, because Ignore governs what gets FETCHED by
    // subscription and nothing here is fetched by subscription.
    const { records, added, record } = addToStash(state.records, incoming, {
      addedAt: new Date().toISOString(),
      prefs: loadChannelPrefs(),
    });
    if (!added) {
      // Raced with another add of the same id: still no mutation, by contract.
      setAddStatus('That video is already in your stash.', 'info');
      scrollToCard(record.videoId);
      return;
    }

    await putStashVideo(record);
    state.records = sortStash(records);
    render();
    if (dom.urlInput) dom.urlInput.value = '';
    setAddStatus(`Added “${record.title}” to your stash.`, 'success');
    scrollToCard(record.videoId);
  } catch (err) {
    setAddStatus(describeAddFailure(err), 'error');
    if (err instanceof DbBlockedError || err instanceof DbUnavailableError) {
      // A fatal storage condition is bigger than this form: put up the halt
      // screen too (the inline line alone would understate it).
      handleError(err);
    } else if (err instanceof ApiError && err.kind === 'auth') {
      // The grant is genuinely dead: end the session so the label and the Like
      // button agree with the message above.
      clearToken();
      updateAuthUi();
    }
  } finally {
    setAdding(false);
  }
}

/**
 * Give the new record its channel avatar, WITHOUT touching `yqa_channels`: the
 * stash stores the URL on its own record, so it depends on no map that a
 * subscriptions refresh could prune out from under it. The already-known map is
 * tried first, so stashing from a subscribed channel costs no quota. Purely
 * cosmetic — a failure leaves the letter placeholder and never fails the add.
 * @param {object} rec the freshly fetched record (mutated in place)
 */
async function attachAvatar(rec) {
  if (!rec || !rec.channelId) return;
  const known = state.channels[rec.channelId];
  if (known && known.avatarUrl) {
    rec.channelAvatarUrl = known.avatarUrl;
    return;
  }
  try {
    const avatars = await getChannelAvatars([rec.channelId]);
    const url = avatars.get(rec.channelId);
    if (url) rec.channelAvatarUrl = url;
  } catch {
    // Cosmetic only: the card falls back to the placeholder circle.
  }
}

/**
 * The inline message for a failed add — a pure string picker (the caller decides
 * what else the failure warrants). Two of these are PLAIN Errors, not ApiErrors,
 * so they carry no `kind` and would fall through an ApiError-only router: GIS
 * not loaded yet, and a token request already in progress.
 * @param {unknown} err
 * @returns {string}
 */
function describeAddFailure(err) {
  if (err instanceof DbBlockedError || err instanceof DbUnavailableError) {
    return 'Could not save to storage — see the message on screen.';
  }
  if (err instanceof ApiError) {
    if (err.kind === 'auth') return 'Your session expired. Sign in again, then add the link.';
    if (err.kind === 'quota') return err.message; // already user-facing
    if (err.kind === 'network') return 'Network error. Check your connection and try again.';
    if (err.kind === 'notfound') {
      return 'YouTube has no such video — it may be private, deleted, or the link may be wrong.';
    }
    return `Could not add that video: ${err.message}`;
  }
  const message = (err && err.message) || '';
  if (/Identity Services/i.test(message)) {
    return 'Google sign-in has not loaded yet. Give it a moment, then try again.';
  }
  if (/already in progress/i.test(message)) {
    return 'A sign-in is already in progress — finish it, then add the link.';
  }
  const code = err && err.code;
  if (code === 'popup_closed' || code === 'access_denied' || /cancel/i.test(message)) {
    return 'Sign-in was cancelled, so the video was not added.';
  }
  return message || 'Something went wrong — the video was not added.';
}

// ---------------------------------------------------------------------------
// Marking (Remove), undo, and the Clean up sweep
// ---------------------------------------------------------------------------

/**
 * Set a record's state to `nextState` as given — this NEVER toggles. Updates the
 * record + card optimistically (greyed IN PLACE: no re-render, no reordering,
 * nothing removed), then persists, reverting everything on failure.
 * @param {string} videoId
 * @param {string} nextState
 * @param {{advanceFocus?: boolean}} [opts]
 */
async function setVideoState(videoId, nextState, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  const prevState = rec.state;
  const card = findCard(videoId);

  rec.state = nextState;
  state.lastAction = { videoId, prevState };

  if (card) {
    setCardState(card, nextState);
    if (opts.advanceFocus) {
      const next = nextRowAfter(card);
      if (next) next.focus();
    }
  }
  // This optimistic path skips render(), so re-evaluate what depends on the
  // marks: the empty player's Start button, and the Clean up count.
  updatePlayingControls();
  updateCleanupUi();

  try {
    await putStashVideo(rec);
  } catch (err) {
    rec.state = prevState;
    if (card) setCardState(card, prevState);
    updatePlayingControls();
    updateCleanupUi();
    if (state.lastAction && state.lastAction.videoId === videoId) {
      state.lastAction = null;
    }
    handleError(err);
  }
}

/**
 * Remove button / x key. Toggle semantics: marking a card that is ALREADY
 * handled (any non-'new' state) returns it to 'new' in one press. Auto-mark when
 * a video ENDS calls setVideoState directly instead, so a just-finished video is
 * never toggled back.
 * @param {string} videoId
 * @param {{advanceFocus?: boolean}} [opts]
 */
function toggleRemove(videoId, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const next = rec.state !== STATE_NEW ? STATE_NEW : STATE_SKIPPED;
  return setVideoState(videoId, next, opts);
}

async function onUndo() {
  const action = state.lastAction;
  if (!action) return;

  const rec = state.records.find((r) => r.videoId === action.videoId);
  if (!rec) {
    // Already swept (Clean up / reload). Nothing to undo.
    state.lastAction = null;
    return;
  }

  const curState = rec.state;
  const card = findCard(action.videoId);

  rec.state = action.prevState;
  if (card) setCardState(card, action.prevState);
  updatePlayingControls();
  updateCleanupUi();
  state.lastAction = null;

  try {
    await putStashVideo(rec);
  } catch (err) {
    rec.state = curState;
    if (card) setCardState(card, curState);
    updatePlayingControls();
    updateCleanupUi();
    handleError(err);
  }
}

/**
 * THE deletion path for the stash — the single implementation behind BOTH the
 * on-reload sweep and the Clean up button. The set comes from the pure
 * stashToClean: every record marked Remove, from ANYWHERE in the list (that is
 * the whole difference from the subscriptions "Trim front", which can only take
 * a contiguous prefix). Memory is pruned BEFORE the await, so a failed delete
 * leaves memory and IndexedDB diverged until the next reload re-reads and
 * re-sweeps. Does NOT render — callers do.
 * @returns {Promise<number>} how many records were deleted
 */
async function sweepRemoved() {
  const doomed = stashToClean(state.records);
  if (doomed.length === 0) return 0;
  const ids = doomed.map((r) => r.videoId);
  const idSet = new Set(ids);
  state.records = state.records.filter((r) => !idSet.has(r.videoId));
  await deleteStashVideos(ids);
  return ids.length;
}

/**
 * Clean up button: sweep, re-render, report. Then move focus DELIBERATELY — the
 * button disables itself at 0, and a disabled control drops focus to <body>,
 * which would strand the keyboard user. Focus goes to the first remaining card
 * (where j/k resume), else back to the URL field (where the stash restarts).
 */
async function onCleanup() {
  try {
    const removed = await sweepRemoved();
    render();
    if (removed > 0) {
      showToast(`Removed ${removed} video(s) from your stash.`, { type: 'success' });
    }
    const firstRow = dom.queueList.querySelector('.row');
    if (firstRow) firstRow.focus();
    else if (dom.urlInput) dom.urlInput.focus();
  } catch (err) {
    handleError(err);
  }
}

/**
 * Update the Clean up button's label + disabled state. The count is stashToClean
 * — the exact set the button would delete — never an inline filter that could
 * drift from it.
 */
function updateCleanupUi() {
  if (!dom.cleanupBtn) return;
  const n = stashToClean(state.records).length;
  dom.cleanupBtn.textContent = `Clean up (${n})`;
  dom.cleanupBtn.disabled = n === 0;
}

// ---------------------------------------------------------------------------
// Queue DOM helpers (operate on the stable, in-place list)
// ---------------------------------------------------------------------------

/** Find the rendered card (<li class="row">) for a videoId. */
function findCard(videoId) {
  for (const row of dom.queueList.querySelectorAll('.row')) {
    if (row.dataset.videoId === videoId) return row;
  }
  return null;
}

/**
 * The next card after `card` in list/DOM order, for post-mark focus advance.
 * Returns `card` itself when it is the last one (keep focus put), or null.
 */
function nextRowAfter(card) {
  if (!card) return null;
  const rows = Array.from(dom.queueList.querySelectorAll('.row'));
  const i = rows.indexOf(card);
  if (i === -1) return null;
  return i < rows.length - 1 ? rows[i + 1] : card;
}

/** Centre a card in the list, when it is rendered (outside the window: no-op). */
function scrollToCard(videoId) {
  const card = findCard(videoId);
  if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// On-page player (right pane): play, auto-advance + auto-mark, speed
// ---------------------------------------------------------------------------

/** Create the YT.Player once, on first entry to the main app. */
function ensurePlayer() {
  if (state.playerInited) return;
  state.playerInited = true;
  initPlayer({
    mountId: 'player-mount',
    onEnded: onPlayerEnded,
    onReady: () => updateSpeedButtons(),
    onProgress: onPlayerProgress,
  });
  updateSpeedButtons();
}

/**
 * Play a stashed video in the embedded right-pane player. Non-embeddable videos
 * can't be framed, so fall back to opening them on YouTube with a brief notice.
 * @param {string} videoId
 */
function playVideo(videoId) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  if (rec.embeddable === false) {
    openOnYouTube(videoId);
    showToast('That video can’t be embedded — opened it on YouTube.', { type: 'info' });
    return;
  }
  ensurePlayer();
  state.playing = videoId;
  // Apply the EFFECTIVE speed before loading — via onSpeed, so the player, the
  // button highlight and the persisted global speed all update and carry
  // forward. Priority: this video's preferredSpeed, else the default-speed
  // setting, else the current speed.
  onSpeed(effectiveSpeed(rec.preferredSpeed, state.defaultSpeed, state.speed));
  const start = resumeStart(rec.positionSeconds, rec.durationSeconds);
  playerLoad(videoId, start);
  setPlayerNowPlaying(rec);
  markPlayingCard(videoId);
  updatePlayingControls();
  updateLikeButton();
}

/**
 * "Start the stash" button in the empty player: play the FIRST still-'new',
 * embeddable record — over the FULL record list, never the render window, since
 * the window limits what is RENDERED, not what can be PLAYED. The button is
 * hidden whenever firstPlayable finds nothing, so the null branch only guards a
 * stale click and just re-syncs the button.
 */
function onStartQueue() {
  const first = firstPlayable(state.records);
  if (!first) {
    updatePlayingControls();
    return;
  }
  playVideo(first.videoId);
}

function openOnYouTube(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  window.open(url, '_blank', 'noopener');
}

/**
 * Fired when the current video ENDS: auto-mark it Remove via setVideoState (SET,
 * never toggle — once watched it is marked for removal), reset the saved
 * position so it can't resume at its very end, then auto-play the next still-
 * 'new', embeddable record — again over the FULL list — or show the caught-up
 * state when none remain.
 * @param {string} endedId
 */
function onPlayerEnded(endedId) {
  if (!endedId) return;
  const rec = state.records.find((r) => r.videoId === endedId);
  if (rec) rec.positionSeconds = 0;
  setVideoState(endedId, STATE_SKIPPED); // persists rec (incl. the reset position)
  const next = nextPlayable(state.records, endedId);
  if (next) playVideo(next.videoId);
  else showPlayerEmpty(true);
}

function setPlayerNowPlaying(rec) {
  if (dom.playerTitle) dom.playerTitle.textContent = rec ? rec.title : ''; // safe text
  renderPlayerMeta(dom.playerMeta, rec, state.channels);
  renderDescription(dom.playerDescription, rec, { onSeek: seekTo });
  // A new video loaded: scroll the pane back to the top so the video shows.
  if (dom.playerPane) dom.playerPane.scrollTop = 0;
  setVisible(dom.playerEmpty, false);
  state.playerCaughtUp = false; // playing again: the next stop re-decides the text
  if (dom.skipBtn) dom.skipBtn.disabled = false;
}

/**
 * Show the player's empty state. `caughtUp` only records HOW playback stopped
 * (the stash ran out, vs nothing has played yet); the overlay's text and button
 * are both derived in updatePlayingControls().
 */
function showPlayerEmpty(caughtUp) {
  state.playing = null;
  state.playerCaughtUp = !!caughtUp;
  if (dom.playerTitle) dom.playerTitle.textContent = '';
  renderPlayerMeta(dom.playerMeta, null);
  renderDescription(dom.playerDescription, null, { onSeek: seekTo });
  setVisible(dom.playerEmpty, true);
  if (dom.skipBtn) dom.skipBtn.disabled = true;
  updatePlayingControls();
  updateLikeButton();
  markPlayingCard(null);
}

/**
 * Reflect playback + list state onto the controls that depend on BOTH, at the
 * same moments — hence one function, called wherever state.playing flips, from
 * the optimistic marking path, AND from render():
 *
 *  - "Scroll to playing": enabled only while something is playing AND its card is
 *    actually rendered (outside the window there is nothing to scroll to).
 *  - The empty-player overlay — text AND its "Start the stash" button — derived
 *    from ONE condition: nothing is playing and firstPlayable() finds something
 *    over the FULL record list. So EXACTLY ONE of {button, text} shows: never
 *    both (a "Select a video to play" prompt beside a button that does exactly
 *    that contradicts it), never neither. A stash drained to "all caught up" and
 *    then refilled by an add flips back to a working button on that render, with
 *    no stale message: state.playerCaughtUp is a TEXT-selector only and can never
 *    suppress a live button. The button is HIDDEN rather than disabled, so it
 *    never sits dead in the tab order.
 */
function updatePlayingControls() {
  if (dom.scrollPlayingBtn) {
    dom.scrollPlayingBtn.disabled = !state.playing || !findCard(state.playing);
  }
  // The whole now-playing bar belongs to a loaded video: with none, the title and
  // meta are empty and every control is a disabled stub, so hide the bar outright.
  // VISIBILITY layer only — each control keeps its own disabled logic underneath.
  setVisible(dom.playerBar, !!state.playing);
  const canStart = !state.playing && !!firstPlayable(state.records);
  setVisible(dom.startQueueBtn, canStart);
  setVisible(dom.playerEmptyText, !canStart);
  if (dom.playerEmptyText) {
    dom.playerEmptyText.textContent = state.playerCaughtUp
      ? 'All caught up — nothing left to play.'
      : 'Select a video to play';
  }
}

/** Centre the currently-playing card (the button is disabled when there is none). */
function onScrollToPlaying() {
  if (!state.playing) return;
  scrollToCard(state.playing);
}

/** Move the .row--playing highlight to the card for `videoId` (or clear it). */
function markPlayingCard(videoId) {
  for (const row of dom.queueList.querySelectorAll('.row--playing')) {
    row.classList.remove('row--playing');
  }
  if (videoId) {
    const card = findCard(videoId);
    if (card) card.classList.add('row--playing');
  }
}

function onSpeed(speed) {
  state.speed = speed;
  playerSetSpeed(speed);
  setPlaybackSpeed(speed); // persisted, and SHARED with the subscriptions page
  updateSpeedButtons();
}

function updateSpeedButtons() {
  const speeds = [
    [dom.speed1x, 1],
    [dom.speed15x, 1.5],
    [dom.speed2x, 2],
  ];
  for (const [btn, s] of speeds) {
    if (!btn) continue;
    btn.classList.toggle('is-active', state.speed === s);
    btn.setAttribute('aria-pressed', String(state.speed === s));
  }
}

/**
 * Set/toggle a card's per-video preferred speed. Does NOT start playback: it
 * persists `preferredSpeed` on the record and updates that card's speed buttons
 * in place. Clicking the active speed toggles it OFF. If the card IS the
 * currently-playing video, SETTING a speed applies it live (unsetting does not).
 * @param {string} videoId
 * @param {number} speed 1 | 1.5 | 2
 */
function onCardSpeed(videoId, speed) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const wasActive = rec.preferredSpeed === speed;
  rec.preferredSpeed = wasActive ? undefined : speed; // click active -> toggle off
  putStashVideo(rec).catch(reportIfFatalDb); // persist (whole-record write)
  const card = findCard(videoId);
  if (card) setCardSpeed(card, rec.preferredSpeed);
  if (!wasActive && state.playing === videoId) onSpeed(speed);
}

/**
 * Player "Remove & next": mark the CURRENT video and advance — the EXACT same
 * path as auto-advance-on-end (setVideoState + nextPlayable).
 */
function onSkipNext() {
  if (state.playing) onPlayerEnded(state.playing);
}

// --- Watch progress (track + resume) ---

/** Persist the watch position reported by the player (~every 5s, and on hide). */
function onPlayerProgress(videoId, seconds) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const pos = Math.floor(seconds || 0);
  if (rec.positionSeconds === pos) return;
  rec.positionSeconds = pos;
  putStashVideo(rec).catch(reportIfFatalDb); // best-effort throttled persist
}

/** Best-effort capture + persist of the current position on page hide/unload. */
function flushProgress() {
  capturePosition(); // -> onPlayerProgress -> putStashVideo
}

// --- Like button (player only) ---

/** The record currently loaded in the player, or null. */
function playingRecord() {
  return state.playing ? state.records.find((r) => r.videoId === state.playing) : null;
}

/**
 * Reflect the Like button from the CURRENT record's LOCAL `liked` flag (never
 * fetched back). The visual filled state is informational and shown even signed
 * out; the button is ENABLED only with an active session AND a video playing.
 */
function updateLikeButton() {
  if (!dom.likeBtn) return;
  const rec = playingRecord();
  const liked = !!(rec && rec.liked);
  dom.likeBtn.classList.toggle('is-active', liked);
  dom.likeBtn.setAttribute('aria-pressed', String(liked));
  dom.likeBtn.title = liked ? 'Remove like' : 'Like';
  dom.likeBtn.setAttribute(
    'aria-label',
    liked ? 'Remove like from this video' : 'Like this video'
  );
  dom.likeBtn.disabled = !state.playing || !hasSession();
}

/**
 * Toggle the current video's like: rateVideo(id,'like'|'none') writes to
 * YouTube; on success the local `liked` flag is set + PERSISTED (so it survives
 * a reload with no fetch/quota). Optimistic; reverts on error. A scope error
 * (401/403) triggers a fresh interactive consent, then retries once.
 */
async function onLike() {
  const videoId = state.playing;
  if (!videoId || !dom.likeBtn || dom.likeBtn.disabled) return;
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  const wasLiked = !!rec.liked;
  const nextLiked = !wasLiked;
  const nextRating = nextLiked ? 'like' : 'none';
  const revert = () => {
    rec.liked = wasLiked;
    updateLikeButton();
  };

  rec.liked = nextLiked; // optimistic (visual) update
  updateLikeButton();

  try {
    await rateVideo(videoId, nextRating); // ~50 quota units; writes to YouTube
    putStashVideo(rec).catch(reportIfFatalDb); // persist the local liked flag
  } catch (err) {
    if (err instanceof ApiError && (err.kind === 'auth' || err.kind === 'forbidden')) {
      try {
        showToast('Requesting YouTube access to like videos…', { type: 'info' });
        await ensureAuthReady();
        await requestToken({ interactive: true });
        await rateVideo(videoId, nextRating);
        putStashVideo(rec).catch(reportIfFatalDb);
        return;
      } catch (e2) {
        revert();
        handleError(e2);
        return;
      }
    }
    revert();
    handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Rendering
//
// No stats: the stash has no floor, no cutoff and no "queued" count to display,
// so there is no renderStats call here at all.
// ---------------------------------------------------------------------------

function render() {
  // sortStash is the stash's SINGLE ordering site: oldest addedAt first.
  state.records = sortStash(state.records);

  const total = state.records.length;
  const hasItems = total > 0;
  setVisible(dom.queueList, hasItems);
  // Unlike the subscriptions queue, the empty state is NOT gated on being signed
  // in: "paste a link to add your first video" is exactly the right prompt for a
  // signed-out, empty stash.
  setVisible(dom.emptyState, !hasItems);

  // Render only the windowed cards; "Show all (N)" reveals the rest for this
  // session. The window limits CARDS only — firstPlayable / nextPlayable always
  // scan state.records in full.
  const windowed = state.showAll ? state.records : state.records.slice(0, QUEUE_DISPLAY_LIMIT);
  const more = !state.showAll && total > QUEUE_DISPLAY_LIMIT ? { total, onShowAll } : null;

  // Button clicks are mouse-driven, so they don't advance focus; the keyboard x
  // (in onGlobalKeydown) passes advanceFocus for rapid down-the-list removing.
  // 'Remove' is the mark button's visible label on this page — the btn--skip
  // CLASS is unchanged, so setCardState and the CSS still key off it.
  renderQueue(
    dom.queueList,
    windowed,
    {
      onSkip: (id) => toggleRemove(id),
      onPlay: (id) => playVideo(id),
      onCardSpeed: (id, speed) => onCardSpeed(id, speed),
    },
    state.channels,
    more,
    'Remove'
  );

  if (state.playing) markPlayingCard(state.playing);

  updatePlayingControls();
  updateCleanupUi();
}

/** "Show all (N)": reveal every card for THIS session (in-memory, not persisted). */
function onShowAll() {
  state.showAll = true;
  render();
}

/**
 * Cycle the DEFAULT-speed setting: unset -> 1× -> 1.5× -> 2× -> unset. Persisted
 * under the SAME key the subscriptions page uses — one global setting. Does not
 * touch the current playback speed, only the fallback for future plays of videos
 * with no per-video preferred speed (via effectiveSpeed).
 */
function onCycleDefaultSpeed() {
  const cycle = [null, 1, 1.5, 2];
  const i = cycle.indexOf(state.defaultSpeed);
  const next = cycle[(Math.max(0, i) + 1) % cycle.length];
  state.defaultSpeed = next;
  setDefaultSpeed(next); // null removes the key
  updateDefaultSpeedButton();
}

/** Reflect the default-speed setting on the toolbar button ("off" when unset). */
function updateDefaultSpeedButton() {
  if (!dom.defaultSpeedBtn) return;
  const ds = state.defaultSpeed;
  const label = [1, 1.5, 2].includes(ds) ? `${ds}×` : 'off';
  dom.defaultSpeedBtn.textContent = `Default speed: ${label}`;
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts. STASH: j/k move, x remove, u undo, Enter play focused
// card, 1/5/2 preferred speed. PLAYER: Space play/pause, ←/→ seek, -/+ speed,
// n next, l like, m mute, f fullscreen. Ignored while typing in an input (the
// add field lives on this page, so this matters more here), during onboarding,
// and for Ctrl/Cmd/Alt combos (Shift stays allowed for '+').
//
// There is deliberately no key for refresh, hide-marked or jump-to-last-marked:
// this page has none of those controls.
// ---------------------------------------------------------------------------

// Digit -> preferred speed for the FOCUSED card. 1 and 2 are literal; '5' is the
// "point-five" mnemonic for 1.5× — hence an explicit table rather than
// Number(key), which would read '5' as the (invalid) speed 5. A Map, so stray
// key names can never resolve to an inherited Object property.
const CARD_SPEED_KEYS = new Map([
  ['1', 1],
  ['5', 1.5],
  ['2', 2],
]);

function onGlobalKeydown(e) {
  // PANIC KEY: Esc toggles the curtain, handled BEFORE any guard so it works
  // while typing in the add field and during onboarding. Ignore modifier combos.
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    curtain.toggle();
    return;
  }

  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (dom.appMain.hidden) return;
  // Never hijack browser/OS shortcuts (Ctrl+U, Cmd+K, Alt+…). Shift stays allowed
  // so '+' and other shifted keys still reach us.
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const key = e.key.toLowerCase();
  const rows = Array.from(dom.queueList.querySelectorAll('.row'));
  const active = document.activeElement;
  const idx = rows.indexOf(active);

  if (key === 'j') {
    // j = move BACK (previous/older card, upward in the oldest->newest list).
    e.preventDefault();
    if (idx > 0) rows[idx - 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'k') {
    // k = move FORWARD (next card, downward).
    e.preventDefault();
    if (idx < rows.length - 1) rows[idx + 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'x') {
    // x = Remove: toggle the focused card between new and marked.
    if (idx >= 0) {
      e.preventDefault();
      toggleRemove(rows[idx].dataset.videoId, { advanceFocus: true });
    }
  } else if (CARD_SPEED_KEYS.has(key)) {
    // Set the FOCUSED card's preferred speed (1 = 1×, 5 = 1.5×, 2 = 2×). Reuses
    // the card speed-button behavior: toggles off if already set, no playback,
    // applies live only if the focused card is the one currently playing. No-op
    // on a non-embeddable card: it has no in-app playback to speed up.
    if (idx >= 0) {
      e.preventDefault();
      const videoId = rows[idx].dataset.videoId;
      const rec = state.records.find((r) => r.videoId === videoId);
      if (!rec || rec.embeddable !== false) onCardSpeed(videoId, CARD_SPEED_KEYS.get(key));
    }
  } else if (key === 'u') {
    e.preventDefault();
    onUndo();
  } else if (key === 'enter') {
    // Play the FOCUSED card. If a button/link is focused (idx === -1) do nothing
    // here, so Enter activates that control normally.
    if (idx >= 0) {
      e.preventDefault();
      playVideo(rows[idx].dataset.videoId);
    }
  } else if (key === ' ') {
    // Space must NEVER scroll the page — but yield to a focused interactive
    // control (a11y). If not on such a control, always block the scroll, and
    // toggle play/pause only when something is playing.
    const t = active && active.tagName;
    const interactive =
      t === 'BUTTON' || t === 'A' || t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA';
    if (!interactive) {
      e.preventDefault();
      if (state.playing) togglePlay();
    }
  } else if (key === 'arrowleft') {
    if (state.playing) {
      e.preventDefault(); // otherwise the arrow scrolls the list
      seekBy(-5);
    }
  } else if (key === 'arrowright') {
    if (state.playing) {
      e.preventDefault();
      seekBy(5);
    }
  } else if (key === '-') {
    cyclePlaybackSpeed(-1);
  } else if (key === '=' || key === '+') {
    cyclePlaybackSpeed(1);
  } else if (key === 'n') {
    onSkipNext();
  } else if (key === 'l') {
    onLike();
  } else if (key === 'm') {
    if (state.playing) toggleMute();
  } else if (key === 'f') {
    requestFullscreen();
  }
}

/**
 * Step the playback speed up/down through the [1, 1.5, 2] presets (clamped, no
 * wrap) via onSpeed (which sets, persists, and updates the buttons).
 * @param {number} dir -1 (slower) or +1 (faster)
 */
function cyclePlaybackSpeed(dir) {
  const speeds = [1, 1.5, 2];
  let i = speeds.indexOf(state.speed);
  if (i === -1) i = 0;
  const next = speeds[Math.min(speeds.length - 1, Math.max(0, i + dir))];
  if (next !== state.speed) onSpeed(next);
}

// ---------------------------------------------------------------------------
// Error handling
//
// The full-screen halt screens live in page-chrome.js (identical on both queue
// pages); this is the page-LOCAL router — an auth failure ends the session and
// repaints THIS page's auth UI. Add failures do not come through here: they are
// reported inline, next to the field (see describeAddFailure).
// ---------------------------------------------------------------------------

function handleError(err) {
  if (err instanceof DbBlockedError) {
    showBlockedError();
    return;
  }
  if (err instanceof DbUnavailableError) {
    showDbUnavailableError();
    return;
  }
  if (err instanceof ApiError) {
    if (err.kind === 'auth') {
      // An API call failed auth even after the built-in silent refresh/retry, so
      // the grant is genuinely dead: end the session BEFORE updateAuthUi() so the
      // status label and the Like button both flip to signed-out together.
      clearToken();
      showToast('Your session expired. Please sign in again.', { type: 'error' });
      updateAuthUi();
      return;
    }
    if (err.kind === 'quota') {
      showToast(err.message, { type: 'error' });
      return;
    }
    if (err.kind === 'network') {
      showToast('Network error. Check your connection and try again.', { type: 'error' });
      return;
    }
    showToast(`Error: ${err.message}`, { type: 'error' });
    return;
  }
  // Auth-cancellation and generic errors.
  const msg = (err && err.message) || 'Something went wrong.';
  showToast(msg, { type: 'error' });
}
