// js/app.js
//
// Orchestration / wiring: auth -> fetch -> store -> queue -> ui, plus all
// event binding and first-run onboarding. This is the only module that reaches
// into every layer.

import {
  STATE_NEW,
  STATE_SKIPPED,
  QUEUE_DISPLAY_LIMIT,
  DEFAULT_PLAYBACK_SPEED,
  INCREMENTAL_REFRESH_BUFFER_MS,
  TAB_LOCK,
} from './config.js';
import { migrateLocalStorage } from './migrations.js';
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
  loadChannels,
  saveChannels,
  loadChannelPrefs,
  saveChannelPrefs,
  getPlaybackSpeed,
  setPlaybackSpeed,
  getDefaultSpeed,
  setDefaultSpeed,
  getHideMarked,
  setHideMarked,
  standDownForOtherTab,
  DbBlockedError,
  DbUnavailableError,
} from './store.js';
import {
  waitForGis,
  initAuth,
  requestToken,
  hasSession,
  clearToken,
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
  computeQueue,
  computeVisible,
  computeCutoff,
  videosToClean,
  lastSkipped,
  nextPlayable,
  firstPlayable,
  resumeStart,
  effectiveSpeed,
  daysAgoIso,
  incrementalSince,
  isChannelIgnored,
  pruneChannels,
  mergeRefresh,
} from './queue.js';
import {
  el,
  showStatus,
  hideStatus,
  renderQueue,
  renderStats,
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
  playerCaughtUp: false, // TEXT-selector only: playback stopped because the queue ran out
  speed: 1, // player playback speed (1 / 1.5 / 2)
  defaultSpeed: null, // default-speed setting for new videos (1 / 1.5 / 2 or null = unset)
  showAll: false, // render window: false = first QUEUE_DISPLAY_LIMIT cards (in-memory only)
  hideMarked: false, // view filter: hide skipped (handled) videos (persisted)
  curtain: false, // privacy curtain overlay: true = covering the page
};

