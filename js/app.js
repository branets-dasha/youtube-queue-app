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
  getCutoff,
  setCutoff,
  getAllVideos,
  putVideos,
  putVideo,
  deleteVideos,
  replaceAllVideos,
  loadChannels,
  saveChannels,
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
  ApiError,
} from './api.js';
import {
  upsertVideos,
  computeQueue,
  computeVisible,
  computeCutoff,
  videosToClean,
  nextPlayable,
  daysAgoIso,
} from './queue.js';
import {
  el,
  showStatus,
  hideStatus,
  renderQueue,
  renderStats,
  renderPlayerMeta,
  setCardState,
  setVisible,
} from './ui.js';
import {
  initPlayer,
  loadVideo as playerLoad,
  setRate as playerSetRate,
} from './player.js';

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
  rate: 1, // player playback rate (1 or 2)
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
  dom.cleanupBtn = byId('cleanup-btn');
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

  // Player pane.
  dom.playerTitle = byId('player-title');
  dom.playerMeta = byId('player-meta');
  dom.playerEmpty = byId('player-empty');
  dom.rate1x = byId('rate-1x');
  dom.rate15x = byId('rate-15x');
  dom.rate2x = byId('rate-2x');
  dom.skipBtn = byId('skip-btn');
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
  dom.cleanupBtn.addEventListener('click', onCleanup);
  dom.changeCutoffBtn.addEventListener('click', openCutoffPanel);
  dom.changeClientBtn.addEventListener('click', openSetupPanel);
  dom.undoBtn.addEventListener('click', onUndo);
  if (dom.rate1x) dom.rate1x.addEventListener('click', () => onRate(1));
  if (dom.rate15x) dom.rate15x.addEventListener('click', () => onRate(1.5));
  if (dom.rate2x) dom.rate2x.addEventListener('click', () => onRate(2));
  if (dom.skipBtn) dom.skipBtn.addEventListener('click', onSkipNext);

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
  updateCleanupUi();
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

    // Zero extra quota: subscriptions.list already returned each subscribed
    // channel's avatar in snippet.thumbnails. Capture + persist the channel map.
    updateChannelsFromSubs(subs);

    // The fetch is bounded by the FLOOR (everything <= floor is gone for good).
    const floor = state.floor;
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
          floor,
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
    showStatus(dom.status, 'Fetching video details…', 'progress');
    await backfillDetails();
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
  // 'new', so a mis-mark can be corrected straight from the still-usable buttons
  // (or with the w/x key), and switching watched<->not_interested just re-marks.
  // `opts.force` (used by auto-mark when a video ENDS) always SETS newState, so a
  // just-finished video is never accidentally toggled back to 'new'.
  const nextState = opts.force
    ? newState
    : prevState === newState
      ? STATE_NEW
      : newState;

  const card = findCard(videoId);

  // Optimistic, SYNCHRONOUS UI update: set the state, grey just this one card in
  // place, refresh the header counts, and (for keyboard marks) advance focus to
  // the next card BEFORE awaiting the persist. Nothing is recomputed, reordered,
  // or pruned, so the list stays perfectly stable across rapid w/x succession.
  rec.state = nextState;
  applyHandledDelta(prevState, nextState);
  state.lastAction = { videoId, prevState };
  if (card) setCardState(card, nextState);
  // The handled prefix may have changed: recompute the live cutoff marker
  // (persist if it moved) + refresh the display/counts/Cleanup button. NO list
  // re-render or deletion — marked videos stay visible until CLEANUP.
  refreshMarkerAndStats();
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
    showStatus(dom.status, 'Cleaned up handled videos.', 'success');
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
    hideUndoBar();
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
  hideUndoBar();

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
    showStatus(dom.status, 'That video can’t be embedded — opened it on YouTube.', 'info');
    return;
  }
  ensurePlayer();
  state.playing = videoId;
  playerLoad(videoId);
  setPlayerNowPlaying(rec);
  markPlayingCard(videoId);
}

function openOnYouTube(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  window.open(url, '_blank', 'noopener');
}

/**
 * Fired when the current video ENDS: auto-mark it 'watched' via the EXISTING
 * markVideo path (force = never toggle), so the cutoff marker + greying +
 * persistence all update; then auto-play the NEXT eligible video — the first one
 * after it that is still 'new' (skips 'watched' AND 'not_interested') and is
 * embeddable — or show the caught-up state when none remain.
 * @param {string} endedId
 */
function onPlayerEnded(endedId) {
  if (!endedId) return;
  markVideo(endedId, STATE_WATCHED, { force: true });
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
 * Skip button: mark the CURRENT video watched and advance — reusing the EXACT
 * same path as auto-advance-on-end (forced markVideo + nextPlayable).
 */
function onSkipNext() {
  if (state.playing) onPlayerEnded(state.playing);
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

  const hasItems = state.visible.length > 0;
  setVisible(dom.queueList, hasItems);
  setVisible(dom.emptyState, !hasItems && isSignedIn());

  // Button clicks are mouse-driven, so they don't advance focus; keyboard w/x
  // (in onGlobalKeydown) pass advanceFocus for rapid down-the-list marking.
  renderQueue(
    dom.queueList,
    state.visible,
    {
      onWatched: (id) => markVideo(id, STATE_WATCHED),
      onNotInterested: (id) => markVideo(id, STATE_NOT_INTERESTED),
      onPlay: (id) => playVideo(id),
    },
    state.channels
  );

  // Re-apply the now-playing highlight after the list is rebuilt.
  if (state.playing) markPlayingCard(state.playing);
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
  dom.cleanupBtn.textContent = `Clean up (${n})`;
  dom.cleanupBtn.disabled = n === 0 || state.refreshing;
}

function showUndoBar() {
  setVisible(dom.undoBar, true);
}
function hideUndoBar() {
  setVisible(dom.undoBar, false);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts:  w = watched, x = not interested, j = move back (older,
// up), k = move forward (newer, down), u = undo. Ignored while typing in an input.
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
    // j = move BACK (previous/older card, upward in the oldest->newest list).
    e.preventDefault();
    if (idx > 0) rows[idx - 1].focus();
    else if (idx === -1 && rows.length) rows[0].focus();
  } else if (key === 'k') {
    // k = move FORWARD (next/newer card, downward).
    e.preventDefault();
    if (idx < rows.length - 1) rows[idx + 1].focus();
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
