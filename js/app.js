// js/app.js
//
// Orchestration / wiring: auth -> fetch -> store -> queue -> ui, plus all
// event binding and first-run onboarding. This is the only module that reaches
// into every layer.

import {
  STATE_NEW,
  STATE_SKIPPED,
  QUEUE_DISPLAY_LIMIT,
  DEFAULT_PLAYBACK_RATE,
  INCREMENTAL_REFRESH_BUFFER_MS,
} from './config.js';
import {
  getClientId,
  setClientId,
  getStartCutoff,
  setStartCutoff,
  getCutoff,
  setCutoff,
  getAllVideos,
  putVideos,
  putVideo,
  deleteVideos,
  replaceAllVideos,
  loadChannels,
  saveChannels,
  getPlaybackRate,
  setPlaybackRate,
  getDefaultRate,
  setDefaultRate,
  getHideMarked,
  setHideMarked,
} from './store.js';
import {
  waitForGis,
  initAuth,
  requestToken,
  isSignedIn,
  revoke,
} from './auth.js';
import {
  getSubscriptions,
  getChannelVideosSince,
  getVideoDetails,
  rateVideo,
  ApiError,
} from './api.js';
import {
  upsertVideos,
  computeQueue,
  computeVisible,
  computeCutoff,
  videosToClean,
  nextPlayable,
  resumeStart,
  effectiveRate,
  daysAgoIso,
  incrementalSince,
} from './queue.js';
import {
  el,
  showStatus,
  hideStatus,
  renderQueue,
  renderStats,
  renderPlayerMeta,
  setCardState,
  setCardRate,
  setVisible,
} from './ui.js';
import {
  initPlayer,
  loadVideo as playerLoad,
  setRate as playerSetRate,
  capturePosition,
  togglePlay,
  seekBy,
  toggleMute,
  requestFullscreen,
  getIframe as getPlayerIframe,
} from './player.js';
import { showToast } from './toast.js';

// ---------------------------------------------------------------------------
// Application state (in-memory)
// ---------------------------------------------------------------------------

