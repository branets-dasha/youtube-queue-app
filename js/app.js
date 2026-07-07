// js/app.js
//
// Orchestration / wiring: auth -> fetch -> store -> queue -> ui, plus all
// event binding and first-run onboarding. This is the only module that reaches
// into every layer.

import { STATE_NEW, STATE_WATCHED, STATE_NOT_INTERESTED } from './config.js';
import {
  getClientId,
  setClientId,
  getStartCutoff,
  setStartCutoff,
  getAllVideos,
  putVideos,
  putVideo,
  deleteVideos,
  replaceAllVideos,
} from './store.js';
import {
  waitForGis,
  initAuth,
  requestToken,
  isSignedIn,
  revoke,
} from './auth.js';
import { getSubscriptions, getChannelVideosSince, ApiError } from './api.js';
import {
  upsertVideos,
  computeQueue,
  computeVisible,
  advanceCutoff,
  daysAgoIso,
} from './queue.js';
import {
  el,
  showStatus,
  hideStatus,
  renderQueue,
  renderStats,
  setCardState,
  setVisible,
} from './ui.js';

// ---------------------------------------------------------------------------
// Application state (in-memory)
// ---------------------------------------------------------------------------

const state = {
  clientId: null,
  cutoff: null,
  records: [], // all stored video records
  visible: [], // derived: computeVisible(records, cutoff) — render list (any state)
  queue: [], // derived: computeQueue(records, cutoff) — still-'new' subset, for the count
  handledThisSession: 0,
  lastAction: null, // { videoId, prevState } for undo
  refreshing: false,
};

// DOM references, populated in init().
const dom = {};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheDom();
  bindEvents();

  state.clientId = getClientId();
  state.cutoff = getStartCutoff();

  // Show the current origin in the setup instructions so the user can copy the
  // exact "Authorized JavaScript origins" value.
  if (dom.originHint) dom.originHint.textContent = window.location.origin;

  // Load persisted videos up front.
  try {
    state.records = await getAllVideos();
  } catch {
    state.records = [];
  }

  // Reload-time cleanup (a): on page load, advance the cutoff across any
  // contiguous handled prefix and prune it BEFORE the first render.
  if (state.cutoff) {
    try {
      await reconcileCutoff();
    } catch {
      // Non-fatal: fall through and render whatever we have.
    }
  }

  routeFirstRun();
}

function cacheDom() {
  const byId = (id) => document.getElementById(id);
  dom.setupPanel = byId('setup-panel');
  dom.clientIdInput = byId('client-id-input');
  dom.saveClientIdBtn = byId('save-client-id-btn');
  dom.originHint = byId('origin-hint');
  dom.setupError = byId('setup-error');

  dom.cutoffPanel = byId('cutoff-panel');
  dom.cutoffInput = byId('cutoff-input');
  dom.saveCutoffBtn = byId('save-cutoff-btn');

  dom.appMain = byId('app-main');
  dom.signinBtn = byId('signin-btn');
  dom.signoutBtn = byId('signout-btn');
  dom.authStatus = byId('auth-status');
  dom.refreshBtn = byId('refresh-btn');
  dom.changeCutoffBtn = byId('change-cutoff-btn');
  dom.changeClientBtn = byId('change-client-btn');

  dom.queuedCount = byId('queued-count');
  dom.handledCount = byId('handled-count');
  dom.cutoffDisplay = byId('cutoff-display');

  dom.status = byId('status');
  dom.queueList = byId('queue-list');
  dom.emptyState = byId('empty-state');
  dom.undoBtn = byId('undo-btn');
  dom.undoBar = byId('undo-bar');
}

function bindEvents() {
  dom.saveClientIdBtn.addEventListener('click', onSaveClientId);
  dom.clientIdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSaveClientId();
  });

  dom.saveCutoffBtn.addEventListener('click', onSaveCutoff);

  dom.signinBtn.addEventListener('click', onSignIn);
  dom.signoutBtn.addEventListener('click', onSignOut);
  dom.refreshBtn.addEventListener('click', onRefresh);
  dom.changeCutoffBtn.addEventListener('click', openCutoffPanel);
  dom.changeClientBtn.addEventListener('click', openSetupPanel);
  dom.undoBtn.addEventListener('click', onUndo);

  document.addEventListener('keydown', onGlobalKeydown);

  // Safety net: never let an async failure vanish silently. Any unhandled
  // promise rejection is surfaced to the user via the status region.
  window.addEventListener('unhandledrejection', (event) => {
    handleError(event.reason);
  });
}

// ---------------------------------------------------------------------------
// First-run routing
// ---------------------------------------------------------------------------

