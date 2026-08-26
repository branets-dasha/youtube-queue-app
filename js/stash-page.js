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
//
// It is NOT the only writer of the `stash` store — index.html's "Add to stash"
// writes it too, from a tab holding a different lock — so this page listens for
// that tab's writes and reconciles (see "Cross-tab sync" below).

import {
  STATE_NEW,
  STATE_SKIPPED,
  QUEUE_DISPLAY_LIMIT,
  DEFAULT_PLAYBACK_SPEED,
  STASH_TAB_LOCK,
  STASH_SYNC_COALESCE_MS,
} from './config.js';
import { migrateLocalStorage } from './migrations.js';
import {
  getClientId,
  setClientId,
  getAllStashVideos,
  putStashVideo,
  deleteStashVideos,
  onStashChanged,
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
  ensureAuthorized,
  hasSession,
  clearToken,
  revoke,
} from './auth.js';
import { getVideosByIds, getChannelAvatars, rateVideo, ApiError } from './api.js';
import {
  parseVideoId,
  stashChannelInfo,
  sortStash,
  stashToClean,
  addToStash,
  reconcileStash,
  firstPlayable,
  nextPlayable,
  resumeStart,
  effectiveSpeed,
} from './queue.js';
import {
  showStatus,
  hideStatus,
  renderQueue,
  renderPlayerTitle,
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
  describeAuthFailure,
  initCurtain,
  initQueueFocus,
  initPaneNav,
  focusFirst,
  bindIframeFocusGuard,
} from './page-chrome.js';

// ---------------------------------------------------------------------------
// Application state (in-memory)
// ---------------------------------------------------------------------------