// DOM references, populated in init().
const dom = {};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Single-tab guard, first thing: ask for the tab lock (see the section below).
  requestTabLock();

  // The overlay is all a superseded tab needs, and cacheDom() is its only
  // prerequisite: showFatalStorageError reads the refs cached here and wires its
  // Reload button inline, never through bindEvents().
  cacheDom();

  // Single-tab CHECKPOINT, as early as that prerequisite allows. Nothing above
  // it touches storage or binds a handler, so a tab that did not get the lock
  // paints the overlay having read no videos, written nothing, and bound no
  // shortcuts — rather than doing all of it and relying on the writes to throw.
  // standDownForOtherTab() stays as depth: nothing after this return reaches the
  // store, but if anything ever did, it must throw rather than persist.
  if (!(await tabLockGranted)) {
    standDownForOtherTab();
    showSupersededError();
    return;
  }

  bindEvents();

  state.clientId = getClientId();
  state.floor = getStartCutoff(); // deletion/fetch boundary
  state.cutoff = getCutoff(); // live marker (may be absent on older installs)

  // Show the current origin in the setup instructions so the user can copy the
  // exact "Authorized JavaScript origins" value.
  if (dom.originHint) dom.originHint.textContent = window.location.origin;

  // Load persisted videos up front. getAllVideos() is the first store call, and
  // EVERY rejection from it is FATAL: an empty store is not an error (getAll()
  // resolves [] on a first run), so a rejection always means the video store is
  // unusable. Falling through with an empty state.records would show a wiped
  // queue and then write over rows that may still be sitting in the DB. So each
  // case HALTS startup with a blocking full-screen error:
  //   - DbBlockedError     — another tab holds the DB at a different version.
  //   - DbUnavailableError — IndexedDB could not be opened at all.
  //   - anything else      — the DB opened but the read failed (a plain
  //     DOMException from db.transaction() or the getAll() request: corrupt
  //     backing store, failing disk).
  try {
    state.records = await getAllVideos();
  } catch (err) {
    if (err instanceof DbBlockedError) showBlockedError();
    else if (err instanceof DbUnavailableError) showDbUnavailableError();
    else showDbReadError(err);
    return;
  }

  // Load the persisted channel avatar/title map BEFORE the first render so
  // avatars appear immediately for already-stored videos (zero API cost).
  state.channels = loadChannels();

  // Restore the persisted playback speed (validated; fall back to default 1x for
  // anything not 1/1.5/2). player.js applies it on each video load; the button
  // highlight is set by updateSpeedButtons when the app view shows.
  const storedSpeed = getPlaybackSpeed();
  state.speed = [1, 1.5, 2].includes(storedSpeed) ? storedSpeed : DEFAULT_PLAYBACK_SPEED;
  playerSetSpeed(state.speed);

  // Restore the persisted DEFAULT-speed setting (validated; unset unless 1/1.5/2)
  // and reflect the toolbar button label.
  const storedDefault = getDefaultSpeed();
  state.defaultSpeed = [1, 1.5, 2].includes(storedDefault) ? storedDefault : null;
  updateDefaultSpeedButton();

  // One-shot on-load storage migrations (what they do lives in migrations.js).
  // Runs before anything reads prefs (runRefresh is the only reader).
  migrateLocalStorage();

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
    } catch (err) {
      // cleanup()'s only await is deleteVideos(), so a throw here is a fatal DB
      // condition (blocked/unavailable) — it must surface, not be swallowed.
      // Anything else falls through and renders whatever we have. Note cleanup()
      // drops the pruned records from state.records BEFORE awaiting the delete,
      // so on failure memory and IndexedDB diverge until the next reload re-reads
      // and re-prunes.
      reportIfFatalDb(err);
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
  dom.scrollSkippedBtn = byId('scroll-skipped-btn');
  dom.scrollPlayingBtn = byId('scroll-playing-btn');
  dom.defaultSpeedBtn = byId('default-speed-btn');
  dom.changeCutoffBtn = byId('change-cutoff-btn');
  dom.changeClientBtn = byId('change-client-btn');

  dom.queuedCount = byId('queued-count');
  dom.handledCount = byId('handled-count');
  dom.cutoffDisplay = byId('cutoff-display');

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

  dom.saveCutoffBtn.addEventListener('click', onSaveCutoff);

  dom.signinBtn.addEventListener('click', onSignIn);
  dom.signoutBtn.addEventListener('click', onSignOut);
  dom.refreshBtn.addEventListener('click', onRefresh);
  if (dom.refreshNewBtn) dom.refreshNewBtn.addEventListener('click', onRefreshNew);
  dom.cleanupBtn.addEventListener('click', onCleanup);
  if (dom.hideMarkedBtn) dom.hideMarkedBtn.addEventListener('click', onToggleHideMarked);
  if (dom.scrollSkippedBtn)
    dom.scrollSkippedBtn.addEventListener('click', onScrollToLastSkipped);
  if (dom.scrollPlayingBtn) dom.scrollPlayingBtn.addEventListener('click', onScrollToPlaying);
  if (dom.defaultSpeedBtn) dom.defaultSpeedBtn.addEventListener('click', onCycleDefaultSpeed);
  dom.changeCutoffBtn.addEventListener('click', openCutoffPanel);
  dom.changeClientBtn.addEventListener('click', openSetupPanel);
  if (dom.speed1x) dom.speed1x.addEventListener('click', () => onSpeed(1));
  if (dom.speed15x) dom.speed15x.addEventListener('click', () => onSpeed(1.5));
  if (dom.speed2x) dom.speed2x.addEventListener('click', () => onSpeed(2));
  if (dom.startQueueBtn) dom.startQueueBtn.addEventListener('click', onStartQueue);
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
// Single-tab guard
//
// Two queue tabs writing the same video store would clobber each other (both
// hold the whole record set in memory and write it back). So only one tab of
// index.html may run: the NEWLY-OPENED tab yields, an already-active tab is
// never interrupted. channels.html deliberately stays outside this — it never
// writes video records, so it may be open alongside the queue.
//
// One named Web Lock (TAB_LOCK) is the whole mechanism, and it is race-free by
// construction: the browser grants it to exactly one document, so there is no
// handshake to get wrong and no window in which two tabs opened at the same
// instant can both proceed. A backgrounded or frozen tab keeps holding it — a
// lock is not a message it could fail to answer.
//
// init() fires the request at the very top and awaits the answer right after
// cacheDom(), before it reads the store, restores any setting or binds a single
// handler. Not granted means another queue tab is live: this one puts up the
// same full-screen halt as the other fatal storage conditions and returns,
// having touched nothing. The store also stands down (every video API then
// throws DbBlockedError) — belt to the checkpoint's braces.
//
// The grant is held for the document's LIFETIME by returning a promise that
// never settles; the browser releases it when the document goes away (closed,
// navigated away, discarded) — nothing to unwind by hand. That also means
// request()'s own promise never settles, which is why the granted/not-granted
// answer travels out through a SEPARATE promise resolved inside the callback.
//
// FAILS OPEN, NEVER CLOSED: no `navigator.locks`, or a request that throws or
// rejects, counts as granted and the app boots exactly as it did before this
// guard existed. Locking the owner out of their own queue would be far worse
// than the two-tab clobber this prevents.
//
// The decision is made once, at startup: there is no path that supersedes a
// running tab later, so no mid-session halt and nothing to do about the player.
// ---------------------------------------------------------------------------

// Promise<boolean>: true = this tab owns the queue (or the guard did not engage).
let tabLockGranted = null;

function requestTabLock() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') {
    tabLockGranted = Promise.resolve(true); // fail open: guard does not engage
    return;
  }
  let answer;
  tabLockGranted = new Promise((resolve) => {
    answer = resolve;
  });
  try {
    navigator.locks
      .request(TAB_LOCK, { ifAvailable: true }, (lock) => {
        answer(Boolean(lock));
        // Not granted: return at once, leaving the holding tab undisturbed.
        // Granted: never settle, so this document holds the lock until it dies.
        return lock ? new Promise(() => {}) : undefined;
      })
      .catch(() => answer(true)); // fail open
  } catch {
    answer(true); // fail open
  }
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
  // SINGLE source of truth for every auth-gated indicator: the status label, the
  // sign in/out buttons, the refresh buttons AND the Like button all derive from
  // hasSession() (an active authorized session), NOT from live-token validity.
  // A token silently expires ~1h in but the session stays alive (the next API
  // call refreshes it on demand), so the label and the Like button can never
  // drift apart as the token ages — they both flip only at a real auth
  // transition (sign-in / sign-out / unrecoverable auth failure), each of which
  // routes through here.
  const signed = hasSession();
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
  return runRefresh(state.floor, true);
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
  return runRefresh(bound, false);
}