function routeFirstRun() {
  if (!state.clientId) {
    openSetupPanel();
    return;
  }
  if (!state.cutoff) {
    openCutoffPanel();
    return;
  }
  showMainApp();
}

function openSetupPanel() {
  setVisible(dom.setupPanel, true);
  setVisible(dom.cutoffPanel, false);
  setVisible(dom.appMain, false);
  if (state.clientId) dom.clientIdInput.value = state.clientId;
  dom.clientIdInput.focus();
}

function openCutoffPanel() {
  setVisible(dom.cutoffPanel, true);
  // Default the datetime-local input to 7 days ago (or the existing cutoff).
  const seed = state.cutoff || daysAgoIso(7, Date.now());
  dom.cutoffInput.value = isoToLocalInput(seed);
  // Keep the main app visible behind if we already have a cutoff (this is a
  // "change cutoff" re-open); otherwise hide it.
  if (!state.cutoff) {
    setVisible(dom.appMain, false);
    setVisible(dom.setupPanel, false);
  }
  dom.cutoffInput.focus();
}

// ---------------------------------------------------------------------------
// Setup panel handlers
// ---------------------------------------------------------------------------

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

  if (!state.cutoff) {
    openCutoffPanel();
  } else {
    showMainApp();
  }
}

function onSaveCutoff() {
  const raw = dom.cutoffInput.value;
  if (!raw) {
    // Fall back to 7 days ago if the user cleared it.
    state.cutoff = daysAgoIso(7, Date.now());
  } else {
    // datetime-local yields local wall-clock; convert to ISO (UTC).
    const d = new Date(raw);
    state.cutoff = Number.isNaN(d.getTime())
      ? daysAgoIso(7, Date.now())
      : d.toISOString();
  }
  setStartCutoff(state.cutoff);
  setVisible(dom.cutoffPanel, false);

  // Re-derive queue with the (possibly) new cutoff and re-render.
  recompute();
  showMainApp();
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------

function showMainApp() {
  setVisible(dom.setupPanel, false);
  setVisible(dom.cutoffPanel, false);
  setVisible(dom.appMain, true);
  updateAuthUi();
  recompute();
}

function updateAuthUi() {
  const signed = isSignedIn();
  dom.authStatus.textContent = signed ? 'Signed in' : 'Not signed in';
  dom.authStatus.classList.toggle('is-signed-in', signed);
  setVisible(dom.signinBtn, !signed);
  setVisible(dom.signoutBtn, signed);
  dom.refreshBtn.disabled = !signed || state.refreshing;
}

async function onSignIn() {
  try {
    await waitForGis();
    initAuth(state.clientId);
    showStatus(dom.status, 'Opening Google sign-in…', 'progress');
    await requestToken({ interactive: true });
    hideStatus(dom.status);
    updateAuthUi();
    // Kick off an initial refresh automatically on first sign-in.
    onRefresh();
  } catch (err) {
    handleError(err);
    updateAuthUi();
  }
}

async function onSignOut() {
  await revoke();
  updateAuthUi();
  showStatus(dom.status, 'Signed out.', 'info');
}

// ---------------------------------------------------------------------------
// Refresh (fetch newer)
// ---------------------------------------------------------------------------

async function onRefresh() {
  if (state.refreshing) return;
  if (!isSignedIn()) {
    return onSignIn();
  }
  state.refreshing = true;
  dom.refreshBtn.disabled = true;
  hideStatus(dom.status);

  try {
    await waitForGis();
    initAuth(state.clientId);

    showStatus(dom.status, 'Loading your subscriptions…', 'progress');
    const subs = await getSubscriptions();

    if (subs.length === 0) {
      showStatus(dom.status, 'No subscriptions found on this account.', 'info');
      state.refreshing = false;
      updateAuthUi();
      return;
    }

    const cutoff = state.cutoff;
    const collected = [];
    let skipped = 0;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      showStatus(
        dom.status,
        `Fetching channel ${i + 1} of ${subs.length}: ${sub.channelTitle}`,
        'progress'
      );
      try {
        const vids = await getChannelVideosSince(
          sub.channelId,
          cutoff,
          sub.channelTitle
        );
        for (const v of vids) collected.push(v);
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'notfound') {
          // Deleted/hidden channel: skip without aborting the whole refresh.
          skipped++;
          continue;
        }
        if (err instanceof ApiError && err.kind === 'quota') {
          // Quota exhausted mid-run: persist what we have, then report.
          await mergeAndPersist(collected);
          throw err;
        }
        // auth/network/http: abort the run and report.
        throw err;
      }
    }

    await mergeAndPersist(collected);

    // Reload-time cleanup (b): after fetching newer videos, advance the cutoff
    // across the contiguous handled prefix, prune, then re-render.
    await reconcileCutoff();
    recompute();

    const parts = [`Refreshed. ${collected.length} item(s) fetched.`];
    if (skipped > 0) parts.push(`${skipped} channel(s) skipped (deleted/unavailable).`);
    showStatus(dom.status, parts.join(' '), 'success');
  } catch (err) {
    handleError(err);
  } finally {
    state.refreshing = false;
    updateAuthUi();
  }
}