const state = {
  clientId: null,
  records: [], // the whole stash, kept sorted by sortStash (oldest addedAt first)
  booted: false, // the store read + settings restore have run once this load
  adding: false, // an add is in flight (guards the form AND the token request)
  liking: false, // a like is in flight (guards the button AND the token request)
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

// Two-pane focus navigation, from page-chrome.js's initQueueFocus(); it owns
// the remembered card, so `state` does not mirror that either. The keys that
// drive it live in onGlobalKeydown below, as page-chrome binds none.
let queueFocus = null;

// Pane-to-pane focus movement ([, ] and /), from page-chrome.js's
// initPaneNav(); it owns the last-pane note, so `state` does not mirror that
// either. Same arrangement: the keys live in onGlobalKeydown below.
let paneNav = null;

// DOM references, populated in init().
const dom = {};

// ---------------------------------------------------------------------------
// In-flight stash writes
//
// Every write this page makes is OPTIMISTIC — the record and its card change in
// memory first, and the putStashVideo is awaited afterwards — so between those
// two moments DISK IS BEHIND MEMORY for that one videoId. That window is exactly
// where a cross-tab signal must NOT adopt what it re-reads (it would un-mark the
// card the user just clicked), and this set is exactly what reconcileStash takes
// as its third argument. Everything NOT in here is free to take the other tab's
// content, which is what lets a remote un-mark land (re-adding a stashed video
// revives it — see addToStash).
//
// Refcounted rather than a plain Set: two writes for one videoId can overlap (a
// mark then an un-mark, a speed toggle during a mark), and the first to settle
// must not clear the guard the second is still standing behind.
// ---------------------------------------------------------------------------

const inFlightWrites = new Map(); // videoId -> how many writes are open for it

/**
 * THE stash write for this page — nothing else in this module calls
 * putStashVideo, so the guard above cannot be forgotten at a new write site (the
 * same argument that keeps the broadcast inside store.js's putOne). Returns the
 * write's own promise, so every call site keeps its await / .catch() exactly as
 * it was, and releases the guard when the write SETTLES: a failed write is
 * followed by a revert to what disk already says, so there is nothing left to
 * protect either way.
 * @param {object} rec the record to persist (a whole-record upsert)
 * @returns {Promise<void>}
 */
function persistRecord(rec) {
  const videoId = rec && rec.videoId;
  if (!videoId) return putStashVideo(rec); // nothing to key the guard on
  inFlightWrites.set(videoId, (inFlightWrites.get(videoId) || 0) + 1);
  return putStashVideo(rec).finally(() => {
    const open = (inFlightWrites.get(videoId) || 0) - 1;
    if (open > 0) inFlightWrites.set(videoId, open);
    else inFlightWrites.delete(videoId);
  });
}

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

  dom.cleanupBtn = byId('cleanup-btn');
  dom.scrollPlayingBtn = byId('scroll-playing-btn');

  // Pane-ring containers. Nothing else references them: they exist so [ and ]
  // can name a REGION rather than a control, each landing on its own first
  // focusable one. The add form is a pane of this page's own — the one region
  // the subscriptions ring has no counterpart for.
  dom.topbarNav = document.querySelector('.topbar__nav');
  dom.toolbar = document.querySelector('.toolbar');
  dom.queueHeader = document.querySelector('.queue-header');

  // The first skip link, by its target rather than an id: it is the only
  // .skip-link pointing at the queue, and "Skip to player" needs no handler.
  dom.skipToQueue = document.querySelector('.skip-link[href="#queue-list"]');

  // The queue PANE, not the list: the pane is the scroll container (selected by
  // class, there's no id), so a re-render nobody asked for can put its scrollTop
  // back — see renderKeepingPlace. It is also the region arrow-key card
  // navigation is confined to in the STACKED layout, which is wider than the
  // list: it takes in the sticky header buttons too.
  dom.queuePane = document.querySelector('.workspace__queue');
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
  // Typing clears the field's invalid marking. The messages themselves are
  // toasts now, and dismiss on their own timer.
  if (dom.urlInput) dom.urlInput.addEventListener('input', clearAddInvalid);

  if (dom.cleanupBtn) dom.cleanupBtn.addEventListener('click', onCleanup);
  if (dom.scrollPlayingBtn) dom.scrollPlayingBtn.addEventListener('click', onScrollToPlaying);

  if (dom.speed1x) dom.speed1x.addEventListener('click', () => onSpeed(1));
  if (dom.speed15x) dom.speed15x.addEventListener('click', () => onSpeed(1.5));
  if (dom.speed2x) dom.speed2x.addEventListener('click', () => onSpeed(2));
  if (dom.startQueueBtn) dom.startQueueBtn.addEventListener('click', onStartQueue);
  if (dom.skipBtn) dom.skipBtn.addEventListener('click', onSkipNext);
  if (dom.likeBtn) dom.likeBtn.addEventListener('click', onLike);

  // Cross-tab sync: index.html's "Add to stash" writes this page's store from
  // another tab. store.js announces every committed stash write; a tab never
  // hears its OWN, so this only ever fires for someone else's.
  onStashChanged(onOtherTabWroteStash);

  document.addEventListener('keydown', onGlobalKeydown);

  // The curtain binds its own wheel handler and keeps its own covering flag; Esc
  // stays here, in onGlobalKeydown, because page-chrome owns no shortcuts. The
  // defaults ('.workspace', <=900px, cover on wheel-down) are right for this
  // page: it IS the 100dvh `app-active` two-pane layout.
  curtain = initCurtain({ node: dom.curtain });

  // Arrow-key card navigation: page-chrome owns the remembered card and the
  // focus moves, this page's keydown table owns the keys. Same call on the
  // subscriptions page, so the two tables cannot drift on it.
  queueFocus = initQueueFocus({
    queueList: dom.queueList,
    queuePane: dom.queuePane,
    playerPane: dom.playerPane,
  });

  // "Skip to queue" lands on the FIRST CARD, not on the <ul>. It is a keyboard
  // gesture, and focus arriving on an invisible container reads as nothing
  // having happened. preventDefault first: the fragment navigation scrolls its
  // target into view on its own, which nudged the queue even when it was already
  // at the top — focusCardAt(0) then lets .row's scroll-margin-top clear the
  // sticky header instead. With an EMPTY queue there is no card to land on, and
  // the <ul> is `hidden` in exactly that state — focusing it is a silent no-op —
  // so the ladder falls to #empty-state, which is what actually occupies the
  // queue region and carries the "caught up" text. focusFirst verifies each
  // candidate really took focus, so the <ul> behind it costs nothing.
  if (dom.skipToQueue) {
    dom.skipToQueue.addEventListener('click', (e) => {
      e.preventDefault();
      if (!(queueFocus && queueFocus.focusCardAt(0))) focusFirst(dom.emptyState, dom.queueList);
    });
  }

  // The pane ring, IN DOM ORDER — the subscriptions ring with the add form
  // inserted after the toolbar. Only two override the default landing: the queue
  // resumes at the remembered card (letting the scroll follow, unlike every
  // other caller of focusRemembered, since arriving from another pane has no
  // scroll to protect), and the player is focused WHOLE so its description
  // scrolls natively. The add form takes the default and so lands on the URL
  // field — a ONE-WAY door, since the typing guard in onGlobalKeydown swallows
  // [ and ] there; Tab or a click is the way back out, and that is accepted
  // rather than carving a two-key exception into a blanket guard.
  paneNav = initPaneNav({
    panes: [
      { el: dom.topbarNav },
      { el: dom.toolbar },
      { el: dom.addForm },
      { el: dom.queueHeader },
      {
        el: dom.queueList,
        role: 'queue',
        focus: () => (queueFocus ? queueFocus.focusRemembered({ preventScroll: false }) : null),
      },
      { el: dom.playerPane, role: 'player', focus: () => focusFirst(dom.playerPane) },
    ],
  });

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
  // SINGLE source of truth for the auth INDICATORS: the status label and the
  // sign in/out buttons derive from hasSession() (an active authorized session),
  // NOT from live-token validity — a token silently expires ~1h in while the
  // session stays alive (the next API call refreshes it on demand). NEITHER the
  // Add button NOR Like is gated on auth: both authorize on demand, so a
  // signed-out visitor can click either and sign in as part of the same gesture.
  const signed = hasSession();
  dom.authStatus.textContent = signed ? 'Signed in' : 'Not signed in';
  dom.authStatus.classList.toggle('is-signed-in', signed);
  // The pair SWAPS: one hides as the other appears, so whichever is going away
  // would drop focus to <body>. Note it before the swap and place it after —
  // focus() on a still-hidden element is a no-op. Self-limiting: on every other
  // call the outgoing button is already hidden and cannot be holding focus.
  const outgoing = signed ? dom.signinBtn : dom.signoutBtn;
  const incoming = signed ? dom.signoutBtn : dom.signinBtn;
  const takesFocus = document.activeElement === outgoing;
  setVisible(dom.signinBtn, !signed);
  setVisible(dom.signoutBtn, signed);
  if (takesFocus) focusFirst(incoming);
  updateLikeButton(); // re-evaluate: the label changed, though auth no longer gates it
}