/**
 * Shared refresh pipeline. `bound` is the per-channel lower bound passed to the
 * uploads fetch, and `sweepSpeeds` says how far a channel's preferred speed
 * reaches — the ONLY two things that differ between "Refresh all" (floor, sweep)
 * and "Refresh new" (incremental, newly-inserted records only). The mode is
 * passed explicitly, never inferred from the bound. Everything else —
 * subscriptions + avatars, the per-channel uploads paging, details backfill,
 * upsert, cleanup, render, the progress toast and the summary — is identical.
 * @param {string|null} bound ISO lower bound for the per-channel uploads fetch
 * @param {boolean} sweepSpeeds fill channel speeds across ALL stored records
 */
async function runRefresh(bound, sweepSpeeds) {
  if (state.refreshing) return;
  if (!hasSession()) {
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

    // Per-channel prefs (channels.html) are read FRESH each refresh — never
    // cached at startup — so edits made in a Channels tab apply to this fetch.
    const prefs = loadChannelPrefs();

    // Per-channel uploads are paged only until they reach `bound` (floor for a
    // full refresh, newest-minus-buffer for an incremental one).
    const collected = [];
    let skipped = 0;
    let fetched = 0;
    // Ignored count precomputed so the progress counter runs contiguously over
    // the channels actually fetched (never jumping across ignored ones).
    const ignored = subs.filter((s) => isChannelIgnored(prefs, s.channelId)).length;
    const fetchTotal = subs.length - ignored;

    for (const sub of subs) {
      // Ignored channels are skipped entirely — no uploads request at all (also
      // saves quota). Their already-stored records are untouched.
      if (isChannelIgnored(prefs, sub.channelId)) continue;
      fetched++;
      // Updates the SINGLE progress toast in place (no new toast per tick).
      showProgress(`Fetching channel ${fetched} of ${fetchTotal}: ${sub.channelTitle}`);
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
          await mergeAndPersist(collected, prefs, sweepSpeeds);
          throw err;
        }
        // auth/network/http: abort the run and report.
        throw err;
      }
    }

    await mergeAndPersist(collected, prefs, sweepSpeeds);

    // SYNC is a CLEANUP site: after upserting, recompute the marker, delete the
    // handled prefix, and advance the floor.
    await cleanup();

    // Silent housekeeping, run on the FINAL record set of this refresh (after
    // the merge AND the cleanup above), so a channel whose last video was just
    // deleted drops in the same pass. Only reachable past the non-empty-subs
    // early return, so `subs` always describes a real subscriptions fetch.
    pruneStaleChannels(subs);

    // Duration + embeddability are not in playlistItems: batch
    // videos.list?part=contentDetails,status (<=50 ids/call, 1 unit each; adding
    // `status` is 0 extra quota) for the surviving visible videos lacking either
    // (covers newly fetched + backfill of older ones). Then the final render.
    showProgress('Fetching video details…');
    await backfillDetails();
    recompute();

    const parts = [`Refreshed. ${collected.length} item(s) fetched.`];
    if (skipped > 0) parts.push(`${skipped} channel(s) skipped (deleted/unavailable).`);
    if (ignored > 0) parts.push(`${ignored} channel(s) ignored.`);
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
 * Merge freshly fetched records into the store and persist. The merge itself is
 * the pure `mergeRefresh` (upsert by videoId preserving state, then fill in each
 * channel's preferred speed where a video has none — see its doc for the reach
 * of `sweepSpeeds`); here it is one write of the merged set, then a recompute.
 * @param {Array<object>} incoming
 * @param {Record<string,{ignored?:boolean,speed?:number}>} prefs per-channel prefs
 * @param {boolean} sweepSpeeds fill across ALL stored records, not just new ones
 */
async function mergeAndPersist(incoming, prefs, sweepSpeeds) {
  state.records = mergeRefresh(state.records, incoming, prefs, { sweepSpeeds });
  await putVideos(state.records);
  recompute();
}

/**
 * Forget channels you are no longer subscribed to, so `yqa_channels` and
 * `yqa_channel_prefs` stop growing forever. The condition is the pure
 * `pruneChannels`: gone from `subs` AND no stored record left (a channel with
 * videos still queued keeps its entry — the cards need its avatar/title — and
 * drops on a later refresh once they drain). It sweeps both maps, so an orphan
 * prefs entry with no channels entry goes the same way. Prefs are re-read FRESH
 * here rather than reusing the refresh's snapshot: a Channels tab may have
 * edited them mid-run. Silent — no toast; and each map is written only if it
 * changed, since a prune can touch just one of the two.
 * @param {Array<{channelId:string}>} subs the freshly-fetched subscriptions
 */