/**
 * Merge freshly fetched records into the store (upsert by videoId, preserving
 * existing state), persist, then recompute the queue.
 * @param {Array<object>} incoming
 */
async function mergeAndPersist(incoming) {
  state.records = upsertVideos(state.records, incoming);
  await putVideos(state.records);
  recompute();
}

// ---------------------------------------------------------------------------
// Marking actions + cutoff advancement + pruning
// ---------------------------------------------------------------------------

async function markVideo(videoId, newState, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  const prevState = rec.state;
  // Toggle semantics: acting on a state the card is already in reverts it to
  // 'new', so a mis-mark can be corrected straight from the still-usable buttons
  // (or with the w/x key), and switching watched<->not_interested just re-marks.
  const nextState = prevState === newState ? STATE_NEW : newState;

  const card = findCard(videoId);

  // Optimistic, SYNCHRONOUS UI update: set the state, grey just this one card in
  // place, refresh the header counts, and (for keyboard marks) advance focus to
  // the next card BEFORE awaiting the persist. Nothing is recomputed, reordered,
  // or pruned, so the list stays perfectly stable across rapid w/x succession.
  rec.state = nextState;
  applyHandledDelta(prevState, nextState);
  state.lastAction = { videoId, prevState };
  if (card) setCardState(card, nextState);
  updateStats();
  showUndoBar();
  if (opts.advanceFocus && card) {
    const next = nextRowAfter(card);
    if (next) next.focus();
  }

  try {
    await putVideo(rec);
  } catch (err) {
    // Persistence failed: revert the optimistic changes so memory matches store.
    rec.state = prevState;
    applyHandledDelta(nextState, prevState);
    if (card) setCardState(card, prevState);
    updateStats();
    if (state.lastAction && state.lastAction.videoId === videoId) {
      state.lastAction = null;
    }
    handleError(err);
  }
}

/**
 * Keep the "handled this session" tally consistent across marks, toggles and
 * undos: +1 when a 'new' video becomes handled, -1 when a handled video reverts
 * to 'new', 0 when switching between two handled states.
 */
function applyHandledDelta(fromState, toState) {
  if (fromState === STATE_NEW && toState !== STATE_NEW) {
    state.handledThisSession += 1;
  } else if (fromState !== STATE_NEW && toState === STATE_NEW) {
    state.handledThisSession = Math.max(0, state.handledThisSession - 1);
  }
}

/**
 * Reload-time cutoff cleanup (NOT run on individual marks). Advances the cutoff
 * across the contiguous handled prefix, deletes the pruned records, and persists
 * the new cutoff. Pure derivation via advanceCutoff; does not render.
 */
async function reconcileCutoff() {
  const { newCutoff, prunedIds } = advanceCutoff(state.records, state.cutoff);

  if (prunedIds.length > 0) {
    const prunedSet = new Set(prunedIds);
    state.records = state.records.filter((r) => !prunedSet.has(r.videoId));
    await deleteVideos(prunedIds);
  }

  if (newCutoff && newCutoff !== state.cutoff) {
    state.cutoff = newCutoff;
    setStartCutoff(newCutoff);
  }
}