const state = {
  clientId: null,
  floor: null, // deletion + fetch boundary (yqa_start_cutoff); moves forward only, on cleanup
  cutoff: null, // live handled-prefix marker (yqa_cutoff); displayed; cleanup deletes up to it
  records: [], // all stored video records
  channels: {}, // channelId -> { title, avatarUrl } for card avatars (persisted)
  visible: [], // derived: computeVisible(records, FLOOR) — render list (any state)
  queue: [], // derived: computeQueue(records, FLOOR) — still-'new' subset, for the count
  handledThisSession: 0,
  lastAction: null, // { videoId, prevState } for undo
  refreshing: false,
  playing: null, // videoId currently loaded in the on-page player
  playerInited: false,
  rate: 1, // player playback rate (1 / 1.5 / 2)
  defaultRate: null, // default-speed setting for new videos (1 / 1.5 / 2 or null = unset)
  showAll: false, // render window: false = first QUEUE_DISPLAY_LIMIT cards (in-memory only)
  hideMarked: false, // view filter: hide skipped (handled) videos (persisted)
  curtain: false, // privacy curtain overlay: true = raised (covering the page)
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
  state.floor = getStartCutoff(); // deletion/fetch boundary
  state.cutoff = getCutoff(); // live marker (may be absent on older installs)

  // Show the current origin in the setup instructions so the user can copy the
  // exact "Authorized JavaScript origins" value.
  if (dom.originHint) dom.originHint.textContent = window.location.origin;

  // Load persisted videos up front.
  try {
    state.records = await getAllVideos();
  } catch {
    state.records = [];
  }

  // Load the persisted channel avatar/title map BEFORE the first render so
  // avatars appear immediately for already-stored videos (zero API cost).
  state.channels = loadChannels();

  // Restore the persisted playback rate (validated; fall back to default 1x for
  // anything not 1/1.5/2). player.js applies it on each video load; the button
  // highlight is set by updateRateButtons when the app view shows.
  const storedRate = getPlaybackRate();
  state.rate = [1, 1.5, 2].includes(storedRate) ? storedRate : DEFAULT_PLAYBACK_RATE;
  playerSetRate(state.rate);

  // Restore the persisted DEFAULT-speed setting (validated; unset unless 1/1.5/2)
  // and reflect the toolbar button label.
  const storedDefault = getDefaultRate();
  state.defaultRate = [1, 1.5, 2].includes(storedDefault) ? storedDefault : null;
  updateDefaultRateButton();

  // Restore the persisted "hide handled" view toggle and reflect the button.
  state.hideMarked = getHideMarked();
  updateHideMarkedButton();

  // INIT is one of the three CLEANUP sites. Migrate installs that predate the
  // cutoff key (derive it from floor), then run cleanup BEFORE the first render.
  if (state.floor) {
    if (!state.cutoff) {
      state.cutoff = computeCutoff(state.records, state.floor);
      setCutoff(state.cutoff);
    }
    try {
      await cleanup();
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
  dom.refreshNewBtn = byId('refresh-new-btn');
  dom.cleanupBtn = byId('cleanup-btn');
  dom.hideMarkedBtn = byId('hide-marked-btn');
  dom.defaultRateBtn = byId('default-rate-btn');
  dom.changeCutoffBtn = byId('change-cutoff-btn');
  dom.changeClientBtn = byId('change-client-btn');

  dom.queuedCount = byId('queued-count');
  dom.handledCount = byId('handled-count');
  dom.cutoffDisplay = byId('cutoff-display');

  dom.queueList = byId('queue-list');
  dom.emptyState = byId('empty-state');
  dom.curtain = byId('curtain');

  // Player pane.
  dom.playerTitle = byId('player-title');
  dom.playerMeta = byId('player-meta');
  dom.playerEmpty = byId('player-empty');
  dom.rate1x = byId('rate-1x');
  dom.rate15x = byId('rate-15x');
  dom.rate2x = byId('rate-2x');
  dom.skipBtn = byId('skip-btn');
  dom.likeBtn = byId('like-btn');
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
  if (dom.refreshNewBtn) dom.refreshNewBtn.addEventListener('click', onRefreshNew);
  dom.cleanupBtn.addEventListener('click', onCleanup);
  if (dom.hideMarkedBtn) dom.hideMarkedBtn.addEventListener('click', onToggleHideMarked);
  if (dom.defaultRateBtn) dom.defaultRateBtn.addEventListener('click', onCycleDefaultRate);
  dom.changeCutoffBtn.addEventListener('click', openCutoffPanel);
  dom.changeClientBtn.addEventListener('click', openSetupPanel);
  if (dom.rate1x) dom.rate1x.addEventListener('click', () => onRate(1));
  if (dom.rate15x) dom.rate15x.addEventListener('click', () => onRate(1.5));
  if (dom.rate2x) dom.rate2x.addEventListener('click', () => onRate(2));
  if (dom.skipBtn) dom.skipBtn.addEventListener('click', onSkipNext);
  if (dom.likeBtn) dom.likeBtn.addEventListener('click', onLike);

  document.addEventListener('keydown', onGlobalKeydown);
  window.addEventListener('wheel', onGlobalWheel, { passive: true });

  // Clicking the video moves keyboard focus INTO the cross-origin player iframe,
  // which swallows keydown so the app's shortcuts (incl. the Esc curtain) stop
  // firing. On window blur, if focus landed on the player iframe, hand it back to
  // the document so keydown keeps reaching us. Guard against stealing focus when
  // the user simply switched tab/app (page hidden / window not focused).
  window.addEventListener('blur', onWindowBlur);

  // Save the current watch position on hide/unload so a reload can resume.
  window.addEventListener('pagehide', flushProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProgress();
  });

  // Safety net: never let an async failure vanish silently. Any unhandled
  // promise rejection is surfaced to the user via an error toast.
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
  if (!state.floor) {
    openCutoffPanel();
    return;
  }
  showMainApp();
}

function openSetupPanel() {
  setVisible(dom.setupPanel, true);
  setVisible(dom.cutoffPanel, false);
  setVisible(dom.appMain, false);
  document.body.classList.remove('app-active'); // onboarding scrolls normally
  if (state.clientId) dom.clientIdInput.value = state.clientId;
  dom.clientIdInput.focus();
}

function openCutoffPanel() {
  setVisible(dom.cutoffPanel, true);
  // This panel sets the FLOOR (start boundary). Seed with the existing floor,
  // else 7 days ago.
  const seed = state.floor || daysAgoIso(7, Date.now());
  dom.cutoffInput.value = isoToLocalInput(seed);
  // Keep the main app visible behind if we already have a floor (this is a
  // "change cutoff" re-open); otherwise hide it.
  if (!state.floor) {
    setVisible(dom.appMain, false);
    setVisible(dom.setupPanel, false);
    document.body.classList.remove('app-active');
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

  if (!state.floor) {
    openCutoffPanel();
  } else {
    showMainApp();
  }
}

function onSaveCutoff() {
  const raw = dom.cutoffInput.value;
  let floor;
  if (!raw) {
    // Fall back to 7 days ago if the user cleared it.
    floor = daysAgoIso(7, Date.now());
  } else {
    // datetime-local yields local wall-clock; convert to ISO (UTC).
    const d = new Date(raw);
    floor = Number.isNaN(d.getTime()) ? daysAgoIso(7, Date.now()) : d.toISOString();
  }
  state.floor = floor;
  setStartCutoff(floor);
  // Derive + persist the live cutoff marker from the present records.
  state.cutoff = computeCutoff(state.records, state.floor);
  setCutoff(state.cutoff);
  setVisible(dom.cutoffPanel, false);

  // Re-derive the render list against the (possibly) new floor and re-render.
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
  document.body.classList.add('app-active'); // two-pane full-height layout
  ensurePlayer();
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
  if (dom.refreshNewBtn) dom.refreshNewBtn.disabled = !signed || state.refreshing;
  updateCleanupUi();
  updateLikeButton(); // re-evaluate: signing out disables it (visual liked stays)
}

async function onSignIn() {
  try {
    await waitForGis();
    initAuth(state.clientId);
    showProgress('Opening Google sign-in…');
    await requestToken({ interactive: true });
    hideProgress();
    updateAuthUi();
    // Do NOT auto-fetch here: signing in only updates auth/UI state. Videos load
    // only when the user explicitly clicks Refresh (onRefresh).
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
// Refresh (fetch newer)
// ---------------------------------------------------------------------------

/**
 * "Refresh all" (full): the per-channel lower bound is the FLOOR, so every
 * channel is paged down to the floor (the full back-catalog since the cutoff).
 */
async function onRefresh() {
  return runRefresh(state.floor);
}

/**
 * "Refresh new" (incremental): the per-channel lower bound is the newest stored
 * publishedAt minus a lag buffer (clamped to the floor), so each channel is
 * usually paged just one page — only genuinely newer uploads are pulled. On the
 * first-ever run (no records) the bound is the floor, i.e. a full refresh.
 * KNOWN LIMITATION: back-catalog of channels subscribed since the last full
 * refresh (older than the bound) is NOT pulled — use "Refresh all" for that.
 */
async function onRefreshNew() {
  const bound = incrementalSince(state.records, state.floor, INCREMENTAL_REFRESH_BUFFER_MS);
  return runRefresh(bound);
}

/**
 * Shared refresh pipeline. `bound` is the per-channel lower bound passed to the
 * uploads fetch — the ONLY thing that differs between "Refresh all" (floor) and
 * "Refresh new" (incremental). Everything else — subscriptions + avatars, the
 * per-channel uploads paging, details backfill, upsert, cleanup, render, the
 * progress toast and the summary — is identical.
 * @param {string|null} bound ISO lower bound for the per-channel uploads fetch
 */
async function runRefresh(bound) {
  if (state.refreshing) return;
  if (!isSignedIn()) {
    return onSignIn();
  }
  state.refreshing = true;
  dom.refreshBtn.disabled = true;
  if (dom.refreshNewBtn) dom.refreshNewBtn.disabled = true;
  hideProgress();

  try {
    await waitForGis();
    initAuth(state.clientId);

    showProgress('Loading your subscriptions…');
    const subs = await getSubscriptions();

    if (subs.length === 0) {
      showToast('No subscriptions found on this account.', { type: 'info' });
      state.refreshing = false;
      updateAuthUi();
      return;
    }

    // Zero extra quota: subscriptions.list already returned each subscribed
    // channel's avatar in snippet.thumbnails. Capture + persist the channel map.
    updateChannelsFromSubs(subs);

    // Per-channel uploads are paged only until they reach `bound` (floor for a
    // full refresh, newest-minus-buffer for an incremental one).
    const collected = [];
    let skipped = 0;

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i];
      // Updates the SINGLE progress toast in place (no new toast per tick).
      showProgress(`Fetching channel ${i + 1} of ${subs.length}: ${sub.channelTitle}`);
      try {
        const vids = await getChannelVideosSince(
          sub.channelId,
          bound,
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

    // SYNC is a CLEANUP site: after upserting, recompute the marker, delete the
    // handled prefix, and advance the floor.
    await cleanup();

    // Duration + embeddability are not in playlistItems: batch
    // videos.list?part=contentDetails,status (<=50 ids/call, 1 unit each; adding
    // `status` is 0 extra quota) for the surviving visible videos lacking either
    // (covers newly fetched + backfill of older ones). Then the final render.
    showProgress('Fetching video details…');
    await backfillDetails();
    recompute();

    const parts = [`Refreshed. ${collected.length} item(s) fetched.`];
    if (skipped > 0) parts.push(`${skipped} channel(s) skipped (deleted/unavailable).`);
    showToast(parts.join(' '), { type: 'success' });
  } catch (err) {
    handleError(err);
  } finally {
    // Always dismiss the progress toast when a refresh ends (success/error/early).
    hideProgress();
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

/**
 * Merge the channel avatar/title map from a subscriptions fetch and persist it.
 * Zero extra quota — the avatars ride along in subscriptions.list snippets.
 * @param {Array<{channelId:string,channelTitle:string,avatarUrl:string}>} subs
 */
function updateChannelsFromSubs(subs) {
  let changed = false;
  for (const s of subs) {
    if (!s.channelId) continue;
    const prev = state.channels[s.channelId];
    const title = s.channelTitle || (prev && prev.title) || '';
    const avatarUrl = s.avatarUrl || (prev && prev.avatarUrl) || '';
    if (!prev || prev.title !== title || prev.avatarUrl !== avatarUrl) {
      state.channels[s.channelId] = { title, avatarUrl };
      changed = true;
    }
  }
  if (changed) saveChannels(state.channels);
}

/**
 * Fill in durationSeconds + embeddable for currently-visible videos that lack
 * either (covers both newly fetched videos and backfill of older ones), via a
 * batched videos.list. These are enhancements (badges + playability), so
 * failures are swallowed — a refresh is never failed over them.
 */
async function backfillDetails() {
  const missing = computeVisible(state.records, state.floor)
    .filter(
      (r) =>
        typeof r.durationSeconds !== 'number' || typeof r.embeddable !== 'boolean'
    )
    .map((r) => r.videoId);
  if (missing.length === 0) return;
  try {
    const details = await getVideoDetails(missing);
    if (details.size === 0) return;
    for (const r of state.records) {
      const d = details.get(r.videoId);
      if (!d) continue;
      if (typeof d.durationSeconds === 'number') r.durationSeconds = d.durationSeconds;
      if (typeof d.embeddable === 'boolean') r.embeddable = d.embeddable;
    }
    await putVideos(state.records);
  } catch {
    /* enhancements only; never fail a refresh over them */
  }
}

// ---------------------------------------------------------------------------
// Marking actions + cutoff advancement + pruning
// ---------------------------------------------------------------------------

async function markVideo(videoId, newState, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  const prevState = rec.state;
  // Toggle semantics: acting on a state the card is already in reverts it to
  // 'new', so a mis-skip can be corrected straight from the still-usable button
  // (or with the x key). `opts.force` (used by auto-mark when a video ENDS)
  // always SETS newState, so a just-finished video is never toggled back to 'new'.
  const nextState = opts.force
    ? newState
    : prevState === newState
      ? STATE_NEW
      : newState;

  const card = findCard(videoId);

  // Optimistic, SYNCHRONOUS UI update: set the state, grey just this one card in
  // place, refresh the header counts, and (for keyboard marks) advance focus to
  // the next card BEFORE awaiting the persist. Nothing is recomputed, reordered,
  // or pruned, so the list stays perfectly stable across rapid Skip succession.
  rec.state = nextState;
  applyHandledDelta(prevState, nextState);
  state.lastAction = { videoId, prevState };

  // When "hide handled" is ON and this video just became marked, REMOVE only its
  // card (lightweight — no full re-render, no scroll jump), advancing focus to the
  // next (or previous) card. Otherwise keep the grey-in-place behaviour: marked
  // videos stay visible/greyed until CLEANUP; the `u` shortcut + toggle-off undo.
  const removedCard = state.hideMarked && nextState !== STATE_NEW && !!card;
  if (removedCard) {
    let focusTarget = null;
    if (opts.advanceFocus) {
      const rows = Array.from(dom.queueList.querySelectorAll('.row'));
      const i = rows.indexOf(card);
      if (i >= 0) focusTarget = rows[i + 1] || rows[i - 1] || null;
    }
    card.remove();
    if (focusTarget) focusTarget.focus();
  } else if (card) {
    setCardState(card, nextState);
    if (opts.advanceFocus) {
      const next = nextRowAfter(card);
      if (next) next.focus();
    }
  }
  // Recompute the live cutoff marker (persist if it moved) + refresh the header
  // counts / Cleanup button. No data re-render/deletion here.
  refreshMarkerAndStats();

  try {
    await putVideo(rec);
  } catch (err) {
    // Persistence failed: revert the optimistic changes so memory matches store.
    rec.state = prevState;
    applyHandledDelta(nextState, prevState);
    if (removedCard) {
      render(); // the card was removed; rebuild the (windowed) view to restore it
    } else if (card) {
      setCardState(card, prevState);
    }
    refreshMarkerAndStats();
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
 * CLEANUP — the ONLY place videos are deleted and the FLOOR advances. Recompute
 * the live cutoff marker, delete every present video with publishedAt <= cutoff,
 * advance the floor to the cutoff, and persist both. Runs in exactly three
 * places: page load (init), sync-with-YouTube, and the Cleanup button. It does
 * NOT render — callers recompute()/render afterwards.
 */
async function cleanup() {
  const cutoff = computeCutoff(state.records, state.floor);

  const toClean = videosToClean(state.records, cutoff);
  if (toClean.length > 0) {
    const ids = toClean.map((r) => r.videoId);
    const idSet = new Set(ids);
    state.records = state.records.filter((r) => !idSet.has(r.videoId));
    await deleteVideos(ids);
  }

  // The floor advances to the deletion boundary; persist it.
  if (cutoff && cutoff !== state.floor) {
    state.floor = cutoff;
    setStartCutoff(cutoff);
  }

  // With the handled prefix gone, recompute + persist the marker (now == floor).
  state.cutoff = computeCutoff(state.records, state.floor);
  setCutoff(state.cutoff);
}

/**
 * Cleanup button handler: run CLEANUP() then re-render. The only user-triggered
 * deletion of handled videos.
 */
async function onCleanup() {
  if (state.refreshing) return;
  try {
    await cleanup();
    recompute();
    showToast('Cleaned up handled videos.', { type: 'success' });
  } catch (err) {
    handleError(err);
  }
}

async function onUndo() {
  const action = state.lastAction;
  if (!action) return;

  const rec = state.records.find((r) => r.videoId === action.videoId);
  if (!rec) {
    // The video is no longer present (e.g. pruned by a reload). Nothing to undo.
    state.lastAction = null;
    return;
  }

  const curState = rec.state;
  const card = findCard(action.videoId);

  // Optimistically revert to the pre-mark state and un-grey the card in place.
  rec.state = action.prevState;
  applyHandledDelta(curState, action.prevState);
  if (card) setCardState(card, action.prevState);
  // Un-marking a video inside the handled prefix moves the cutoff BACK (to the
  // floor if it was the oldest); that video stays visible in the queue.
  refreshMarkerAndStats();
  state.lastAction = null;

  try {
    await putVideo(rec);
  } catch (err) {
    // Roll back the optimistic revert on persistence failure.
    rec.state = curState;
    applyHandledDelta(action.prevState, curState);
    if (card) setCardState(card, curState);
    refreshMarkerAndStats();
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
// On-page player (right pane): play, auto-advance + auto-mark, speed
// ---------------------------------------------------------------------------

/** Create the YT.Player once, on first entry to the main app. */
function ensurePlayer() {
  if (state.playerInited) return;
  state.playerInited = true;
  initPlayer({
    mountId: 'player-mount',
    onEnded: onPlayerEnded,
    onReady: () => updateRateButtons(),
    onProgress: onPlayerProgress,
  });
  updateRateButtons();
}

/**
 * Play a video in the embedded right-pane player. Non-embeddable videos can't be
 * framed, so fall back to opening them on YouTube with a brief notice.
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
  // Apply the EFFECTIVE rate before loading — via onRate, so the player +
  // speed-button highlight + the persisted global rate all update and carry
  // forward. Priority: this video's preferredRate, else the user's default-speed
  // setting, else the current rate (retain the previous video's speed).
  onRate(effectiveRate(rec.preferredRate, state.defaultRate, state.rate));
  // Resume from the saved position when it's a meaningful mid-point, else start 0.
  const start = resumeStart(rec.positionSeconds, rec.durationSeconds);
  playerLoad(videoId, start);
  setPlayerNowPlaying(rec);
  markPlayingCard(videoId);
  updateLikeButton(); // from the record's local `liked` flag (no fetch)
}

function openOnYouTube(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  window.open(url, '_blank', 'noopener');
}

/**
 * Fired when the current video ENDS: auto-mark it 'skipped' via the EXISTING
 * markVideo path (force = never toggle), so the cutoff marker + greying +
 * persistence all update; then auto-play the NEXT eligible video — the first one
 * after it that is still 'new' (skips any handled video) and is embeddable — or
 * show the caught-up state when none remain.
 * @param {string} endedId
 */
function onPlayerEnded(endedId) {
  if (!endedId) return;
  // Reset the saved position so a finished video won't resume at its very end.
  const rec = state.records.find((r) => r.videoId === endedId);
  if (rec) rec.positionSeconds = 0;
  markVideo(endedId, STATE_SKIPPED, { force: true }); // persists rec (incl. position)
  const next = nextPlayable(state.visible, endedId);
  if (next) playVideo(next.videoId);
  else showPlayerEmpty(true);
}

function setPlayerNowPlaying(rec) {
  if (dom.playerTitle) dom.playerTitle.textContent = rec ? rec.title : ''; // safe text
  // Channel avatar + name + posted date, like the queue cards (updated on every
  // load, incl. auto-advance).
  renderPlayerMeta(dom.playerMeta, rec, state.channels);
  setVisible(dom.playerEmpty, false);
  if (dom.skipBtn) dom.skipBtn.disabled = false;
}

/** Show the player's empty state ("select" initially, "caught up" after a run). */
function showPlayerEmpty(caughtUp) {
  state.playing = null;
  if (dom.playerTitle) dom.playerTitle.textContent = '';
  renderPlayerMeta(dom.playerMeta, null);
  if (dom.playerEmpty) {
    dom.playerEmpty.textContent = caughtUp
      ? 'All caught up — nothing left to play.'
      : 'Select a video to play';
    setVisible(dom.playerEmpty, true);
  }
  if (dom.skipBtn) dom.skipBtn.disabled = true;
  updateLikeButton(); // state.playing is null -> disabled, not liked
  markPlayingCard(null);
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

function onRate(rate) {
  state.rate = rate;
  playerSetRate(rate);
  setPlaybackRate(rate); // persist across reloads
  updateRateButtons();
}

function updateRateButtons() {
  const rates = [
    [dom.rate1x, 1],
    [dom.rate15x, 1.5],
    [dom.rate2x, 2],
  ];
  for (const [btn, r] of rates) {
    if (!btn) continue;
    btn.classList.toggle('is-active', state.rate === r);
    btn.setAttribute('aria-pressed', String(state.rate === r));
  }
}

/**
 * Set/toggle a card's per-video preferred speed. Does NOT start playback: it
 * persists `preferredRate` on the record and updates just that card's speed
 * buttons in place. Clicking the active speed toggles it OFF. If the card IS the
 * currently-playing video, SETTING a speed applies it live (unsetting does not).
 * @param {string} videoId
 * @param {number} rate 1 | 1.5 | 2
 */
function onCardRate(videoId, rate) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const wasActive = rec.preferredRate === rate;
  rec.preferredRate = wasActive ? undefined : rate; // click active -> toggle off
  putVideo(rec).catch(() => {}); // persist (whole-record write)
  const card = findCard(videoId);
  if (card) setCardRate(card, rec.preferredRate);
  // Live-apply only when SETTING a speed for the currently-playing video.
  if (!wasActive && state.playing === videoId) onRate(rate);
}

/**
 * Skip button: mark the CURRENT video skipped and advance — reusing the EXACT
 * same path as auto-advance-on-end (forced markVideo + nextPlayable).
 */
function onSkipNext() {
  if (state.playing) onPlayerEnded(state.playing);
}

// --- Watch progress (track + resume) ---

/**
 * Persist the watch position reported by the player (~every 5s while playing,
 * and on pause/switch/hide). Preserved through upsert via {...prev}; used by
 * resumeStart on the next play.
 */
function onPlayerProgress(videoId, seconds) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const pos = Math.floor(seconds || 0);
  if (rec.positionSeconds === pos) return;
  rec.positionSeconds = pos;
  putVideo(rec).catch(() => {}); // best-effort throttled persist
}

/** Best-effort capture + persist of the current position on page hide/unload. */
function flushProgress() {
  capturePosition(); // -> onPlayerProgress -> putVideo
}

// --- Like button (player only) ---

/** The record currently loaded in the player, or null. */
function playingRecord() {
  return state.playing ? state.records.find((r) => r.videoId === state.playing) : null;
}

/**
 * Reflect the Like button from the CURRENT record's LOCAL `liked` flag (no API
 * fetch). The VISUAL filled/active state is informational and shown even when
 * signed out; the button is ENABLED only when signed in AND a video is playing.
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
  // Enabled only when SIGNED IN and a video is playing (visual state is separate).
  dom.likeBtn.disabled = !state.playing || !isSignedIn();
}

/**
 * Toggle the current video's like: rateVideo(id,'like'|'none') writes to YouTube;
 * on success the local `liked` flag is set + PERSISTED (so it survives reload
 * with no fetch/quota). Optimistic; reverts the flag on error. A scope error
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

  // Optimistic (visual) update.
  rec.liked = nextLiked;
  updateLikeButton();

  try {
    await rateVideo(videoId, nextRating); // ~50 quota units; writes to YouTube
    putVideo(rec).catch(() => {}); // persist the local liked flag on success
  } catch (err) {
    if (err instanceof ApiError && (err.kind === 'auth' || err.kind === 'forbidden')) {
      // Write scope not granted yet: re-consent for the new scope, then retry once.
      try {
        showToast('Requesting YouTube access to like videos…', { type: 'info' });
        await waitForGis();
        initAuth(state.clientId);
        await requestToken({ interactive: true });
        await rateVideo(videoId, nextRating);
        putVideo(rec).catch(() => {}); // persist on success
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
// Derivation + rendering
// ---------------------------------------------------------------------------

function recompute() {
  // The render list is FLOOR-based and includes ALL in-window videos (any state)
  // — so a marked video with publishedAt > floor stays visible (greyed) and does
  // NOT disappear on marking. The queue is the still-'new' subset for the count.
  state.visible = computeVisible(state.records, state.floor);
  state.queue = computeQueue(state.records, state.floor);
  render();
}

function render() {
  updateStats();

  // PURE view filter: "hide handled" shows only still-'new' videos. Applied to
  // state.visible BEFORE the window/Show-all slice; floor/cutoff/cleanup/data and
  // auto-advance (nextPlayable) are untouched (state.visible itself is unchanged).
  const viewList = state.hideMarked
    ? state.visible.filter((r) => r.state === STATE_NEW)
    : state.visible;

  const total = viewList.length;
  const hasItems = total > 0;
  setVisible(dom.queueList, hasItems);
  setVisible(dom.emptyState, !hasItems && isSignedIn());

  // PURE display windowing: render only the first QUEUE_DISPLAY_LIMIT cards of the
  // (filtered) view by default; the "Show all (N)" count reflects the filtered
  // total. state.visible and auto-advance are untouched — only rendered CARDS are
  // limited. All re-render paths (cleanup, refresh, toggle) run through here.
  const windowed = state.showAll ? viewList : viewList.slice(0, QUEUE_DISPLAY_LIMIT);
  const more =
    !state.showAll && total > QUEUE_DISPLAY_LIMIT ? { total, onShowAll } : null;

  // Button clicks are mouse-driven, so they don't advance focus; the keyboard x
  // (in onGlobalKeydown) passes advanceFocus for rapid down-the-list skipping.
  renderQueue(
    dom.queueList,
    windowed,
    {
      onSkip: (id) => markVideo(id, STATE_SKIPPED),
      onPlay: (id) => playVideo(id),
      onCardRate: (id, rate) => onCardRate(id, rate),
    },
    state.channels,
    more
  );

  // Re-apply the now-playing highlight after the list is rebuilt.
  if (state.playing) markPlayingCard(state.playing);
}

/**
 * "Show all (N)" button: reveal the full queue for THIS session. In-memory only
 * (not persisted) — a page reload reverts to the first QUEUE_DISPLAY_LIMIT.
 */
function onToggleHideMarked() {
  state.hideMarked = !state.hideMarked;
  setHideMarked(state.hideMarked); // persist across reloads
  updateHideMarkedButton();
  render(); // normal windowed re-render, applying/removing the filter
}

/** Reflect the hide-handled toggle's label + aria-pressed from state.hideMarked. */
function updateHideMarkedButton() {
  if (!dom.hideMarkedBtn) return;
  dom.hideMarkedBtn.textContent = state.hideMarked ? 'Show handled' : 'Hide handled';
  dom.hideMarkedBtn.setAttribute('aria-pressed', String(state.hideMarked));
}

/**
 * Cycle the DEFAULT-speed setting on click: unset -> 1× -> 1.5× -> 2× -> unset.
 * Persists the choice and updates the toolbar label. Does not touch the current
 * playback rate — it only changes the fallback applied to future plays of videos
 * that have no per-video preferred speed (via effectiveRate).
 */
function onCycleDefaultRate() {
  const cycle = [null, 1, 1.5, 2];
  const i = cycle.indexOf(state.defaultRate);
  const next = cycle[(Math.max(0, i) + 1) % cycle.length];
  state.defaultRate = next;
  setDefaultRate(next); // null removes the key
  updateDefaultRateButton();
}

/** Reflect the default-speed setting on the toolbar button ("off" when unset). */
function updateDefaultRateButton() {
  if (!dom.defaultRateBtn) return;
  const dr = state.defaultRate;
  const label = [1, 1.5, 2].includes(dr) ? `${dr}×` : 'off';
  dom.defaultRateBtn.textContent = `Default speed: ${label}`;
}

function onShowAll() {
  state.showAll = true;
  render();
}

/**
 * Recompute the live cutoff marker from the present records + floor; persist it
 * if it moved. Then refresh the header stats and the Cleanup button. Called on
 * every mark/unmark so the DISPLAYED cutoff updates LIVE — no list re-render.
 */
function refreshMarkerAndStats() {
  const next = computeCutoff(state.records, state.floor);
  if (next !== state.cutoff) {
    state.cutoff = next;
    setCutoff(next);
  }
  updateStats();
}

/**
 * Refresh the header stats (counts + displayed cutoff marker) and the Cleanup
 * button without touching the list, so marking a card never re-renders the queue.
 * The queued count and render list are FLOOR-based; the displayed "Cutoff" shows
 * the live marker.
 */
function updateStats() {
  state.queue = computeQueue(state.records, state.floor);
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
  updateCleanupUi();
}

/**
 * Update the Cleanup button's label + disabled state. Count = present videos
 * with publishedAt <= cutoff (the set CLEANUP would delete); disabled at 0 or
 * while a refresh is running.
 */
function updateCleanupUi() {
  if (!dom.cleanupBtn) return;
  const n = videosToClean(state.records, state.cutoff).length;
  dom.cleanupBtn.textContent = `Trim front (${n})`;
  dom.cleanupBtn.disabled = n === 0 || state.refreshing;
}

// ---------------------------------------------------------------------------
// Notifications (top-right toasts)
// ---------------------------------------------------------------------------

let progressToast = null;
/** Show or UPDATE the single progress toast in place (sticky until hidden). */
function showProgress(message) {
  if (progressToast) progressToast.update(message);
  else progressToast = showToast(message, { type: 'progress' });
}
/** Dismiss the progress toast if one is showing. */
function hideProgress() {
  if (progressToast) {
    progressToast.dismiss();
    progressToast = null;
  }
}

/**
 * Step the playback rate up/down through the [1, 1.5, 2] presets (clamped, no
 * wrap) via onRate (which sets, persists, and updates the buttons).
 * @param {number} dir -1 (slower) or +1 (faster)
 */
function cyclePlaybackRate(dir) {
  const rates = [1, 1.5, 2];
  let i = rates.indexOf(state.rate);
  if (i === -1) i = 0;
  const next = rates[Math.min(rates.length - 1, Math.max(0, i + dir))];
  if (next !== state.rate) onRate(next);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts. QUEUE: j/k move, x skip, u undo, Enter play focused card.
// PLAYER: Space play/pause, ←/→ seek, -/+ speed, n
// next, l like, m mute, f fullscreen. Ignored while typing in an input/textarea,
// during onboarding, and for Ctrl/Cmd/Alt combos (Shift stays allowed for '+').
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Privacy curtain: a full-viewport overlay that hides the whole page. Raised by
// a wheel-DOWN anywhere outside the queue's own scroll area (or Esc), lifted by
// a wheel-UP (or Esc). Visual only — the player is NOT paused.
// ---------------------------------------------------------------------------

/** Reflect state.curtain onto the overlay element (class + aria). */
function setCurtain(up) {
  state.curtain = up;
  if (!dom.curtain) return;
  dom.curtain.classList.toggle('is-up', up);
  dom.curtain.setAttribute('aria-hidden', String(!up));
}

/** Wheel handler: scroll INSIDE the queue scrolls it; elsewhere it drives the
 *  curtain — down raises, up lifts (binary by direction). While the curtain is
 *  up it is on top, so a wheel event's target is the curtain (not the queue),
 *  and a scroll-up over it lifts it. DISABLED in the stacked (<=900px) layout,
 *  where the page scrolls as one column — there only Esc toggles the curtain. */
function onGlobalWheel(e) {
  // Stacked layout: the whole page scrolls, so a wheel trigger would fight normal
  // scrolling. Reuse the same breakpoint as the player-above-queue stack.
  if (window.matchMedia('(max-width: 900px)').matches) return;
  const t = e.target;
  // Let the queue's own scroll area scroll normally (never triggers the curtain).
  if (t && typeof t.closest === 'function' && t.closest('.workspace__queue')) return;
  if (e.deltaY > 0) {
    if (!state.curtain) setCurtain(true); // scroll down -> raise
  } else if (e.deltaY < 0) {
    if (state.curtain) setCurtain(false); // scroll up -> lift
  }
}

/** On window blur, if focus moved into the cross-origin player iframe, return it
 *  to the document so the app keeps receiving keydown (Esc + shortcuts). Guarded
 *  so alt-tabbing away (page hidden) doesn't yank focus back. */
function onWindowBlur() {
  // Defer so document.activeElement settles to the newly-focused iframe.
  setTimeout(() => {
    if (document.hidden) return; // switched tab/app: leave focus alone
    const iframe = getPlayerIframe();
    if (iframe && document.activeElement === iframe) {
      iframe.blur(); // returns focus to document.body; keydown reaches us again
    }
  }, 0);
}

function onGlobalKeydown(e) {
  // PANIC KEY: Esc toggles the curtain, handled BEFORE any guard so it works in
  // every layout and even during onboarding. Ignore modifier combos.
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    setCurtain(!state.curtain);
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
    // k = move FORWARD (next/newer card, downward).
    e.preventDefault();
    if (idx < rows.length - 1) rows[idx + 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'x') {
    // x = Skip: toggle the focused card between new and skipped.
    if (idx >= 0) {
      e.preventDefault();
      markVideo(rows[idx].dataset.videoId, STATE_SKIPPED, { advanceFocus: true });
    }
  } else if (key === '1' || key === '2') {
    // Set the FOCUSED card's preferred speed. Reuses the card speed-button
    // behavior: toggles off if already set, no playback, applies live only if
    // the focused card is the one currently playing. (1.5× lives in the player.)
    if (idx >= 0) {
      e.preventDefault();
      onCardRate(rows[idx].dataset.videoId, Number(key));
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
      e.preventDefault(); // otherwise the arrow scrolls the queue
      seekBy(-5);
    }
  } else if (key === 'arrowright') {
    if (state.playing) {
      e.preventDefault();
      seekBy(5);
    }
  } else if (key === '-') {
    cyclePlaybackRate(-1);
  } else if (key === '=' || key === '+') {
    cyclePlaybackRate(1);
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

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleError(err) {
  if (err instanceof ApiError) {
    if (err.kind === 'auth') {
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