function pruneStaleChannels(subs) {
  const channels = state.channels;
  const prefs = loadChannelPrefs();
  const pruned = pruneChannels(channels, prefs, subs, state.records);
  if (pruned.removed.length === 0) return;
  if (pruned.channels !== channels) {
    state.channels = pruned.channels;
    saveChannels(state.channels);
  }
  if (pruned.prefs !== prefs) saveChannelPrefs(pruned.prefs);
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
 * failures are swallowed — a refresh is never failed over them. The one
 * exception is a fatal DB condition, which is reported (see reportIfFatalDb).
 */
async function backfillDetails() {
  const missing = computeVisible(state.records, state.floor)
    .filter(
      (r) =>
        typeof r.durationSeconds !== 'number' ||
        typeof r.embeddable !== 'boolean' ||
        typeof r.description !== 'string'
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
      if (typeof d.description === 'string') r.description = d.description;
    }
    await putVideos(state.records);
  } catch (err) {
    // Enhancements only; never fail a refresh over them — but a fatal DB state
    // (blocked by another tab) still has to surface instead of vanishing here.
    reportIfFatalDb(err);
  }
}

// ---------------------------------------------------------------------------
// Marking actions + cutoff advancement + pruning
// ---------------------------------------------------------------------------

/**
 * Set a video's state to `nextState` as given — this NEVER toggles. Updates the
 * record + card optimistically, then persists, reverting everything on failure.
 * @param {string} videoId
 * @param {string} nextState
 * @param {{advanceFocus?: boolean}} [opts]
 */
async function setVideoState(videoId, nextState, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;

  const prevState = rec.state;
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
  // This optimistic path skips render(), so re-evaluate the playback controls
  // directly: skipping the playing video with Hide-skipped ON removes its card
  // above, leaving nothing to scroll to, and marking/un-marking changes whether
  // the empty player still has anything to start.
  updatePlayingControls();
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
 * Skip button / x key. Toggle semantics: marking a card that is ALREADY handled
 * (any non-'new' state) reverts it to 'new' in one press, so a mis-skip can be
 * corrected straight from the still-usable button (or with the x key). Auto-mark
 * when a video ENDS calls setVideoState directly instead, so a just-finished
 * video is never toggled back to 'new'.
 * @param {string} videoId
 * @param {{advanceFocus?: boolean}} [opts]
 */
function toggleSkip(videoId, opts = {}) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const next = rec.state !== STATE_NEW ? STATE_NEW : STATE_SKIPPED;
  return setVideoState(videoId, next, opts);
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
  // Like the marking path, this optimistic update skips render(), so re-evaluate
  // the playback controls directly: un-marking can make the queue playable again
  // (the empty player's "Start the queue" button).
  updatePlayingControls();
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
    onReady: () => updateSpeedButtons(),
    onProgress: onPlayerProgress,
  });
  updateSpeedButtons();
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
  // Apply the EFFECTIVE speed before loading — via onSpeed, so the player +
  // speed-button highlight + the persisted global speed all update and carry
  // forward. Priority: this video's preferredSpeed, else the user's default-speed
  // setting, else the current speed (retain the previous video's speed).
  onSpeed(effectiveSpeed(rec.preferredSpeed, state.defaultSpeed, state.speed));
  // Resume from the saved position when it's a meaningful mid-point, else start 0.
  const start = resumeStart(rec.positionSeconds, rec.durationSeconds);
  playerLoad(videoId, start);
  setPlayerNowPlaying(rec);
  markPlayingCard(videoId);
  updatePlayingControls(); // now playing -> enable the "scroll to playing" jump
  updateLikeButton(); // from the record's local `liked` flag (no fetch)
}

/**
 * "Start the queue" button in the empty player: play the FIRST still-'new',
 * embeddable video of the render list (oldest first) through the SAME playVideo()
 * path a card's Play button uses. The button is hidden whenever firstPlayable()
 * finds nothing, so the null branch is only a guard against a stale click (the
 * list can change between paint and click) — it just re-syncs the button.
 */
function onStartQueue() {
  const first = firstPlayable(state.visible);
  if (!first) {
    updatePlayingControls(); // nothing to play after all: hide the stale button
    return;
  }
  playVideo(first.videoId);
}

function openOnYouTube(videoId) {
  const url = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  window.open(url, '_blank', 'noopener');
}

/**
 * Fired when the current video ENDS: auto-mark it 'skipped' via the EXISTING
 * setVideoState path (set, never toggle), so the cutoff marker + greying +
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
  setVideoState(endedId, STATE_SKIPPED); // persists rec (incl. position)
  const next = nextPlayable(state.visible, endedId);
  if (next) playVideo(next.videoId);
  else showPlayerEmpty(true);
}

function setPlayerNowPlaying(rec) {
  if (dom.playerTitle) dom.playerTitle.textContent = rec ? rec.title : ''; // safe text
  // Channel avatar + name + posted date, like the queue cards (updated on every
  // load, incl. auto-advance).
  renderPlayerMeta(dom.playerMeta, rec, state.channels);
  // Description below the player: clickable in-video timestamps seek the built-in
  // player; plain URLs open in a new tab. Hidden when the record has no description.
  renderDescription(dom.playerDescription, rec, { onSeek: seekTo });
  // A new video loaded: scroll the pane back to the top so the video shows,
  // rather than keeping the previous video's (possibly scrolled) position.
  if (dom.playerPane) dom.playerPane.scrollTop = 0;
  setVisible(dom.playerEmpty, false);
  state.playerCaughtUp = false; // playing again: the next stop re-decides the text
  if (dom.skipBtn) dom.skipBtn.disabled = false;
}

/**
 * Show the player's empty state. `caughtUp` only records HOW playback stopped
 * (the queue ran out, vs nothing has played yet); the overlay's text and button
 * are both derived in updatePlayingControls() below, which this calls — so an
 * empty player that later gains a playable video updates itself.
 */