async function onUndo() {
  const action = state.lastAction;
  if (!action) return;

  const rec = state.records.find((r) => r.videoId === action.videoId);
  if (!rec) {
    // The video is no longer present (e.g. pruned by a reload). Nothing to undo.
    state.lastAction = null;
    hideUndoBar();
    return;
  }

  const curState = rec.state;
  const card = findCard(action.videoId);

  // Optimistically revert to the pre-mark state and un-grey the card in place.
  rec.state = action.prevState;
  applyHandledDelta(curState, action.prevState);
  if (card) setCardState(card, action.prevState);
  updateStats();
  state.lastAction = null;
  hideUndoBar();

  try {
    await putVideo(rec);
  } catch (err) {
    // Roll back the optimistic revert on persistence failure.
    rec.state = curState;
    applyHandledDelta(action.prevState, curState);
    if (card) setCardState(card, curState);
    updateStats();
    handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Queue DOM helpers (operate on the stable, in-place list)
// ---------------------------------------------------------------------------

/**
 * Find the rendered card (<li class="row">) for a videoId via its data attribute.
 * @param {string} videoId
 * @returns {HTMLElement|null}
 */
function findCard(videoId) {
  for (const row of dom.queueList.querySelectorAll('.row')) {
    if (row.dataset.videoId === videoId) return row;
  }
  return null;
}

/**
 * The next card after `card` in queue/DOM order, for post-mark focus advance.
 * Returns `card` itself when it is the last one (keep focus put), or null.
 * @param {HTMLElement} card
 * @returns {HTMLElement|null}
 */
function nextRowAfter(card) {
  if (!card) return null;
  const rows = Array.from(dom.queueList.querySelectorAll('.row'));
  const i = rows.indexOf(card);
  if (i === -1) return null;
  return i < rows.length - 1 ? rows[i + 1] : card;
}

// ---------------------------------------------------------------------------
// Derivation + rendering
// ---------------------------------------------------------------------------

function recompute() {
  // The render list includes ALL in-window videos (any state); the queue is the
  // still-'new' subset used only for the "Queued" count.
  state.visible = computeVisible(state.records, state.cutoff);
  state.queue = computeQueue(state.records, state.cutoff);
  render();
}

function render() {
  updateStats();

  const hasItems = state.visible.length > 0;
  setVisible(dom.queueList, hasItems);
  setVisible(dom.emptyState, !hasItems && isSignedIn());

  // Button clicks are mouse-driven, so they don't advance focus; keyboard w/x
  // (in onGlobalKeydown) pass advanceFocus for rapid down-the-list marking.
  renderQueue(dom.queueList, state.visible, {
    onWatched: (id) => markVideo(id, STATE_WATCHED),
    onNotInterested: (id) => markVideo(id, STATE_NOT_INTERESTED),
  });
}

/**
 * Refresh only the header stats (counts + cutoff) without touching the list, so
 * marking a card in place never re-renders or reorders the queue.
 */
function updateStats() {
  state.queue = computeQueue(state.records, state.cutoff);
  renderStats(
    {
      queuedCountEl: dom.queuedCount,
      handledCountEl: dom.handledCount,
      cutoffEl: dom.cutoffDisplay,
    },
    {
      queued: state.queue.length,
      handled: state.handledThisSession,
      cutoff: state.cutoff,
    }
  );
}

function showUndoBar() {
  setVisible(dom.undoBar, true);
}
function hideUndoBar() {
  setVisible(dom.undoBar, false);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts:  w = watched, x = not interested, j/k = move focus,
// u = undo. Shortcuts are ignored while typing in an input.
// ---------------------------------------------------------------------------

function onGlobalKeydown(e) {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (dom.appMain.hidden) return;

  const key = e.key.toLowerCase();
  const rows = Array.from(dom.queueList.querySelectorAll('.row'));
  if (rows.length === 0 && key !== 'u') return;

  const active = document.activeElement;
  let idx = rows.indexOf(active);

  if (key === 'j') {
    e.preventDefault();
    if (idx < rows.length - 1) rows[idx + 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'k') {
    e.preventDefault();
    if (idx > 0) rows[idx - 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'w') {
    if (idx >= 0) {
      e.preventDefault();
      markVideo(rows[idx].dataset.videoId, STATE_WATCHED, { advanceFocus: true });
    }
  } else if (key === 'x') {
    if (idx >= 0) {
      e.preventDefault();
      markVideo(rows[idx].dataset.videoId, STATE_NOT_INTERESTED, { advanceFocus: true });
    }
  } else if (key === 'u') {
    e.preventDefault();
    onUndo();
  }
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleError(err) {
  if (err instanceof ApiError) {
    if (err.kind === 'auth') {
      showStatus(dom.status, 'Your session expired. Please sign in again.', 'error');
      updateAuthUi();
      return;
    }
    if (err.kind === 'quota') {
      showStatus(dom.status, err.message, 'error');
      return;
    }
    if (err.kind === 'network') {
      showStatus(dom.status, 'Network error. Check your connection and try again.', 'error');
      return;
    }
    showStatus(dom.status, `Error: ${err.message}`, 'error');
    return;
  }
  // Auth-cancellation and generic errors.
  const msg = (err && err.message) || 'Something went wrong.';
  showStatus(dom.status, msg, 'error');
}

// ---------------------------------------------------------------------------
// datetime-local <-> ISO helpers
// ---------------------------------------------------------------------------

/**
 * Convert an ISO instant to a value usable by <input type="datetime-local">,
 * expressed in the browser's LOCAL time (the control has no timezone).
 * @param {string} iso
 * @returns {string} 'YYYY-MM-DDTHH:mm'
 */
function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
