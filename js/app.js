// js/app.js
//
// Orchestration / wiring: auth -> fetch -> store -> queue -> ui, plus all
// event binding and first-run onboarding. This is the only module that reaches
// into every layer.

import { STATE_WATCHED, STATE_NOT_INTERESTED } from './config.js';
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
  advanceCutoff,
  daysAgoIso,
} from './queue.js';
import {
  el,
  showStatus,
  hideStatus,
  renderQueue,
  renderStats,
  setVisible,
} from './ui.js';

// ---------------------------------------------------------------------------
// Application state (in-memory)
// ---------------------------------------------------------------------------

const state = {
  clientId: null,
  cutoff: null,
  records: [], // all stored video records
  queue: [], // derived: computeQueue(records, cutoff)
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

async function markVideo(videoId, newState) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  // Position of the acted-on row in the current queue, so we can restore
  // keyboard focus to whatever slides into its place after the re-render.
  const focusIdx = state.queue.findIndex((r) => r.videoId === videoId);

  // Optimistically mutate in memory; remember enough to revert on failure.
  const prevState = rec.state;
  rec.state = newState;
  state.handledThisSession += 1;
  state.lastAction = { videoId, prevState };

  try {
    await putVideo(rec);
    // Advance the cutoff / prune, stashing what was pruned so undo can survive
    // pruning of the just-handled item (the dominant burn-down path).
    const { prunedRecords, prevCutoff } = await applyCutoffAdvancement();
    if (state.lastAction) {
      state.lastAction.prunedRecords = prunedRecords;
      state.lastAction.prevCutoff = prevCutoff;
    }
  } catch (err) {
    // Persistence failed: revert the optimistic in-memory mutation so state
    // stays consistent with what is actually stored, then surface the error.
    rec.state = prevState;
    state.handledThisSession = Math.max(0, state.handledThisSession - 1);
    state.lastAction = null;
    recompute();
    handleError(err);
    return;
  }

  recompute();
  showUndoBar(newState);
  restoreQueueFocus(focusIdx);
}

/**
 * Advance the cutoff and prune. Returns the pruned record objects (with the
 * states they had at prune time) plus the cutoff that was in effect before the
 * advance, so a subsequent undo can restore them.
 * @returns {Promise<{ prunedRecords: Array<object>, prevCutoff: (string|null) }>}
 */
async function applyCutoffAdvancement() {
  const prevCutoff = state.cutoff;
  const { newCutoff, prunedIds } = advanceCutoff(state.records, state.cutoff);

  let prunedRecords = [];
  if (prunedIds.length > 0) {
    const prunedSet = new Set(prunedIds);
    prunedRecords = state.records
      .filter((r) => prunedSet.has(r.videoId))
      .map((r) => ({ ...r }));
    state.records = state.records.filter((r) => !prunedSet.has(r.videoId));
    await deleteVideos(prunedIds);
  }

  if (newCutoff && newCutoff !== state.cutoff) {
    state.cutoff = newCutoff;
    setStartCutoff(newCutoff);
  }

  return { prunedRecords, prevCutoff };
}

async function onUndo() {
  const action = state.lastAction;
  if (!action) return;

  try {
    const rec = state.records.find((r) => r.videoId === action.videoId);
    const pruned = action.prunedRecords || [];

    if (rec) {
      // The record is still in the store: simply revert its state.
      rec.state = action.prevState;
      await putVideo(rec);
    } else if (pruned.length > 0) {
      // The record (and any others at/behind the advanced cutoff) were pruned
      // when the cutoff advanced. Re-insert the stashed records, restoring the
      // acted-on one to its prior state, and roll the cutoff back so they land
      // back inside the active window.
      const restored = pruned.map((r) => ({
        ...r,
        state: r.videoId === action.videoId ? action.prevState : r.state,
      }));
      state.records = state.records.concat(restored);
      if (
        action.prevCutoff !== undefined &&
        action.prevCutoff !== state.cutoff
      ) {
        state.cutoff = action.prevCutoff;
        setStartCutoff(action.prevCutoff);
      }
      await putVideos(restored);
    } else {
      showStatus(dom.status, 'Cannot undo: that item was already pruned.', 'info');
      state.lastAction = null;
      hideUndoBar();
      return;
    }

    state.handledThisSession = Math.max(0, state.handledThisSession - 1);
    state.lastAction = null;
    recompute();
    hideUndoBar();
  } catch (err) {
    handleError(err);
  }
}

/**
 * After a re-render, return keyboard focus to the queue row now occupying the
 * given index (clamped), or to the empty state when the queue is empty.
 * @param {number} idx position the acted-on row held before the re-render
 */
function restoreQueueFocus(idx) {
  if (idx < 0) return;
  const rows = Array.from(dom.queueList.querySelectorAll('.row'));
  if (rows.length > 0) {
    rows[Math.min(idx, rows.length - 1)].focus();
  } else if (dom.emptyState && !dom.emptyState.hidden) {
    dom.emptyState.setAttribute('tabindex', '-1');
    dom.emptyState.focus();
  }
}

// ---------------------------------------------------------------------------
// Derivation + rendering
// ---------------------------------------------------------------------------

function recompute() {
  state.queue = computeQueue(state.records, state.cutoff);
  render();
}

function render() {
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

  const hasItems = state.queue.length > 0;
  setVisible(dom.queueList, hasItems);
  setVisible(dom.emptyState, !hasItems && isSignedIn());

  renderQueue(dom.queueList, state.queue, {
    onWatched: (id) => markVideo(id, STATE_WATCHED),
    onNotInterested: (id) => markVideo(id, STATE_NOT_INTERESTED),
  });
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
      markVideo(rows[idx].dataset.videoId, STATE_WATCHED);
    }
  } else if (key === 'x') {
    if (idx >= 0) {
      e.preventDefault();
      markVideo(rows[idx].dataset.videoId, STATE_NOT_INTERESTED);
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