function showPlayerEmpty(caughtUp) {
  state.playing = null;
  state.playerCaughtUp = !!caughtUp;
  if (dom.playerTitle) dom.playerTitle.textContent = '';
  renderPlayerMeta(dom.playerMeta, null);
  renderDescription(dom.playerDescription, null, { onSeek: seekTo });
  setVisible(dom.playerEmpty, true);
  if (dom.skipBtn) dom.skipBtn.disabled = true;
  updatePlayingControls(); // stopped -> disable the jump, show/hide "Start the queue"
  updateLikeButton(); // state.playing is null -> disabled, not liked
  markPlayingCard(null);
}

/**
 * Reflect playback + list state onto the two controls that depend on BOTH, at the
 * same moments — hence one function, called from the spots that flip state.playing
 * (play start / stop / empty), from the optimistic marking path, AND from render()
 * (the visible set changes independently of state.playing):
 *
 *  - "Scroll to playing" jump: enabled only when a video is playing AND that card
 *    is actually present in the rendered queue (findCard). If the playing card is
 *    outside the render window or filtered out (e.g. by Hide-skipped), there is
 *    nothing to scroll to, so the button is disabled.
 *  - The empty-player overlay, text AND its "Start the queue" button, derived from
 *    ONE condition: nothing is playing and firstPlayable() finds something (over
 *    the FULL visible list — the Hide-skipped filter and the render window don't
 *    limit what can be PLAYED). So a queue that was drained to "all caught up" and
 *    then refilled by a refresh flips back to a working button on that refresh's
 *    render(), with no stale "nothing left to play" left over. The button is
 *    HIDDEN rather than disabled, so it never sits in the tab order dead.
 *    state.playerCaughtUp only picks the text for the nothing-playable case; it
 *    can never suppress the button.
 */
function updatePlayingControls() {
  if (dom.scrollPlayingBtn) {
    dom.scrollPlayingBtn.disabled = !state.playing || !findCard(state.playing);
  }
  // The whole now-playing bar (title + meta + Like / speeds / Skip) belongs to a
  // loaded video: with none, the title and meta are empty and every control is a
  // disabled stub, so hide the bar outright rather than show an empty box. This is
  // a VISIBILITY layer only — updateLikeButton / the skip + speed buttons keep
  // their own disabled/active logic untouched underneath. The frame's height comes
  // from its own aspect-ratio (not from siblings) and the pane is top-aligned, so
  // the bar appearing/disappearing below it never moves or resizes the video.
  setVisible(dom.playerBar, !!state.playing);
  const canStart = !state.playing && !!firstPlayable(state.visible);
  setVisible(dom.startQueueBtn, canStart);
  // Exactly ONE of {button, text} — "Select a video to play" next to a button that
  // does exactly that contradicts it. The text is HIDDEN (not blanked) so it takes
  // no layout space and leaves the a11y tree with it.
  setVisible(dom.playerEmptyText, !canStart);
  if (dom.playerEmptyText) {
    dom.playerEmptyText.textContent = state.playerCaughtUp
      ? 'All caught up — nothing left to play.'
      : 'Select a video to play';
  }
}

/**
 * Scroll the queue so the currently-playing video's card is centered. The button
 * is disabled whenever the card isn't in the list, so this normally always finds
 * it; the guards are just defensive (no-op rather than throw).
 */