async function onSignIn() {
  try {
    // forceNew: there is no session to reuse — go straight to GIS.
    await ensureAuthorized(state.clientId, { forceNew: true });
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
// EVERY message here is a TOAST — errors, the duplicate notice, progress and
// success alike. The inline status line this replaced appeared and disappeared
// per message, reflowing the page on every add; toasts float above the layout
// and cost no vertical space. Moving only some cases would have kept the jump
// for the rest, so none of them stayed. What did stay on the field is
// aria-invalid for a parse failure: that is validity STATE, not a message, and
// the next keystroke clears it (clearAddInvalid).
// ---------------------------------------------------------------------------

/** Clear the field's invalid marking (on input); the messages self-dismiss. */
function clearAddInvalid() {
  if (dom.urlInput) dom.urlInput.removeAttribute('aria-invalid');
}

/**
 * Empty the URL field — for every outcome that ENDS WITH THE VIDEO IN THE STASH,
 * whether this add put it there or found it already there. A second press could
 * then only repeat a no-op, and the caret is back in the field (onAddSubmit) with
 * nothing to delete before the next paste. The outcomes that do NOT reach here
 * keep the text on purpose: the user is about to fix or replace it.
 */
function clearAddInput() {
  if (dom.urlInput) dom.urlInput.value = '';
}

/** Mark the URL field invalid (parse failures only) and say why, in a toast. */
function rejectInput(message) {
  if (dom.urlInput) dom.urlInput.setAttribute('aria-invalid', 'true');
  showToast(message, { type: 'error' });
}

// The add flow's single PROGRESS toast ("authorizing…", "looking up…"), updated
// in place rather than stacked, and always dismissed in runAdd's finally —
// the same pattern subscriptions-page.js uses around a refresh.
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
 * Reflect an in-flight add on the form (the button is the only visible part).
 *
 * aria-disabled, never the `disabled` property: the button returns a moment
 * later and the click that started the add came from it, so disabling would drop
 * focus to <body>. onAddSubmit's `if (state.adding) return` is the re-entry
 * guard — aria-disabled does not block a submit, but that guard makes one inert.
 * No busy LABEL either (unlike "Show all"): the progress toast is already a live
 * region, and swapping "Add" for "Adding…" would resize the field beside it
 * (.stash-add__input is `flex: 1 1 320px`) under the user's own caret.
 */
function setAdding(adding) {
  state.adding = adding;
  if (dom.addBtn) dom.addBtn.setAttribute('aria-disabled', String(adding));
}

/**
 * Finish an add that turned out to be a DUPLICATE — the shared tail of both
 * routes into it, the one that never reached the API and the one that did.
 *
 * A duplicate is no longer always a no-op (addToStash revives one that was
 * marked Remove, and takes an explicit incoming speed), so the toast has to tell
 * the two apart: "already in your stash" alone would be a lie by omission the
 * moment a re-add un-marks something. It persists ONLY when something actually
 * changed — that is what `changed` is for, and what the by-identity array on the
 * other branch is for.
 * @param {{records:Array<object>, changed:boolean, record:object}} result from addToStash
 */
async function applyDuplicate({ records, changed, record }) {
  if (!changed) {
    showToast('That video is already in your stash.', { type: 'info' });
    clearAddInput();
    scrollToCard(record.videoId);
    return;
  }
  try {
    await persistRecord(record);
  } catch (err) {
    // Memory still holds the OLD record (the swap below has not run), so there
    // is nothing to revert — just route it, which raises the halt screen for a
    // fatal storage state.
    handleError(err);
    return;
  }
  state.records = sortStash(records); // the updated COPY, at its same place
  render();
  showToast('That video is already in your stash — updated it.', { type: 'success' });
  clearAddInput();
  scrollToCard(record.videoId);
}

/**
 * Submit handler: run the add, then put the caret back in the URL field.
 *
 * EVERY way an add ends wants the field rather than the button. Success clears
 * it, so a second press could only do nothing; every other outcome leaves the
 * pasted text sitting there to be fixed or replaced — a parse failure most of
 * all, which marks the field aria-invalid and would otherwise leave the user's
 * focus somewhere else entirely. One rule, no branch per outcome, which is why
 * it wraps runAdd instead of living in its finally: half the exits return before
 * that try is even entered.
 *
 * Gated on the button HOLDING focus, like every other hand-off on these pages:
 * the Enter-in-the-field route is then a no-op, and an add that lands after the
 * user has moved on does not yank them back.
 */
async function onAddSubmit(e) {
  e.preventDefault();
  // A second submit while one is in flight would hit auth.js's single callback
  // slot ("A token request is already in progress."), so it never starts.
  if (state.adding) return;

  const takesFocus = dom.addBtn ? dom.addBtn.contains(document.activeElement) : false;
  try {
    await runAdd();
  } finally {
    // No focusFirst ladder: the field is never disabled or hidden, which is the
    // same reason onCleanup already uses it as its guaranteed-live tail.
    if (takesFocus && dom.urlInput) dom.urlInput.focus();
  }
}

/** The add itself — parse, look up, stash. Every exit is a plain return. */
async function runAdd() {
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

  // DUPLICATE, and we know it WITHOUT the lookup or the token: the record is
  // already here, keeping its position and its addedAt whatever we do next. What
  // an add can still do to it is what addToStash does to any duplicate — revive
  // it if it was marked Remove — so it goes through that one function instead of
  // a second copy of the rule. The id is all we know about the paste at this
  // point, and all the duplicate branch reads: a pasted link carries no
  // preferredSpeed, so the stashed speed is kept either way.
  if (state.records.some((r) => r.videoId === videoId)) {
    await applyDuplicate(addToStash(state.records, { videoId }));
    return;
  }

  if (!state.clientId) {
    showToast('Add your OAuth Client ID first (Change Client ID).', { type: 'error' });
    return;
  }

  setAdding(true);
  try {
    if (!hasSession()) showProgress('Authorizing with Google…');
    // Silent when a token is already live; falls back to the consent prompt.
    await ensureAuthorized(state.clientId);
    updateAuthUi(); // a fresh token flips the label + the Like button

    showProgress('Looking up the video…');
    const [incoming] = await getVideosByIds([videoId]);
    if (!incoming) {
      // getVideosByIds simply omits ids the API does not return.
      showToast(
        'YouTube has no such video — it may be private, deleted, or the link may be wrong.',
        { type: 'error' }
      );
      return;
    }

    await attachAvatar(incoming);

    // Channel prefs are read FRESH (never cached at startup), so a speed set in
    // a Channels tab applies to this add without reloading. The Ignore flag is
    // deliberately NOT consulted — addToStash reads the leaf
    // channelPreferredSpeed, because Ignore governs what gets FETCHED by
    // subscription and nothing here is fetched by subscription.
    const result = addToStash(state.records, incoming, {
      addedAt: new Date().toISOString(),
      prefs: loadChannelPrefs(),
    });
    if (!result.added) {
      // It arrived while we were looking it up — the other tab stashed it, or a
      // racing add of our own. Finish it as the duplicate it now is.
      await applyDuplicate(result);
      return;
    }
    const { records, record } = result;

    await persistRecord(record);
    state.records = sortStash(records);
    render();
    clearAddInput();
    showToast(`Added “${record.title}” to your stash.`, { type: 'success' });
    scrollToCard(record.videoId);
  } catch (err) {
    showToast(describeAddFailure(err), { type: 'error' });
    if (err instanceof DbBlockedError || err instanceof DbUnavailableError) {
      // A fatal storage condition is bigger than this form: put up the halt
      // screen too (the toast alone would understate it).
      handleError(err);
    } else if (err instanceof ApiError && err.kind === 'auth') {
      // The grant is genuinely dead: end the session so the label and the Like
      // button agree with the message above.
      clearToken();
      updateAuthUi();
    }
  } finally {
    // Always dismiss the progress toast when an add ends (success/error/early).
    hideProgress();
    setAdding(false);
  }
}

/**
 * Give the new record its channel avatar, WITHOUT touching `yqa_channels`: the
 * stash stores the URL on its own record, so it depends on no map that a
 * subscriptions refresh could prune out from under it. The already-known map is
 * tried first, so stashing from a subscribed channel costs no quota. Purely
 * cosmetic — a failure leaves the letter placeholder and never fails the add.
 *
 * `yqa_channels` is read FRESH here, and at this page's other two use sites
 * (render, the now-playing meta) — never cached at startup, the same rule
 * `yqa_channel_prefs` follows. This page only READS that map, while a
 * subscriptions refresh in another tab rewrites it, so a boot-time snapshot
 * would strand a card whose record carries no avatar of its own on the letter
 * placeholder until the next full page reload.
 * @param {object} rec the freshly fetched record (mutated in place)
 */
async function attachAvatar(rec) {
  if (!rec || !rec.channelId) return;
  const known = loadChannels()[rec.channelId];
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
 * The toast message for a failed add — a pure string picker (the caller decides
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
// Marking (Remove) and the Clean up sweep
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
    await persistRecord(rec);
  } catch (err) {
    rec.state = prevState;
    if (card) setCardState(card, prevState);
    updatePlayingControls();
    updateCleanupUi();
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
 * Clean up button: sweep, re-render, report. Two things have to be put back by
 * hand afterwards.
 *
 * The re-render rebuilds the <ul>, so the pane's scroll goes with it and the
 * user is dumped at the top of a list they were reading the middle of.
 * renderKeepingAnchor is the right one of the two restores here because
 * membership SHRINKS — stashToClean takes handled records from anywhere in the
 * list, so the anchor itself can be one of the swept ones and needs a stand-in
 * (renderKeepingPlace's absolute scrollTop is for the reconcile, where
 * membership only grows).
 *
 * And the button disables itself at 0, which would drop focus to <body>: it
 * goes to the card the walk resumes at — the same one the scroll was just
 * anchored on, so the two cannot disagree — else the URL field, which is never
 * disabled or hidden. The twin of subscriptions-page.js's onCleanup.
 */
async function onCleanup() {
  // Read BEFORE the sweep, and only rescue focus this button actually holds:
  // a mouse click in Safari does not focus a <button>, and stealing focus from
  // somewhere else entirely — the URL field — would be worse than doing nothing.
  // Focus that was in the LIST is not this gate's business: the re-render below
  // is what destroyed it and what puts it back.
  const takesFocus = dom.cleanupBtn.contains(document.activeElement);
  try {
    const removed = await sweepRemoved();
    if (queueFocus) queueFocus.renderKeepingAnchor(render);
    else render();
    if (removed > 0) {
      showToast(`Removed ${removed} video(s) from your stash.`, { type: 'success' });
    }
    if (takesFocus && !(queueFocus && queueFocus.focusRemembered())) {
      focusFirst(dom.urlInput);
    }
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
// Cross-tab sync: the OTHER tab wrote the `stash` store
//
// index.html's "Add to stash" writes this store from a tab holding a different
// lock — inserting a record, or UPDATING one already here (re-adding a stashed
// video un-marks it) — so this page can be looking at a list that has already
// moved on.
// store.js posts a bare SIGNAL on every committed stash write and we re-READ the
// store here: the message carries no records because IndexedDB is the single
// source of truth, and a payload would go stale the moment a message was missed.
//
// One-way by design. subscriptions-page.js subscribes to NOTHING — it holds no
// stash state to keep fresh (see the note at its addCardToStash).
// ---------------------------------------------------------------------------

// A signal is already waiting out its coalescing timer. A burst of adds in the
// other tab therefore costs ONE re-read and ONE render, not one of each.
let syncPending = false;

/** Handler for the store's cross-tab signal (never fired by our own writes). */
function onOtherTabWroteStash() {
  // Before bootApp() there is no in-memory list to reconcile — the setup panel
  // is up, or the store read has not run yet — and that load reads the current
  // stash for itself.
  if (!state.booted || syncPending) return;
  syncPending = true;
  setTimeout(() => {
    syncPending = false;
    syncFromStore();
  }, STASH_SYNC_COALESCE_MS);
}

/** Re-read the stash and reconcile it into what this page is holding. */
async function syncFromStore() {
  let fresh;
  try {
    fresh = await getAllStashVideos();
  } catch (err) {
    // Nobody asked for this read, so a transient failure stays quiet (the next
    // signal, or a reload, tries again). A FATAL db state is bigger than this
    // sync and must surface.
    reportIfFatalDb(err);
    return;
  }

  // Content comes from the re-read for everything EXCEPT the videoIds we have a
  // write in flight for — see reconcileStash. Those are the ones disk is behind
  // memory on (marking here is optimistic), and adopting them would un-mark the
  // card under the user; every other record has to be free to change, or an
  // un-mark made in the other tab would never appear here.
  const { records, changed } = reconcileStash(state.records, fresh, inFlightWrites);
  if (!changed) return; // nothing visible moved: leave the list alone entirely

  state.records = records; // render() sorts, as every other writer here does
  renderKeepingPlace();
}

/**
 * render(), with the queue pane's scroll position and the user's place in the
 * list put back afterwards. renderQueue() empties the <ul> and rebuilds it, so
 * an unprompted re-render would otherwise drop focus to <body> and — the list
 * momentarily having no height — let the pane's scrollTop clamp to 0. Every
 * OTHER render() call site follows the user's own gesture and then places focus
 * or scroll deliberately (Clean up focuses the first card, an add scrolls to the
 * new one), which is why plain render() has never needed this; a cross-tab
 * signal is the first re-render nobody asked for.
 *
 * The focused control comes back by INDEX among its card's buttons/links rather
 * than by identity (that node is gone) — exact, because a card that survives a
 * reconcile is rebuilt from the very same record. Focus lands on the card itself
 * when the card, not a control inside it, had it. The PLAYER is untouched: it
 * lives in the other pane and render() only rebuilds this list.
 */
function renderKeepingPlace() {
  // Through page-chrome, which knows WHICH element scrolls at this width: the
  // pane wide, the DOCUMENT stacked, where the pane is `overflow: visible` and
  // its scrollTop is always 0 — read directly, the save returned 0 and the
  // restore did nothing, leaving the refocused card ~6000px below the fold.
  // The 900px breakpoint is a media query over there, never measured here.
  const restoreScroll = queueFocus ? queueFocus.captureQueueScroll() : null;

  const active = document.activeElement;
  const card = active && dom.queueList.contains(active) ? active.closest('.row') : null;
  const focusedId = card ? card.dataset.videoId : null;
  const controlIndex = card ? cardControls(card).indexOf(active) : -1;

  render();

  if (focusedId) {
    const rebuilt = findCard(focusedId);
    if (rebuilt) {
      const control = controlIndex >= 0 ? cardControls(rebuilt)[controlIndex] : null;
      // preventScroll: focusing scrolls the card into view by default, which
      // would fight the scroll restore below.
      (control || rebuilt).focus({ preventScroll: true });
    }
  }
  if (restoreScroll) restoreScroll();
}

/**
 * A card's focusable controls in DOM order — the index focus is restored by.
 * Anything inside a hidden subtree is left out, because it cannot take focus:
 * a card menu's panel is hidden whenever no menu is open, and a re-render closes
 * any that was, so restoring "the third button" onto an item in there would
 * silently drop focus to <body>. Filtering on the way IN and the way OUT keeps
 * the index meaning the same thing both times.
 * The thumbnail link is excluded by the same test: it is an <a href> but
 * carries tabindex="-1" and aria-hidden, so it is not a place the user can
 * be, and restoring onto it would put focus back on a node the accessibility
 * tree cannot see. tabIndex is read as a PROPERTY, which is what actually
 * governs reachability. Anything not in the set yields indexOf -1, and -1
 * already means "focus the card itself" — the same safe landing a focused
 * .row has always produced.
 */
function cardControls(card) {
  return Array.from(card.querySelectorAll('a[href], button')).filter(
    (control) => control.tabIndex >= 0 && !control.closest('[hidden]')
  );
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

/**
 * Centre a card in the list, when it is rendered (outside the window: no-op).
 *
 * `focus` is OPT-IN and belongs to the jump button alone. The other three
 * callers are all add-flow endings, which put the caret back in the URL field on
 * their way out: focusing a card here would fight that hand-off AND drag the
 * walk cursor onto a card the user never travelled to.
 * @returns {Element|null} the card, when one was rendered.
 */
function scrollToCard(videoId, { focus = false } = {}) {
  const card = findCard(videoId);
  if (!card) return null;
  // preventScroll first, then the centering scroll — focus()'s own "nearest"
  // scroll would otherwise land and be corrected a frame later, as a visible
  // double jump. Same two-call idiom as moveCard's page branch.
  if (focus) card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return card;
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
  // This button is HIDDEN the moment playback starts (playVideo ->
  // updatePlayingControls), so hand its focus off first. The card of the video
  // just started, matching a card's own Play button, which leaves focus in the
  // queue and keeps the arrow walk alive; the player pane when that card is not
  // rendered (the record list is not the render window).
  const takesFocus = dom.startQueueBtn.contains(document.activeElement);
  playVideo(first.videoId);
  if (takesFocus) focusFirst(findCard(first.videoId), dom.playerPane);
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

/**
 * This page's channel resolver: the record's OWN channelAvatarUrl first, the
 * yqa_channels map only as the fallback (stashChannelInfo). The map is read
 * FRESH at each of the two render sites and closed over for that one render —
 * never a boot snapshot (see attachAvatar), and never one read per card.
 * @param {Record<string,{title?:string,avatarUrl?:string}>} channels one fresh read
 * @returns {(rec:object) => {title:string,avatarUrl:string}}
 */
function channelResolver(channels) {
  return (rec) => stashChannelInfo(rec, channels);
}

function setPlayerNowPlaying(rec) {
  // Title, as a link to the video on YouTube — the same link a card's title is
  // (see renderPlayerTitle); the frame itself is out of the tab order.
  renderPlayerTitle(dom.playerTitle, rec);
  renderPlayerMeta(dom.playerMeta, rec, channelResolver(loadChannels()));
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
  // EVERYTHING focusable in the now-playing region is about to be destroyed or
  // hidden: Skip and Like (disabled, under a bar that hides), the title link, the
  // channel-badge link and the description's timestamp/URL links. One gate for
  // the lot — the two subtrees, NOT the whole player pane, so focus already on
  // the pane itself is left where the user put it.
  const active = document.activeElement;
  const takesFocus =
    (dom.playerBar && dom.playerBar.contains(active)) ||
    (dom.playerDescription && dom.playerDescription.contains(active));

  state.playing = null;
  state.playerCaughtUp = !!caughtUp;
  renderPlayerTitle(dom.playerTitle, null);
  renderPlayerMeta(dom.playerMeta, null);
  renderDescription(dom.playerDescription, null, { onSeek: seekTo });
  setVisible(dom.playerEmpty, true);
  if (dom.skipBtn) dom.skipBtn.disabled = true;
  updatePlayingControls();
  updateLikeButton();
  markPlayingCard(null);

  // After updatePlayingControls, which is what reveals "Start the stash".
  // Else the pane, always focusable (tabindex="0") and one '/' from the queue.
  // Never <body>.
  if (takesFocus) focusFirst(dom.startQueueBtn, dom.playerPane);
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

/**
 * Centre the currently-playing card and put the walk cursor on it (the button is
 * disabled when there is none). Focusing the card is enough on its own: the
 * queue list's focusin writes the cursor.
 * @returns {boolean} whether a card was actually focused — the `p` key's cue to
 *   preventDefault, so a dead jump leaves the key its native meaning.
 */
function onScrollToPlaying() {
  if (!state.playing) return false;
  return Boolean(scrollToCard(state.playing, { focus: true }));
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
  persistRecord(rec).catch(reportIfFatalDb); // persist (whole-record write)
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
  persistRecord(rec).catch(reportIfFatalDb); // best-effort throttled persist
}

/** Best-effort capture + persist of the current position on page hide/unload. */
function flushProgress() {
  capturePosition(); // -> onPlayerProgress -> persistRecord
}

// --- Like button (player only) ---

/** The record currently loaded in the player, or null. */
function playingRecord() {
  return state.playing ? state.records.find((r) => r.videoId === state.playing) : null;
}

/**
 * Reflect the Like button from the CURRENT record's LOCAL `liked` flag (never
 * fetched back). The visual filled state is informational and shown even signed
 * out, and the button is NOT gated on auth — it needs only a video playing and
 * no like already in flight, because clicking it authorizes on demand.
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
  // STRUCTURAL vs TRANSIENT. Nothing playing means the control is genuinely dead
  // (and the bar is hidden over it), so `disabled` is right and keeps it out of
  // the tab order. A like IN FLIGHT is transient — the button comes back a moment
  // later — so aria-disabled, which leaves focus where the user put it; onLike's
  // `if (state.liking) return` is what actually stops a second click.
  dom.likeBtn.disabled = !state.playing;
  dom.likeBtn.setAttribute('aria-disabled', String(state.liking));
}

/**
 * Toggle the current video's like: rateVideo(id,'like'|'none') writes to
 * YouTube; on success the local `liked` flag is set + PERSISTED (so it survives
 * a reload with no fetch/quota). AUTHORIZES FIRST (like the Add button), so a
 * cancelled popup can never leave a video showing as liked; only then is the
 * flag flipped optimistically, reverting on error. A scope error (401/403)
 * triggers a fresh interactive consent, then retries once.
 */
async function onLike() {
  const videoId = state.playing;
  if (state.liking) return; // state, not the DOM: the `l` shortcut calls this directly
  // .disabled now means ONLY "nothing playing" (a like in flight is aria-disabled,
  // so the button keeps focus) — which !videoId already covers. Kept as a belt.
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

  state.liking = true;
  updateLikeButton(); // disables the button for the duration (incl. the popup)
  try {
    if (!hasSession()) {
      showToast('Authorizing with Google…', { type: 'info' });
    }
    // Silent when a token is already live; falls back to the consent prompt.
    // Anything thrown here (cancelled popup, GIS missing) lands in the OUTER
    // catch with the like flag UNTOUCHED — which is the whole reason the flip
    // below sits after this await and not before it.
    await ensureAuthorized(state.clientId);
    updateAuthUi(); // a fresh token flips the status label straight away

    // Optimistic (visual) update — only now that we are authorized.
    rec.liked = nextLiked;
    updateLikeButton();

    try {
      await rateVideo(videoId, nextRating); // ~50 quota units; writes to YouTube
      persistRecord(rec).catch(reportIfFatalDb); // persist the local liked flag
    } catch (err) {
      if (err instanceof ApiError && (err.kind === 'auth' || err.kind === 'forbidden')) {
        // Write scope not granted yet. forceNew, because the token we already
        // hold IS the problem — the default silent path would hand back that
        // same scope-less token and the retry would fail identically. No double
        // prompt: the call above was silent (or its consent produced the token
        // this one is replacing).
        try {
          showToast('Requesting YouTube access to like videos…', { type: 'info' });
          await ensureAuthorized(state.clientId, { forceNew: true });
          await rateVideo(videoId, nextRating);
          persistRecord(rec).catch(reportIfFatalDb); // persist on success
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
  } catch (err) {
    // Authorization itself failed (cancelled popup, GIS not loaded, no Client
    // ID). Nothing was flipped, so there is nothing to revert.
    handleError(err);
  } finally {
    state.liking = false;
    updateLikeButton();
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
  // ONE fresh yqa_channels read for the WHOLE render (see channelResolver):
  // never a boot snapshot, and never re-parsed once per card.
  renderQueue(
    dom.queueList,
    windowed,
    {
      onSkip: (id) => toggleRemove(id),
      onPlay: (id) => playVideo(id),
      onCardSpeed: (id, speed) => onCardSpeed(id, speed),
    },
    channelResolver(loadChannels()),
    more,
    'Remove'
  );

  if (state.playing) markPlayingCard(state.playing);

  updatePlayingControls();
  updateCleanupUi();
}

/**
 * "Show all (N)": reveal every card for THIS session (in-memory, not persisted).
 *
 * FOCUS MUST BE PLACED BY HAND, because activating this button destroys it:
 * render() -> renderQueue() -> clear() takes the whole `li.queue-more` away, and
 * with `more` now null nothing replaces it, so focus would fall to <body> — a
 * dead end for a keyboard user who has just arrowed down onto it. The honest
 * landing is the FIRST NEWLY-REVEALED card, which is simply the card at the
 * pre-expansion count. Identical to the subscriptions page, deliberately.
 */
function onShowAll() {
  // Counted BEFORE the re-render: afterwards the list is the expanded one and
  // the boundary is gone.
  const revealedAt = queueFocus ? queueFocus.cardCount() : 0;
  state.showAll = true;
  render();
  if (queueFocus) queueFocus.focusCardAt(revealedAt);
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
// Keyboard shortcuts. STASH: ↑/↓ move, PgUp/PgDn scroll (carrying focus with
// them), Home/End jump to either end, x remove, Enter play focused
// card, 1/5/2 preferred speed. PLAYER: Space play/pause, ←/→ seek, -/+ speed,
// n next, l like, m mute, f fullscreen. BOTH: '/' throws focus between the two
// panes. Ignored while typing in an input (the add field lives on this page, so
// this matters more here), during onboarding, and for Ctrl/Cmd/Alt combos
// (Shift stays allowed for '+', and for '/' on the layouts that shift it).
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

/**
 * Index of the card that CONTAINS focus, or -1 when focus is outside this
 * list altogether. Resolving by closest('.row') rather than by an exact match
 * is what keeps the card shortcuts alive while focus sits on a control INSIDE
 * a card — ▶ Play, Remove, a speed button — every one of which used to make
 * them inert. Scoping is free: `rows` holds only this list's cards, so a .row
 * from anywhere else answers -1. Mirrors subscriptions-page.js exactly.
 *
 * NOT for Enter/Space, which must match the .row exactly — see that branch.
 * @param {HTMLElement[]} rows the queue list's .row elements, in order
 * @param {Element|null} active document.activeElement
 * @returns {number}
 */
function focusedCardIndex(rows, active) {
  const card = active && active.closest ? active.closest('.row') : null;
  return card ? rows.indexOf(card) : -1;
}

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
  const idx = focusedCardIndex(rows, active);

  if (key === 'arrowup' || key === 'arrowdown') {
    // ↑ = previous card (upward in the oldest->newest list), ↓ = next. The
    // whole rule lives in page-chrome's moveCard — what they walk (the cards,
    // then the "Show all (N)" footer button when one is rendered), where the
    // keys apply (a layout question, not a focus one), the remembered card they
    // ENTER the list at, and the clamp at both ends — and it reports whether it
    // TOOK the key.
    // preventDefault ONLY on true, so everything it declines keeps its native
    // scrolling: the player pane, the stacked layout's document, and a clamp at
    // either end of the list. Identical to the subscriptions page, clamp
    // included, where the clamp is also what gets focus out of a card menu this
    // page does not have.
    if (queueFocus && queueFocus.moveCard(key === 'arrowup' ? -1 : 1)) e.preventDefault();
  } else if (key === 'pageup' || key === 'pagedown') {
    // The SAME move as ↑/↓, only further: moveCard steps QUEUE_PAGE_STEP walk
    // items instead of one and lands the destination at the top of the pane.
    // Same took-the-key contract, so a clamp at either end reports false and
    // native scrolling finishes the job. Identical to the subscriptions page.
    if (queueFocus && queueFocus.moveCard(key === 'pageup' ? -1 : 1, { page: true })) {
      e.preventDefault();
    }
  } else if (key === 'home' || key === 'end') {
    // ABSOLUTE keys: "the beginning" / "the end" of the LIST, so they name their
    // target rather than step from wherever focus is, and the focus scroll
    // follows. Prevented only when page-chrome took the key — an empty stash
    // declines and Home/End keep their native meaning. Note the add field is an
    // INPUT, so the typing guard above has already let Home/End through to it.
    if (queueFocus && queueFocus.focusEdge(key === 'home' ? -1 : 1)) e.preventDefault();
  } else if (key === '/') {
    // '/' is the absolute jump between the two BIG panes, with the queue as
    // home: from the queue into the player, from anywhere else — the player, any
    // of the small panes, <body> — back to the remembered card. ALWAYS prevented
    // — Firefox opens Quick Find on '/' otherwise — and read off e.key, so a
    // layout that puts '/' behind Shift still reaches us (Shift is allowed).
    e.preventDefault();
    if (paneNav) paneNav.togglePane();
  } else if (key === '[' || key === ']') {
    // [ / ] step the pane RING — nav, toolbar, add form, queue actions, queue,
    // player — wrapping at both ends, where '/' jumps straight between the two
    // big ones. The skip past a pane that cannot take focus and the fallback to
    // the last pane focus was in both live in page-chrome's movePane, which
    // reports whether it took the key on moveCard's contract. Neither bracket
    // has a native action to preserve, so prevented only on true costs nothing.
    // Note the add field is an INPUT, so the typing guard above has already let
    // both through to it: that pane is entered with these keys but not left.
    if (paneNav && paneNav.movePane(key === '[' ? -1 : 1)) e.preventDefault();
  } else if (key === 'p') {
    // p = jump to the now-playing card, the third of the absolute jumps and the
    // only one with a target that can be absent. Deliberately NOT gated on the
    // button's disabled property — the handler already reports whether it found
    // a card, and a DOM property read would be a second answer to the same
    // question, free to drift from the first. Nothing playing, or its card not
    // rendered: no move, no preventDefault, and 'p' keeps its native meaning.
    // Works from anywhere on the page, the player pane included. Identical to
    // the subscriptions page.
    if (onScrollToPlaying()) e.preventDefault();
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
  } else if (key === 'enter') {
    // Play the FOCUSED card — the ONE card shortcut that matches the .row
    // EXACTLY instead of going through focusedCardIndex. Enter already activates
    // a focused button or link natively, so acting on the card that CONTAINS
    // that button would fire twice over. The inconsistency with x/1-5-2 is the
    // point; do not tidy it away. (Space, below, is guarded the same way — by
    // tag — for the same reason.)
    if (rows[idx] === active) {
      e.preventDefault();
      playVideo(active.dataset.videoId);
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
// repaints THIS page's auth UI. Add failures do not come through here: they get
// their own toast, worded by describeAddFailure.
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
  // Auth-cancellation and generic errors. describeAuthFailure keeps auth.js's
  // plain Errors (GIS not loaded, a token request already in flight) from
  // reaching the user as raw internal strings.
  showToast(describeAuthFailure(err), { type: 'error' });
}