function onScrollToPlaying() {
  if (!state.playing) return;
  const card = findCard(state.playing);
  if (!card) return; // not in the rendered list: button is disabled anyway
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/**
 * Reflect the rendered list onto the "Jump to last skipped" button: it only needs
 * SOMETHING to scroll to (it falls back to the first card when nothing rendered is
 * skipped), so it is enabled iff at least one card is rendered. Called from
 * render(), the only place the rendered set changes.
 */
function updateSkippedControls(hasCards) {
  if (!dom.scrollSkippedBtn) return;
  dom.scrollSkippedBtn.disabled = !hasCards;
}

/**
 * Scroll the queue so the LAST skipped video's card is centered — reusing the
 * same centering scroll as "scroll to playing". The target comes from the pure
 * lastSkipped() over the RENDERED records (Hide-skipped filter + display window
 * already applied), so the card always exists. With Hide-skipped on, nothing
 * rendered is skipped: fall back to the first rendered card.
 */
function onScrollToLastSkipped() {
  const list = windowedRecords(viewRecords());
  const target = lastSkipped(list) || list[0];
  if (!target) return; // empty list: button is disabled anyway
  const card = findCard(target.videoId);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  setPlaybackSpeed(speed); // persist across reloads
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
 * persists `preferredSpeed` on the record and updates just that card's speed
 * buttons in place. Clicking the active speed toggles it OFF. If the card IS the
 * currently-playing video, SETTING a speed applies it live (unsetting does not).
 * @param {string} videoId
 * @param {number} speed 1 | 1.5 | 2
 */
function onCardSpeed(videoId, speed) {
  const rec = state.records.find((r) => r.videoId === videoId);
  if (!rec) return;
  const wasActive = rec.preferredSpeed === speed;
  rec.preferredSpeed = wasActive ? undefined : speed; // click active -> toggle off
  putVideo(rec).catch(reportIfFatalDb); // persist (whole-record write)
  const card = findCard(videoId);
  if (card) setCardSpeed(card, rec.preferredSpeed);
  // Live-apply only when SETTING a speed for the currently-playing video.
  if (!wasActive && state.playing === videoId) onSpeed(speed);
}

/**
 * Skip button: mark the CURRENT video skipped and advance — reusing the EXACT
 * same path as auto-advance-on-end (setVideoState + nextPlayable).
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
  putVideo(rec).catch(reportIfFatalDb); // best-effort throttled persist
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
 * signed out; the button is ENABLED only when there is an active session
 * (hasSession) AND a video is playing. Gating on hasSession() — the SAME flag the
 * status label uses — rather than live-token validity is what keeps the two in
 * agreement: an expired token still counts as "signed in", and a like click
 * refreshes it on demand via rateVideo (getToken -> ensureToken), falling back
 * to a fresh interactive consent on a 401/403 (see onLike).
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
  // Enabled only with an ACTIVE SESSION and a video playing (visual state is
  // separate). hasSession() matches the status label, so the two never disagree.
  dom.likeBtn.disabled = !state.playing || !hasSession();
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
    putVideo(rec).catch(reportIfFatalDb); // persist the local liked flag on success
  } catch (err) {
    if (err instanceof ApiError && (err.kind === 'auth' || err.kind === 'forbidden')) {
      // Write scope not granted yet: re-consent for the new scope, then retry once.
      try {
        showToast('Requesting YouTube access to like videos…', { type: 'info' });
        await waitForGis();
        initAuth(state.clientId);
        await requestToken({ interactive: true });
        await rateVideo(videoId, nextRating);
        putVideo(rec).catch(reportIfFatalDb); // persist on success
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

/**
 * PURE view filter: "hide handled" shows only still-'new' videos. Applied to
 * state.visible BEFORE the window/Show-all slice; floor/cutoff/cleanup/data and
 * auto-advance (nextPlayable) are untouched (state.visible itself is unchanged).
 * @returns {Array<object>} the filtered view list, ascending
 */
function viewRecords() {
  return state.hideMarked
    ? state.visible.filter((r) => r.state === STATE_NEW)
    : state.visible;
}

/**
 * PURE display windowing: the first QUEUE_DISPLAY_LIMIT records of the (filtered)
 * view, or all of them under "Show all". The result is exactly the set rendered as
 * cards, so DOM lookups against it always resolve.
 * @param {Array<object>} viewList output of viewRecords()
 * @returns {Array<object>}
 */
function windowedRecords(viewList) {
  return state.showAll ? viewList : viewList.slice(0, QUEUE_DISPLAY_LIMIT);
}

function render() {
  updateStats();

  const viewList = viewRecords();
  const total = viewList.length;
  const hasItems = total > 0;
  setVisible(dom.queueList, hasItems);
  setVisible(dom.emptyState, !hasItems && hasSession());

  // Render only the windowed cards; the "Show all (N)" count reflects the filtered
  // total. state.visible and auto-advance are untouched — only rendered CARDS are
  // limited. All re-render paths (cleanup, refresh, toggle) run through here.
  const windowed = windowedRecords(viewList);
  const more =
    !state.showAll && total > QUEUE_DISPLAY_LIMIT ? { total, onShowAll } : null;

  // Button clicks are mouse-driven, so they don't advance focus; the keyboard x
  // (in onGlobalKeydown) passes advanceFocus for rapid down-the-list skipping.
  renderQueue(
    dom.queueList,
    windowed,
    {
      onSkip: (id) => toggleSkip(id),
      onPlay: (id) => playVideo(id),
      onCardSpeed: (id, speed) => onCardSpeed(id, speed),
    },
    state.channels,
    more
  );

  // Re-apply the now-playing highlight after the list is rebuilt.
  if (state.playing) markPlayingCard(state.playing);

  // The "scroll to playing" button is only usable when the playing card is
  // actually in the rendered list, and that can change here (window limit,
  // Hide-skipped filter, prune), so re-evaluate its disabled state every render.
  updatePlayingControls();
  updateSkippedControls(windowed.length > 0);
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
  dom.hideMarkedBtn.textContent = state.hideMarked ? 'Show skipped' : 'Hide skipped';
  dom.hideMarkedBtn.setAttribute('aria-pressed', String(state.hideMarked));
}

/**
 * Cycle the DEFAULT-speed setting on click: unset -> 1× -> 1.5× -> 2× -> unset.
 * Persists the choice and updates the toolbar label. Does not touch the current
 * playback speed — it only changes the fallback applied to future plays of videos
 * that have no per-video preferred speed (via effectiveSpeed).
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
// Keyboard shortcuts. QUEUE: j/k move, x skip, u undo, Enter play focused card,
// 1/5/2 preferred speed. PLAYER: Space play/pause, ←/→ seek, -/+ speed, n
// next, l like, m mute, f fullscreen. Ignored while typing in an input/textarea,
// during onboarding, and for Ctrl/Cmd/Alt combos (Shift stays allowed for '+').
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

// ---------------------------------------------------------------------------
// Privacy curtain: a full-viewport overlay that hides the whole page. Covers the
// page on a wheel-DOWN anywhere outside the queue's own scroll area (or Esc),
// lifted by a wheel-UP (or Esc). Visual only — the player is NOT paused.
// ---------------------------------------------------------------------------

/** Reflect state.curtain onto the overlay element (class + aria). */
function setCurtain(covering) {
  state.curtain = covering;
  if (!dom.curtain) return;
  dom.curtain.classList.toggle('is-covering', covering);
  dom.curtain.setAttribute('aria-hidden', String(!covering));
}

/** Wheel handler: scroll INSIDE the queue scrolls it; elsewhere it drives the
 *  curtain — down covers, up lifts (binary by direction). While the curtain is
 *  covering it is on top, so a wheel event's target is the curtain (not the queue),
 *  and a scroll-up over it lifts it. In the stacked (<=900px) layout the page
 *  scrolls as one column, so scroll-down does NOT cover the page (Esc still
 *  does) — but a scroll-up may still lift an already-covered curtain. */
function onGlobalWheel(e) {
  // Stacked layout: the whole page scrolls, so scroll-down must not cover the
  // page (it would fight normal scrolling). But scroll-up may still LIFT an
  // already-covered curtain on any width. Reuse the player-above-queue breakpoint.
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const t = e.target;
  // Let EITHER workspace pane (queue or player) scroll normally — wheeling over
  // the queue list or the player's description never triggers the curtain. Only
  // the header/toolbar/stats region ABOVE .workspace covers the page.
  if (t && typeof t.closest === 'function' && t.closest('.workspace')) return;
  if (e.deltaY > 0) {
    if (!narrow && !state.curtain) setCurtain(true); // scroll down -> cover (wide only)
  } else if (e.deltaY < 0) {
    if (state.curtain) setCurtain(false); // scroll up -> lift (any width)
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
      toggleSkip(rows[idx].dataset.videoId, { advanceFocus: true });
    }
  } else if (CARD_SPEED_KEYS.has(key)) {
    // Set the FOCUSED card's preferred speed (1 = 1×, 5 = 1.5×, 2 = 2× — see
    // CARD_SPEED_KEYS). Reuses the card speed-button behavior: toggles off if
    // already set, no playback, applies live only if the focused card is the one
    // currently playing. No-op on a non-embeddable card: it has no in-app
    // playback (its speed group renders inert), so there is nothing to set —
    // consistent with its footer.
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
      e.preventDefault(); // otherwise the arrow scrolls the queue
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

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

// One fatal storage screen per page load — see FIRST CAUSE WINS below.
let fatalStorageErrorShown = false;

/**
 * Full-screen BLOCKING error for a FATAL storage condition: the video store is
 * unusable, so the app halts rather than run on a queue it cannot read or save.
 * Shared by the four callers below; only the copy differs. All are resolved by
 * fixing the environment and reloading, hence the single Reload action. Built
 * with el()/text nodes (no innerHTML for the dynamic reload wiring), matching
 * the panel look.
 *
 * FIRST CAUSE WINS: later calls are ignored, because one fatal condition
 * routinely produces another — a mid-session stand-down (onversionchange) makes
 * every write still in flight reject, one screen per rejection, and an aborted
 * blocked upgrade sets both sticky flags, so a second, vaguer diagnosis would
 * paint over the first. Every screen ends in Reload, so the earliest, truest one
 * is the one to keep.
 * @param {{heading:string, paragraphs:Array<string>, toast:string}} copy
 */
function showFatalStorageError({ heading, paragraphs, toast }) {
  if (fatalStorageErrorShown) return;
  fatalStorageErrorShown = true;
  const overlay = document.getElementById('blocked-overlay');
  if (!overlay) {
    // Defensive: without the container, at least surface it as a toast.
    showToast(toast, { type: 'error' });
    return;
  }
  // Hide the onboarding/app scaffolding behind the overlay.
  setVisible(dom.setupPanel, false);
  setVisible(dom.cutoffPanel, false);
  setVisible(dom.appMain, false);

  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
  const panel = el('div', { class: 'panel panel--blocked', role: 'alertdialog', 'aria-labelledby': 'blocked-heading' }, [
    el('h2', { id: 'blocked-heading', text: heading }),
    ...paragraphs.map((p) => el('p', { text: p })),
    el('div', { class: 'panel__actions' }, [
      el('button', {
        class: 'btn btn--primary',
        type: 'button',
        onclick: () => location.reload(),
      }, ['Reload']),
    ]),
  ]);
  overlay.append(panel);
  setVisible(overlay, true);
}

/**
 * IndexedDB is blocked by another tab holding the database open at a different
 * app/DB version (e.g. an old tab left open across a new deploy). The real data
 * is in IndexedDB, just inaccessible, so startup halts until the user closes the
 * other tab(s) and reloads.
 */
function showBlockedError() {
  showFatalStorageError({
    heading: 'Already open in another tab',
    paragraphs: [
      'This app is already open in another browser tab running a different ' +
        'version. Your videos are safe, but this tab can’t access them while the ' +
        'other one is open.',
      'Close the other tab(s) of this app, then reload this page.',
    ],
    toast:
      'This app is open in another tab at a different version. Close the other tab(s) and reload.',
  });
}

/**
 * IndexedDB could not be opened at all, so there is nowhere to read or save the
 * queue. The app stops here instead of presenting an empty queue whose writes
 * would quietly fail.
 */
function showDbUnavailableError() {
  showFatalStorageError({
    heading: 'Storage unavailable',
    paragraphs: [
      'This app needs IndexedDB to store your queue, and this browser couldn’t ' +
        'open it. Without it the app stops here rather than show you an empty ' +
        'queue and quietly lose whatever you do next.',
      'The likely causes are site data (storage) being blocked for this origin ' +
        'in your browser settings, a corrupted database, or a full disk.',
      'Allow site data for this origin, free up disk space, then reload. If it ' +
        'still fails, clearing this site’s storage rebuilds the database from ' +
        'scratch — you lose the stored queue and your saved settings, nothing else.',
    ],
    toast:
      'This app requires IndexedDB and it could not be opened. Allow site data for this origin, then reload.',
  });
}

/**
 * Another tab of the queue holds the tab lock, so this one is superseded. The
 * store has already been stood down, so nothing here can write; this is the
 * visible half of that halt (see the Single-tab guard section).
 */
function showSupersededError() {
  showFatalStorageError({
    heading: 'The queue is already open',
    paragraphs: [
      'This queue is open in another browser tab. Only one tab at a time may ' +
        'write to your stored videos, so this one stopped before it could touch them.',
      'Close the other tab, then reload this page.',
    ],
    toast: 'The queue is already open in another tab. Close it, then reload this page.',
  });
}

/**
 * The database opened, but reading it failed (a plain DOMException from the
 * transaction or the getAll() request). The rows may well still be there, so the
 * app must NOT continue on an empty queue and write over them. The underlying
 * error is shown because it is the only diagnostic the user gets.
 * @param {unknown} err the rejection from getAllVideos()
 */
function showDbReadError(err) {
  const detail = describeError(err);
  showFatalStorageError({
    heading: 'Could not read your queue',
    paragraphs: [
      'The database is there, but reading your stored videos failed. That ' +
        'usually means a corrupted database or a disk that is failing.',
      'The app is stopping here rather than show you an empty queue and write ' +
        'over data that may still be in there.',
      'Reloading is worth a try. If it keeps failing, clearing this site’s ' +
        'storage rebuilds the database from scratch — you lose the stored queue ' +
        'and your saved settings, nothing else.',
      detail ? `Details: ${detail}` : null,
    ].filter(Boolean),
    toast:
      'Could not read the stored queue — the database may be corrupted. Reload, or clear this site’s storage to start over.',
  });
}

/**
 * Best-effort, never-throwing 'Name: message' description of an unknown thrown
 * value, for display via textContent. Anything exotic (a Proxy, a getter that
 * throws, a Symbol) degrades to '' rather than breaking the error screen.
 * @param {unknown} err
 * @returns {string}
 */
function describeError(err) {
  try {
    if (err == null) return '';
    const name = typeof err.name === 'string' ? err.name : '';
    const message = typeof err.message === 'string' ? err.message : '';
    const detail = [name, message].filter(Boolean).join(': ') || String(err);
    return detail.slice(0, 300);
  } catch {
    return '';
  }
}

/**
 * Swallow a best-effort (optional) store write's failure — EXCEPT the fatal DB
 * conditions, which are routed to handleError so the user is actually told.
 * `dbBlocked` can flip AFTER init via db.onversionchange (another tab starting a
 * schema upgrade), and from then on every write no-ops; without this the card
 * speed / watch position / like flag would silently stop persisting.
 * Use as `putVideo(rec).catch(reportIfFatalDb)`.
 * @param {unknown} err
 */
function reportIfFatalDb(err) {
  // DbUnavailableError is practically unreachable post-init (init awaits the
  // memoized openDb() and halts), but it costs nothing to cover it here too.
  if (err instanceof DbBlockedError || err instanceof DbUnavailableError) {
    handleError(err);
  }
  // Anything else is a transient failure on an optional write: keep the call
  // site's intent and stay quiet (a refresh is never failed over one).
}

function handleError(err) {
  if (err instanceof DbBlockedError) {
    // A store write hit the blocked state after init (rare — startup normally
    // halts first). Surface the same blocking screen rather than fail silently.
    showBlockedError();
    return;
  }
  if (err instanceof DbUnavailableError) {
    // Same idea for a store call that finds IndexedDB unusable after init (e.g.
    // the very first store call happens post-init): halt visibly, never silently.
    showDbUnavailableError();
    return;
  }
  if (err instanceof ApiError) {
    if (err.kind === 'auth') {
      // An API call failed auth even after the built-in silent refresh/retry, so
      // the grant is genuinely dead: end the session (clearToken) BEFORE
      // updateAuthUi() so the status label AND the Like button both flip to
      // signed-out together, agreeing with this toast.
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
