// js/page-chrome.js
//
// Leaf page chrome shared by every entry point — the single-tab lock, the
// fatal-storage halt screens, the privacy curtain, the two-pane focus
// navigation both player pages drive from their arrow keys, and the plain
// single-column walk the Channels page drives from the same keys. No app state and no
// queue logic: it imports only ui.js, toast.js, the two error classes from
// store.js, one tunable from config.js (the constants file, not a layer) and
// one pure helper from queue.js — no cycle, since queue.js imports nothing but
// config.js and is never given this module in return.
//
// Everything here is per-DOCUMENT, not per-page: each export takes what varies
// (the lock name, the curtain node, the iframe getter, the two panes) as an
// argument, so a new entry point gets the same chrome without this module
// learning about it. Nothing here BINDS a key: like the curtain's Esc, the focus
// navigation is exposed as functions each page's own keydown table calls.

import { QUEUE_PAGE_STEP } from './config.js';
import { nearestSurvivor, paneCandidates } from './queue.js';
import { el, setVisible, stepCardMenu } from './ui.js';
import { showToast } from './toast.js';
import { DbBlockedError, DbUnavailableError } from './store.js';

// ---------------------------------------------------------------------------
// Single-tab lock
//
// Two tabs of the same page writing the same object store would clobber each
// other (both hold the whole record set in memory and write it back). One named
// Web Lock is the whole mechanism, and it is race-free by construction: the
// browser grants it to exactly one document, so there is no handshake to get
// wrong and no window in which two tabs opened at the same instant can both
// proceed. A backgrounded or frozen tab keeps holding it — a lock is not a
// message it could fail to answer.
//
// The grant is held for the document's LIFETIME by returning a promise that
// never settles; the browser releases it when the document goes away (closed,
// navigated away, discarded) — nothing to unwind by hand. That also means
// request()'s own promise never settles, which is why the granted/not-granted
// answer travels out through a SEPARATE promise resolved inside the callback.
//
// FAILS OPEN, NEVER CLOSED: no `navigator.locks`, or a request that throws or
// rejects, counts as granted and the page boots exactly as it did before the
// guard existed. Locking the owner out of their own queue would be far worse
// than the two-tab clobber this prevents.
// ---------------------------------------------------------------------------

/**
 * Ask for the named single-tab Web Lock and report whether this document got
 * it. Reentrant: the answer comes back as a promise rather than a module-level
 * flag, so a page may hold more than one lock (or none).
 *
 * The caller fires this as early as possible and awaits it at its own
 * checkpoint — before it reads a store, restores a setting or binds a handler —
 * so a tab that did not get the lock halts having touched nothing.
 *
 * @param {string} name Web Lock name (from config.js — never a storage key).
 * @returns {Promise<boolean>} true = this tab owns the store (or the guard did
 *   not engage).
 */
export function requestTabLock(name) {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') {
    return Promise.resolve(true); // fail open: guard does not engage
  }
  let answer;
  const granted = new Promise((resolve) => {
    answer = resolve;
  });
  try {
    navigator.locks
      .request(name, { ifAvailable: true }, (lock) => {
        answer(Boolean(lock));
        // Not granted: return at once, leaving the holding tab undisturbed.
        // Granted: never settle, so this document holds the lock until it dies.
        return lock ? new Promise(() => {}) : undefined;
      })
      .catch(() => answer(true)); // fail open
  } catch {
    answer(true); // fail open
  }
  return granted;
}

// ---------------------------------------------------------------------------
// Fatal storage errors
// ---------------------------------------------------------------------------

/**
 * What to run when a fatal screen goes up. The wall covers the player but does
 * not silence it, and the user is left hunting for audio with no visible source.
 *
 * A PARAMETER, not an import: this module knows nothing about the player, the
 * two player pages hand in player.js's stopPlayback, and channels.html — which
 * has no player — registers nothing and is unaffected.
 */
let onFatalHalt = null;
export function setFatalHaltHandler(fn) {
  onFatalHalt = typeof fn === 'function' ? fn : null;
}

// One fatal storage screen per page load — see FIRST CAUSE WINS below.
let fatalStorageErrorShown = false;

// Everything a fatal screen must take off the page with it. Resolved by
// SELECTOR at call time rather than passed in, because this module holds no
// `dom` map; a selector a page has no match for is a silent no-op.
//
// The skip links are hidden for a stronger reason than the panels, which are
// merely redundant: they are actively WRONG here. Both point into #app-main,
// which this same pass hides, so they offer a jump that lands nowhere. They
// were covered by the overlay when it was a fixed full-viewport scrim, and
// surfaced when it moved below the header.
//
// The header is deliberately NOT here: its page nav is the one thing on this
// screen that still works, and reaching another page is a real way out.
const HIDDEN_ON_FATAL = ['#setup-panel', '#cutoff-panel', '#app-main', '.skip-link'];

/**
 * BLOCKING error for a FATAL storage condition: the video store is unusable, so
 * the page halts rather than run on a queue it cannot read or save. It fills the
 * page below the header, which stays live so the nav can reach another page.
 * Shared by the four callers below; only the copy differs. All are
 * resolved by fixing the environment and reloading, hence the single Reload
 * action. Built with el()/text nodes (no innerHTML for the dynamic reload
 * wiring), matching the panel look.
 *
 * FIRST CAUSE WINS: later calls are ignored, because one fatal condition
 * routinely produces another — a mid-session stand-down (onversionchange) makes
 * every write still in flight reject, one screen per rejection, and an aborted
 * blocked upgrade sets both sticky flags, so a second, vaguer diagnosis would
 * paint over the first. Every screen ends in Reload, so the earliest, truest one
 * is the one to keep.
 * @param {{heading:string, paragraphs:Array<string>, toast:string}} copy
 */
export function showFatalStorageError({ heading, paragraphs, toast }) {
  if (fatalStorageErrorShown) return;
  fatalStorageErrorShown = true;
  // Inside the first-cause guard, so it runs exactly once, and BEFORE the screen
  // is built, so the defensive toast path below silences the page too. A no-op
  // where nothing has played — the superseded tab halts before it can start.
  if (onFatalHalt) {
    try {
      onFatalHalt();
    } catch {
      /* a failed stop must never keep the screen off the page */
    }
  }
  const overlay = document.getElementById('blocked-overlay');
  if (!overlay) {
    // Defensive: without the container, at least surface it as a toast.
    showToast(toast, { type: 'error' });
    return;
  }
  // Hide the scaffolding and the chrome that would mislead. querySelectorAll,
  // not getElementById: .skip-link matches twice on the queue pages.
  for (const selector of HIDDEN_ON_FATAL) {
    for (const node of document.querySelectorAll(selector)) setVisible(node, false);
  }

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
export function showBlockedError() {
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
export function showDbUnavailableError() {
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
 * Another tab of this page holds its tab lock, so this one is superseded. The
 * store has already been stood down, so nothing here can write; this is the
 * visible half of that halt (see the Single-tab lock section).
 *
 * NAMES THE PAGE, and takes it as a parameter like everything else page-specific
 * in this module. The two locks are independent and guard two different object
 * stores, so a Subscriptions tab and a Stash tab open at once is legitimate; an
 * unqualified "the queue is already open" reads as a conflict between them and
 * sends the user to close a tab that is not the one holding the lock. Contrast
 * the DB-level screens above, which stay unqualified because the DATABASE really
 * is shared and every tab of every page is a candidate.
 * @param {string} pageLabel this page's own name, e.g. 'Subscriptions'
 */
export function showSupersededError(pageLabel) {
  showFatalStorageError({
    heading: `The ${pageLabel} page is already open`,
    paragraphs: [
      `The ${pageLabel} page is open in another browser tab. Only one tab at a ` +
        'time may write to its stored videos, so this one stopped before it could touch them.',
      'Close this tab, or reload after closing the other one, or navigate to a different page.',
    ],
    toast: `The ${pageLabel} page is already open in another tab. Close it, then reload this page.`,
  });
}

/**
 * The database opened, but reading it failed (a plain DOMException from the
 * transaction or the getAll() request). The rows may well still be there, so the
 * app must NOT continue on an empty queue and write over them. The underlying
 * error is shown because it is the only diagnostic the user gets.
 * @param {unknown} err the rejection from getAllVideos()
 */
export function showDbReadError(err) {
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
export function describeError(err) {
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
 * Word a NON-ApiError failure — in practice everything auth.js throws, since it
 * raises plain Errors that carry no `kind` for an ApiError router to switch on.
 * Lives here rather than in either page because BOTH queue pages authorize on
 * demand and would otherwise keep a copy each; the copy is therefore NEUTRAL
 * about what was being attempted, and a caller that needs context adds its own
 * (cf. stash-page.js's describeAddFailure, whose add-specific wording is
 * deliberate). Pure string picker.
 * @param {unknown} err
 * @returns {string}
 */
export function describeAuthFailure(err) {
  const message = (err && err.message) || '';
  if (/Identity Services/i.test(message)) {
    return 'Google sign-in has not loaded yet. Give it a moment, then try again.';
  }
  if (/already in progress/i.test(message)) {
    return 'A sign-in is already in progress — finish that one first.';
  }
  const code = err && err.code;
  if (code === 'popup_closed' || code === 'access_denied' || /cancel/i.test(message)) {
    return 'Sign-in was cancelled, so nothing was changed.';
  }
  return message || 'Something went wrong.';
}

/**
 * Swallow a best-effort (optional) store write's failure — EXCEPT the fatal DB
 * conditions, which put up their halt screen so the user is actually told.
 * `dbBlocked` can flip AFTER init via db.onversionchange (another tab starting a
 * schema upgrade), and from then on every write no-ops; without this the card
 * speed / watch position / like flag would silently stop persisting.
 * Use as `putVideo(rec).catch(reportIfFatalDb)`.
 * @param {unknown} err
 */
export function reportIfFatalDb(err) {
  // DbUnavailableError is practically unreachable post-init (init awaits the
  // memoized openDb() and halts), but it costs nothing to cover it here too.
  if (err instanceof DbBlockedError) {
    showBlockedError();
    return;
  }
  if (err instanceof DbUnavailableError) {
    showDbUnavailableError();
    return;
  }
  // Anything else is a transient failure on an optional write: keep the call
  // site's intent and stay quiet (a refresh is never failed over one).
}

// ---------------------------------------------------------------------------
// Privacy curtain: a full-viewport overlay that hides the whole page. Covers the
// page on a wheel-DOWN anywhere outside the exempt scroll area (or Esc), lifted
// by a wheel-UP (or Esc). Visual only — the player is NOT paused.
// ---------------------------------------------------------------------------

// Keys whose effect ESCAPES the curtain, so the one gesture that hides the
// screen cannot be undone by a stray keypress. Only fullscreen does: it hands
// the player iframe to the browser's own fullscreen layer, which is outside the
// z-index stack the curtain sits on top of, so the video would play over it.
// Every other shortcut stays live — the curtain is a screen COVER, not a lock,
// and the queue already mutates behind it unprompted (auto-advance on ENDED,
// the position poll). A Google consent window can also open over the curtain,
// but NOT from one key worth naming here: ensureAuthorized backs Sign in, both
// refresh buttons and the stash's Add too, all reachable by Enter/Space on a
// focused button. A visible popup beats several silently dead controls.
const SCREEN_ESCAPING_KEYS = new Set(['f']);

/**
 * Bind the curtain's wheel behavior and hand back its controls. The covering
 * flag lives in this closure — the calling page does not mirror it.
 *
 * Esc deliberately stays with the caller's own keydown table: this module owns
 * no keyboard shortcuts, so a page wires Esc to the returned `toggle`.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.node the `#curtain` overlay (tolerates null).
 * @param {string} [opts.exemptSelector] wheeling inside a match scrolls it
 *   normally and never drives the curtain.
 * @param {string} [opts.narrowQuery] media query for the stacked layout, where
 *   the whole page scrolls, so a wheel-down must not cover it.
 * @param {boolean} [opts.coverOnWheelDown] false for a page whose document
 *   scrolls at EVERY width (rather than a 100dvh flex column): wheel-down never
 *   covers there, while wheel-up still lifts. Same rule the narrow breakpoint
 *   encodes, stated by layout instead of width.
 * @returns {{isCovering: () => boolean, set: (covering:boolean) => void,
 *   toggle: () => void, suppressesKey: (key:string) => boolean}}
 */
export function initCurtain({
  node,
  exemptSelector = '.workspace',
  narrowQuery = '(max-width: 1080px)',
  coverOnWheelDown = true,
} = {}) {
  let covering = false;

  // The curtain is a solid overlay with no content, so it contributes NOTHING to
  // the accessibility tree and leaves the page behind it fully exposed — nothing
  // is inert or aria-hidden, deliberately, since a screen reader user has more
  // reason to want a screen cover than less. Without this region the state
  // change is the one thing they get no signal for at all. Built here rather
  // than in each page's HTML: no page mirrors the covering flag, so none owns
  // this either. It must exist BEFORE the first toggle — a live region inserted
  // in the same tick as its text does not reliably announce.
  // Outside `node`, never inside it: the curtain carries aria-hidden="true" when
  // lifted, which would swallow the "uncovered" announcement.
  const status = document.createElement('p');
  status.className = 'sr-only';
  status.setAttribute('role', 'status');
  document.body.appendChild(status);

  /** Reflect the covering flag onto the overlay element (class + aria), and
   *  announce the change. Announced only on an ACTUAL change, or a repeated
   *  set(true) from the wheel would re-announce a state that never moved. */
  function set(next) {
    const changed = Boolean(next) !== covering;
    covering = Boolean(next);
    if (changed) status.textContent = covering ? 'Screen covered' : 'Screen uncovered';
    if (!node) return;
    node.classList.toggle('is-covering', covering);
    node.setAttribute('aria-hidden', String(!covering));
  }

  /** Wheel handler: scroll INSIDE the exempt area scrolls it; elsewhere it
   *  drives the curtain — down covers, up lifts (binary by direction). While the
   *  curtain is covering it is on top, so a wheel event's target is the curtain
   *  (not the queue), and a scroll-up over it lifts it. In the stacked layout the
   *  page scrolls as one column, so scroll-down does NOT cover the page (Esc
   *  still does) — but a scroll-up may still lift an already-covered curtain. */
  function onWheel(e) {
    // Stacked layout: the whole page scrolls, so scroll-down must not cover the
    // page (it would fight normal scrolling). But scroll-up may still LIFT an
    // already-covered curtain on any width. Reuse the player-above-queue
    // breakpoint.
    const narrow = window.matchMedia(narrowQuery).matches;
    const t = e.target;
    // Let the exempt pane(s) scroll normally — wheeling over the queue list or
    // the player's description never triggers the curtain. Only the
    // header/toolbar/stats region ABOVE it covers the page.
    if (t && typeof t.closest === 'function' && t.closest(exemptSelector)) return;
    if (e.deltaY > 0) {
      // scroll down -> cover (wide, cover-capable layouts only)
      if (coverOnWheelDown && !narrow && !covering) set(true);
    } else if (e.deltaY < 0) {
      if (covering) set(false); // scroll up -> lift (any width)
    }
  }

  window.addEventListener('wheel', onWheel, { passive: true });

  return {
    isCovering: () => covering,
    set,
    toggle: () => set(!covering),
    // Asked by each page's keydown table for EVERY key, so the escaping-key list
    // is named once here rather than duplicated across two tables that would
    // drift. Esc never reaches it: the panic key is handled before every guard.
    suppressesKey: (key) => covering && SCREEN_ESCAPING_KEYS.has(key),
  };
}

// ---------------------------------------------------------------------------
// Cross-origin iframe focus guard
// ---------------------------------------------------------------------------

/**
 * Clicking the video moves keyboard focus INTO the cross-origin player iframe,
 * which swallows keydown so the page's shortcuts (incl. the Esc curtain) stop
 * firing. On window blur, if focus landed on that iframe, hand it back to the
 * document so keydown keeps reaching us. Guarded so alt-tabbing away (page
 * hidden) doesn't yank focus back.
 *
 * The getter is a parameter so this module imports no layer module.
 * @param {() => HTMLIFrameElement|null} getIframe
 */
export function bindIframeFocusGuard(getIframe) {
  window.addEventListener('blur', () => {
    // Defer so document.activeElement settles to the newly-focused iframe.
    setTimeout(() => {
      if (document.hidden) return; // switched tab/app: leave focus alone
      const iframe = getIframe();
      if (iframe && document.activeElement === iframe) {
        iframe.blur(); // returns focus to document.body; keydown reaches us again
      }
    }, 0);
  });
}

/**
 * Focus the first candidate that will actually TAKE it, and report which did.
 * For handing focus off a control that is about to be disabled or hidden — the
 * browser drops that focus to <body>, which is the whole defect.
 *
 * The ladders are two or three deep because the obvious landing is often itself
 * hidden, disabled or inside the subtree that just went away, and focusing one
 * of those re-drops focus to <body>. Verifying activeElement afterwards catches
 * every reason a focus() can fail without enumerating them.
 * @param {...(Element|null|undefined)} candidates in order of preference
 * @returns {Element|null} the one that took focus, or null if none did
 */
export function focusFirst(...candidates) {
  for (const el of candidates) {
    if (!el) continue;
    el.focus();
    if (document.activeElement === el) return el;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Queue focus navigation
//
// Both player pages are the same two-pane workspace and need the same moves:
// walk the queue with ArrowUp/ArrowDown, page through it with PageUp/PageDown,
// reach either end with Home/End, and get back INTO the list after focus has
// wandered off it. Moving BETWEEN panes is initPaneNav, at the foot of this
// file. It lives here because the two pages' keydown tables have drifted apart
// before. Everything that varies — the pane nodes, the media query — is a
// parameter, and each page writes its OWN table entries calling in: this module
// binds no key.
//
// WHAT THE KEYS WALK is [card1 … cardN, "Show all (N)"?] (walkItems below). The
// footer button is a walk ITEM, never a card, because the two things a card is —
// the target the list is ENTERED at, and what x / t / 1,5,2 act on — are both
// meaningless for it. Every key MOVES FOCUS AND LETS THE SCROLL FOLLOW, never
// the reverse; PageUp/PageDown step a fixed number of ITEMS rather than riding
// the native scroll, and that is not a regression to fix — a card is ~383px tall
// in a ~531px pane, so a native page advances barely more than one card, and the
// focus-cursor sync it needs can stall outright.
//
// THE REMEMBERED CARD is what a press from OUTSIDE the list enters at — focus
// lands on <body> constantly, bindIframeFocusGuard (above) putting it there on
// every click of the video. It is the last-focused card's VIDEOID, never its
// element, because renderQueue() rebuilds the <ul> and a node reference would be
// detached one render later; it resolves against the CURRENT list at use time
// and falls back to the first card. CARDS ONLY: "Show all" is never an honest
// place to be dropped into the queue.
// ---------------------------------------------------------------------------

/**
 * Wire up the WITHIN-QUEUE focus moves for a two-pane page and hand back the
 * gestures its keydown table needs. Installs exactly one listener — a `focusin`
 * on the queue list, which is how the remembered card is kept up to date — and
 * binds no keys of its own.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.queueList the `<ul>` of `.row` cards. Its
 *   contents are re-created wholesale by renderQueue, so nothing is cached.
 * @param {HTMLElement|null} opts.queuePane the scrolling `.workspace__queue`
 *   around it. Only the STACKED layout consults it (see walkApplies), and it is
 *   wider than the list: it takes in the sticky header buttons, from which a
 *   press enters the list rather than doing nothing.
 * @param {HTMLElement|null} opts.playerPane the `.workspace__player` aside. It
 *   carries `tabindex="0"` in the HTML, so it is a tab stop of its own — it
 *   PRECEDES the queue in the markup, so Tab reaches it on the way IN, and '/'
 *   reaches it from the queue; once focused it scrolls natively, the only way to
 *   read a long description without tabbing through every card's controls.
 * @param {string} [opts.narrowQuery] media query for the STACKED layout, where
 *   the document scrolls rather than the panes — the question initCurtain asks,
 *   asked the same way.
 * @returns {{moveCard: (dir:number, opts?:{page?:boolean}) => boolean,
 *   focusEdge: (dir:number) => boolean,
 *   cardCount: () => number, focusCardAt: (index:number) => Element|null,
 *   rememberCard: (videoId:string|null|undefined) => void,
 *   renderKeepingAnchor: (rerender:() => void) => Element|null,
 *   focusRemembered: (opts?:{preventScroll?:boolean}) => Element|null,
 *   captureQueueScroll: () => () => void}}
 */
export function initQueueFocus({ queueList, queuePane, playerPane, narrowQuery = '(max-width: 1080px)' } = {}) {
  // The videoId of the card the walk resumes at — an id, never a node, so it
  // survives every re-render. Null until the user has been in the list. Focus
  // landing in a card is its usual writer (the focusin below), but not its only
  // one: a page that moves the user's PLACE without moving focus sets it
  // outright through rememberCard, and no focusin fires for that.
  let rememberedId = null;

  // The card a POINTER press just placed the cursor on, carrying `row--pointed`
  // — which is half of what styles.css draws the card ring on, the other half
  // being :focus-visible. Without it the ring rule would have to be a plain
  // :focus, and every programmatic focus this module performs would draw a ring
  // after a MOUSE gesture: Clean up, Trim front, "Show all (N)" and the removal
  // rescue all move focus onto a card the user never chose. It marks the one
  // pointer gesture that IS a placement rather than guessing at a modality, so
  // a future focus site inherits the right behaviour without knowing this
  // exists. A node, not an id: it lives only until the next focusin, and a
  // re-render drops the class with the <ul> it was on.
  let pointedCard = null;

  if (queueList) {
    // pointerdown, not click: the mark has to be set BEFORE focus moves.
    //
    // A press that lands on a CONTROL inside the card is not a placement — it
    // is an action — so it does not mark. For ▶ Play, Skip, the speed buttons
    // and the menu that is only a shortcut: they land focus on the control
    // rather than the card, so the focusin below would have cleared the mark
    // anyway. It is load-bearing for exactly one press, the THUMBNAIL, which is
    // aria-hidden and hands its focus to the row (see ui.js) — landing on the
    // marked card ITSELF, which is the one shape focusin keeps. Without this it
    // rang, making a mouse click paint a keyboard cursor. Asking what was
    // pressed is the honest question; `did focus land on the card` was only ever
    // a proxy for it, and the thumbnail is where the proxy broke.
    queueList.addEventListener('pointerdown', (e) => {
      const target = e.target && e.target.closest ? e.target : null;
      const card = target ? target.closest('.row') : null;
      const control = target ? target.closest('a, button') : null;
      const placed = control && card && card.contains(control) ? null : card;
      if (pointedCard && pointedCard !== placed) pointedCard.classList.remove('row--pointed');
      pointedCard = placed;
      if (placed) placed.classList.add('row--pointed');
    });

    // focusin (not focus) because it BUBBLES: the note must be taken whether
    // focus landed on the card itself or on ▶ Play, Skip, a speed button or a
    // card-menu item inside it — the same closest('.row') rule the card
    // shortcuts resolve by. Focus on something in the list that is NOT a card
    // (the "Show all (N)" button) leaves the previous note standing: the note
    // answers "where does a press from OUTSIDE the list go", and that must be a
    // card. Arrowing back UP off "Show all" never consults it — that step is by
    // POSITION, to the card you must have come down from.
    queueList.addEventListener('focusin', (e) => {
      const card = e.target && e.target.closest ? e.target.closest('.row') : null;
      const id = card && card.dataset ? card.dataset.videoId : null;
      if (id) rememberedId = id;
      // The mark survives only while focus is on the marked card ITSELF, and is
      // retired the moment focus moves anywhere else — a walk on to the next
      // card, or a control reached inside this one. Presses on controls no
      // longer mark at all (see pointerdown), so this is the tail that drops a
      // mark once the user moves on, not the thing that unrings a button press.
      if (pointedCard && e.target !== pointedCard) {
        pointedCard.classList.remove('row--pointed');
        pointedCard = null;
      }
    });
  }

  if (playerPane) {
    // The pane is focusable ITSELF, so a click on its background focuses it
    // silently — and Chrome's :focus-visible heuristic then rings it on the
    // next keydown, ANY keydown, a seek or a like or a mute included. Freeze
    // the browser's own verdict at the moment focus LANDS and hold it for that
    // focus session: no modality is guessed at, so Tab, '/', the '[' / ']'
    // cycle and the skip link keep the ring they have today, and only the later
    // keypress stops changing the answer. focusin BUBBLES, so the target check
    // is what stops a control focused inside the pane answering for it. The
    // class may linger while the pane is unfocused — inert, the rule needs
    // :focus-visible and the next arrival recomputes it.
    playerPane.addEventListener('focusin', (e) => {
      if (e.target !== playerPane) return;
      playerPane.classList.toggle(
        'workspace__player--pointed',
        !playerPane.matches(':focus-visible'),
      );
    });
  }

  /** This list's cards, in DOM order. Re-queried every time: the <ul> is rebuilt. */
  function cards() {
    return queueList ? Array.from(queueList.querySelectorAll('.row')) : [];
  }

  /**
   * Move the walk cursor to `videoId` WITHOUT moving focus — for the two places
   * the user's position changes while focus is somewhere else entirely: the
   * Hide-skipped toggle (focus is on the button that was pressed) and a card
   * removed out from under a cursor that was never in it. Neither fires a
   * focusin, so without this the walk silently falls back to the first card.
   * @param {string|null|undefined} videoId
   */
  function rememberCard(videoId) {
    if (typeof videoId === 'string' && videoId) rememberedId = videoId;
  }

  /**
   * The "Show all (N)" footer button when one is rendered — the walk's last
   * item, after every card. Re-queried like cards(): renderQueue rebuilds the
   * <ul>, and whether the button is there at all changes with the window. Null
   * the rest of the time, which is what makes "clamp on the last card" the
   * untouched old behaviour.
   */
  function moreButton() {
    return queueList ? queueList.querySelector('.queue-more__btn') : null;
  }

  /**
   * The card to resume at: the remembered videoId if it is still rendered, else
   * the first card, else null (an empty list). Matched by comparing
   * dataset.videoId — as findCard() does on both pages — rather than through a
   * [data-video-id="…"] selector, so an id needs no escaping to be safe.
   */
  function rememberedCard(rows) {
    if (rememberedId) {
      for (const row of rows) {
        if (row.dataset.videoId === rememberedId) return row;
      }
    }
    return rows[0] || null;
  }

  /**
   * Does queue navigation apply to the key being handled right now? THE ONE
   * GATE — every move in this module asks it, so there is one answer.
   *
   * IT IS A QUESTION ABOUT LAYOUT, not about what happens to hold focus. In the
   * two-pane layout `body.app-active` is a 100dvh flex column whose panes scroll
   * INTERNALLY, so outside the player pane there is no native scroll for a key
   * to belong to and it belongs to the queue — including from <body>, where
   * focus keeps landing (bindIframeFocusGuard puts it there on every click of
   * the video). Stacked (<=1080px) the queue pane is `overflow: visible` and the
   * DOCUMENT scrolls, so there is one, and only focus genuinely INSIDE the queue
   * pane is taken.
   *
   * The player pane is out at EVERY width: it scrolls natively and that is the
   * whole reason it is focusable, so these keys must go on scrolling a long
   * description rather than be stolen by the list in the other pane.
   *
   * Asked by media query rather than by measuring, following initCurtain.
   * @returns {boolean} false = decline the key entirely, changing nothing
   */
  function walkApplies() {
    const active = document.activeElement;
    if (playerPane && active && playerPane.contains(active)) return false;
    // Stacked: the document scrolls, so take the key only inside the queue pane.
    if (window.matchMedia(narrowQuery).matches) {
      return Boolean(queuePane && active && queuePane.contains(active));
    }
    return true;
  }

  /**
   * THE WALK: [card1 … cardN, "Show all (N)"?] — every card, then the windowing
   * footer button when one is rendered. With no button rendered the last card is
   * the last item, exactly as it always was.
   *
   * EMPTY when there are no cards, and that is total: the button cannot outlive
   * them (it renders only when there are MORE records than fit), so "no cards"
   * means there is nothing to walk at all rather than a walk of one button.
   * @param {HTMLElement[]} [rows] this list's cards, when the caller has them already
   * @returns {HTMLElement[]}
   */
  function walkItems(rows = cards()) {
    if (!rows.length) return [];
    const more = moreButton();
    return more ? [...rows, more] : rows;
  }

  /**
   * Step focus along the walk in `dir` (-1 = previous/up, +1 = next/down) and
   * report whether the key was HANDLED — the caller preventDefaults on true and
   * only on true, so everything this declines keeps its native scrolling. What
   * it walks is walkItems, where it applies is walkApplies.
   *
   * ONE FUNCTION FOR BOTH RELATIVE KEYS: the arrows step 1, PageUp/PageDown pass
   * `{ page: true }` and step QUEUE_PAGE_STEP. Writing the walk resolution, the
   * entry-from-outside rule and the clamp a second time is the drift this module
   * exists to prevent.
   *
   * A PAGE JUMP SCROLLS EXACTLY AS A SINGLE STEP DOES — a plain focus(), so the
   * browser's default "nearest" applies to both: no scroll at all when the
   * destination is already on screen, and otherwise the least that brings it
   * into view, settling against whichever edge it came in from. The step SIZE is
   * the only difference between the two keys.
   *
   * CLAMPS at both ends rather than wrapping, and the clamp still places focus
   * on the item while reporting NOT-handled. Both halves matter: landing on the
   * .row is how the PAGE keys get focus out of an open card menu (it leaves the
   * .row__menu wrapper, whose focusout dismisses it — the arrows leave by the
   * menu step below instead), and reporting not-handled gives the pane its
   * native scroll back at the ends of the walk, so ArrowDown on the LAST item
   * still scrolls to the bottom of a tall card and on to the end of the pane.
   * @param {number} dir -1 = up/previous, +1 = down/next
   * @param {object} [opts]
   * @param {boolean} [opts.page] true = one page key's worth (QUEUE_PAGE_STEP
   *   items) instead of a single step. Nothing else about the move differs.
   * @returns {boolean} true only when focus moved to a DIFFERENT walk item
   */
  function moveCard(dir, { page = false } = {}) {
    if (!walkApplies()) return false;
    // AN OPEN CARD MENU WALKS FIRST, and only a single step at a time: its items
    // sit above their own trigger, so one arrow sequence reads down the panel
    // and straight on into the cards. 'exited' has already closed the menu and
    // left focus on the trigger — inside the .row — so the ordinary step below
    // resolves that same card and moves to its neighbour, which IS "out of the
    // menu and on to the next card". PageUp/PageDown skip this deliberately:
    // paging past a menu leaves the wrapper outright and its focusout closes it.
    if (!page && stepCardMenu(dir) === 'moved') return true;
    const rows = cards();
    const items = walkItems(rows);
    if (!items.length) return false; // no cards = no walk (see walkItems)
    const active = document.activeElement;
    const card = active && active.closest ? active.closest('.row') : null;
    let i = card ? rows.indexOf(card) : -1;
    // Not in a card, but on (or inside) the footer button: the walk's last item.
    // `items` is longer than `rows` exactly when one is rendered.
    const last = items[items.length - 1];
    if (i === -1 && items.length > rows.length && active && last.contains(active)) {
      i = items.length - 1;
    }
    if (i === -1) {
      // Entering the list from OUTSIDE it: always the remembered CARD, never
      // index 0 blindly and never the footer button. A page key entering the
      // list is still an ENTRY — there is no "from" to page away from yet.
      rememberedCard(rows).focus();
      return true;
    }
    const step = page ? QUEUE_PAGE_STEP : 1;
    const next = Math.min(items.length - 1, Math.max(0, i + dir * step));
    // ONE focus() for both keys: the scroll is the browser's "nearest", which
    // leaves an on-screen destination alone and otherwise brings it just into
    // view. `.row`'s scroll-margin-top is what keeps a top-edge landing clear of
    // the sticky .queue-header.
    items[next].focus();
    return next !== i; // clamped: focus placed, key NOT taken — see above
  }

  /**
   * Home / End: focus one END of the walk — dir -1 = the first item, +1 = the
   * last — and report whether the key was HANDLED, on moveCard's contract (the
   * caller preventDefaults on true and only on true).
   *
   * ABSOLUTE where moveCard's keys are relative, so there is no position to step
   * from and nothing to clamp. An ordinary focus() (no preventScroll and no
   * explicit block here, deliberately) lets the scroll follow, which for the
   * first and last items is the top and the bottom of the pane anyway. End lands
   * on "Show all (N)" when one is rendered — the walk's last item, exactly where
   * ArrowDown off the last card goes. An EMPTY list returns false and touches
   * nothing, so the keys keep their native meaning on a page with no queue.
   * @param {number} dir
   * @returns {boolean}
   */
  function focusEdge(dir) {
    if (!walkApplies()) return false;
    const items = walkItems();
    if (!items.length) return false;
    (dir < 0 ? items[0] : items[items.length - 1]).focus();
    return true;
  }

  /**
   * How many cards are rendered right now. For the one caller that compares the
   * list ACROSS a re-render — "Show all (N)", which reveals the cards after this
   * count — so the counting rule (.row, this list) stays here with cards()
   * rather than being written out again on each page.
   * @returns {number}
   */
  function cardCount() {
    return cards().length;
  }

  /**
   * Put focus on the card at `index`, falling back to the LAST card and then the
   * first; a list with no cards leaves focus alone rather than blurring to
   * <body>. The fallbacks are not decoration: the index is always measured
   * against a list that has since been re-rendered, so it can legitimately be
   * past the end, or the list can be empty.
   * @param {number} index
   * @returns {Element|null} the card focused, or null when there was none
   */
  function focusCardAt(index) {
    const rows = cards();
    if (!rows.length) return null;
    const target = rows[index] || rows[rows.length - 1] || rows[0];
    target.focus();
    return target;
  }

  /**
   * Is `el` at least partly within the scrollport the user is reading through?
   * ONE expression for both layouts: wide, the queue pane clips; stacked, the
   * pane is `overflow: visible` and the VIEWPORT clips. Intersecting the two
   * gives the visible band either way, with no branch on the media query.
   */
  function inView(el) {
    const pane = queuePane ? queuePane.getBoundingClientRect() : null;
    const top = pane ? Math.max(pane.top, 0) : 0;
    const bottom = pane ? Math.min(pane.bottom, window.innerHeight) : window.innerHeight;
    const r = el.getBoundingClientRect();
    return r.bottom > top && r.top < bottom;
  }

  /**
   * WHICH ELEMENT SCROLLS THE QUEUE — asked here and nowhere else, because the
   * answer changes with the layout: the pane wide, the DOCUMENT stacked, where
   * `.workspace__queue` is `overflow: visible` and its scrollTop is permanently
   * 0. Read the wrong one and the save returns 0 and the restore does nothing.
   * By media query, following initCurtain, never by measuring.
   */
  function queueScrollTop() {
    if (window.matchMedia(narrowQuery).matches) return window.scrollY;
    return queuePane ? queuePane.scrollTop : 0;
  }

  /** Move that same scroller to `top`. Over-scroll clamps on its own. */
  function setQueueScrollTop(top) {
    if (window.matchMedia(narrowQuery).matches) window.scrollTo(0, top);
    else if (queuePane) queuePane.scrollTop = top;
  }

  /**
   * Take the queue's scroll offset now and hand back a function that puts it
   * back — for a re-render that keeps the same cards, where an absolute restore
   * is exact (stash-page.js's renderKeepingPlace). Captured as a closure so the
   * caller never has to know which element it came from, and so the layout is
   * settled once: a window resized between the two halves is not a case worth a
   * branch, and re-asking would restore the wrong scroller.
   * @returns {() => void}
   */
  function captureQueueScroll() {
    const top = queueScrollTop();
    return () => setQueueScrollTop(top);
  }

  /**
   * The videoId of the card the user's PLACE is at — what a re-render that
   * changes the list's membership has to preserve. First hit wins:
   *   1. the card containing focus;
   *   2. the remembered card, IF it is on screen;
   *   3. the first card at least partly on screen;
   *   4. the remembered card;
   *   5. the first card.
   *
   * 2 before 3 because the gesture this exists for is a toolbar button: a press
   * moves focus to the BUTTON, so 1 rarely fires, and the card the user was
   * arrowing on is a truer answer than whatever happens to be topmost.
   * @returns {string|null} null only when there are no cards at all
   */
  function anchorId() {
    const rows = cards();
    if (!rows.length) return null;
    const active = document.activeElement;
    const focused = active && active.closest ? active.closest('.row') : null;
    if (focused && queueList && queueList.contains(focused)) return focused.dataset.videoId || null;
    const remembered = rememberedId ? rows.find((r) => r.dataset.videoId === rememberedId) : null;
    if (remembered && inView(remembered)) return rememberedId;
    const visible = rows.find(inView);
    if (visible) return visible.dataset.videoId || null;
    return (remembered && rememberedId) || rows[0].dataset.videoId || null;
  }

  /**
   * Run `rerender` and KEEP THE USER'S PLACE across it — for a re-render that
   * changes which records are rendered at all (the Hide-skipped toggle), where
   * the anchor itself can be one of the cards going into hiding.
   *
   * Restores THE SCROLL, THE WALK CURSOR, AND FOCUS — the last one only when
   * focus was inside the list, which is exactly when the rebuild destroyed it.
   * That gate is what protects the caller whose own control holds focus (the
   * Hide-skipped toggle, which must keep it or toggling straight back would be
   * impossible): its button is not in the list, so nothing here touches it. The
   * protection is structural rather than a blanket refusal, which is why every
   * caller can share one gesture — a re-render that forgets to put focus back
   * is the defect this had at four call sites.
   *
   * One anchor drives all three, so the pane, the next arrow press and the
   * pane cycle can never disagree about where the user is.
   *
   * The scroll is restored as a DELTA in viewport coordinates — put the
   * surviving card back at the screen y the anchor occupied — not as a raw
   * scrollTop, which means a different card once the list's length changes. That
   * also makes it layout-agnostic apart from naming the scroller: the document
   * stacked, the pane wide. Over-scroll clamps on its own.
   *
   * NOT stash-page.js's renderKeepingPlace, which restores an absolute scrollTop
   * and re-focuses the same control: that is exact for a cross-tab reconcile,
   * where membership only grows so the anchor cannot vanish and focus never left
   * the list. Keep the two separate.
   * @param {() => void} rerender the page's own render, called exactly once
   * @returns {Element|null} the card focus was restored to, or null — focus was
   *   not in the list, or no card is left to hold it. A caller whose own control
   *   disables itself tells those apart by its own gate, not by this.
   */
  function renderKeepingAnchor(rerender) {
    const rowsBefore = cards();
    const beforeIds = rowsBefore.map((c) => c.dataset.videoId);
    const id = anchorId();
    const before = id ? rowsBefore.find((c) => c.dataset.videoId === id) : null;
    const anchorTop = before ? before.getBoundingClientRect().top : null;
    // Read BEFORE the rerender: renderQueue empties the <ul>, so by the time we
    // could ask, focus has already fallen to <body> and the answer is lost.
    const heldFocus = !!(queueList && queueList.contains(document.activeElement));
    rerender();
    const after = cards();
    const survivor = nearestSurvivor(beforeIds, id, after.map((c) => c.dataset.videoId));
    const target = survivor ? after.find((c) => c.dataset.videoId === survivor) : null;
    if (target) {
      rememberedId = survivor;
      if (anchorTop != null) {
        const delta = target.getBoundingClientRect().top - anchorTop;
        if (delta) setQueueScrollTop(queueScrollTop() + delta);
      }
    }
    // Last, so the scroll it must not disturb is already settled. Not gated on
    // `target`: with nothing recognisable left (a refresh can replace the whole
    // window) rememberedCard falls back to the first card, which still beats
    // <body>.
    return heldFocus ? focusRemembered() : null;
  }

  /**
   * Focus the card the walk would resume at. Two callers, for two different
   * reasons: renderKeepingAnchor uses it to put back focus the rebuild
   * destroyed, and Clean up / Trim front call it directly because their own
   * button disables itself under the user's focus and so cannot keep it —
   * a case no re-render can detect, since the button is not in the list.
   *
   * preventScroll BY DEFAULT because both of those callers have just restored
   * the scroll themselves and focus() scrolls the card into view, which would
   * fight it — the same reason stash-page.js's renderKeepingPlace passes it.
   * The pane cycle is the one caller that turns it off: arriving from another
   * pane there is no scroll to protect, and a remembered card off screen has to
   * be brought to it.
   * @param {object} [opts]
   * @param {boolean} [opts.preventScroll] false = let the focus scroll the card
   *   into view, for a caller that has NOT just positioned the list itself
   * @returns {Element|null} the card focused, or null when the list is empty,
   *   which is the caller's cue to fall back to a control of its own
   */
  function focusRemembered({ preventScroll = true } = {}) {
    const target = rememberedCard(cards());
    if (target) target.focus({ preventScroll });
    return target;
  }

  return {
    moveCard,
    focusEdge,
    cardCount,
    focusCardAt,
    rememberCard,
    renderKeepingAnchor,
    focusRemembered,
    captureQueueScroll,
  };
}

// ---------------------------------------------------------------------------
// Single-column list walk
//
// THE SECOND WALK, for a page whose list is not the queue: one column of rows,
// each a tab stop, stepped by the same six keys on the same contract.
//
// initQueueFocus above deliberately does NOT serve it, and is not made to. That
// one is built around .row cards, a videoId identity, the "Show all (N)" footer
// item, the card menu's arrow pre-step and a place anchor for re-renders that
// change which records exist — none of which a page that builds its list once
// and updates rows IN PLACE has anything for. Threading six more parameters
// through the app's most load-bearing keyboard function, to reach roughly a
// third of it, would put the queue's walk at risk to save this much code.
//
// Nor is the reverse wanted — initQueueFocus composing these primitives and
// layering its extras back on top. It is the tidier shape on paper, and it buys
// this page nothing: the cost is reworking the app's most load-bearing keyboard
// path, which every card gesture on both player pages runs through, to serve a
// settings screen visited occasionally.
//
// What is genuinely shared stays shared: the step contract (clamp, never wrap;
// a clamp still moves focus but reports NOT-handled, handing the scroll back)
// and QUEUE_PAGE_STEP, so the two walks cannot drift on how far a page key goes.
// ---------------------------------------------------------------------------

/**
 * Wire up the walk along a single-column list of focusable rows and hand back
 * the gestures its keydown table needs. Installs two listeners on `list` — a
 * `focusin` keeping the remembered row up to date and a `pointerdown` marking a
 * placement — and binds no keys of its own, like everything else here.
 *
 * IT NAMES NOTHING ITSELF: the row selector, the identity key and the ring class
 * are all parameters, following initPaneNav's discipline rather than
 * initQueueFocus's baked-in `.row`.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.list the container the rows live in.
 * @param {string} opts.itemSelector selector for one row. Resolved with
 *   closest() as well as querySelectorAll, so a row still answers while focus
 *   sits on a control inside it.
 * @param {string} opts.idKey the `dataset` key carrying a row's stable identity.
 *   The cursor is remembered by that id, never by element.
 * @param {string} [opts.pointedClass] class marking the row a POINTER press
 *   placed the cursor on — half of what the stylesheet draws the ring on, the
 *   other half being :focus-visible. Omit it and a pointer placement never rings.
 * @param {number} [opts.pageStep] rows one PageUp/PageDown covers.
 * @returns {{moveItem: (dir:number, opts?:{page?:boolean}) => boolean,
 *   focusEdge: (dir:number) => boolean,
 *   focusRemembered: (opts?:{preventScroll?:boolean}) => Element|null}}
 */
export function initListWalk({
  list,
  itemSelector,
  idKey,
  pointedClass,
  pageStep = QUEUE_PAGE_STEP,
} = {}) {
  // The id of the row the walk resumes at — an id, never a node. focusin is its
  // ONLY writer here: unlike the queue there is no move that changes the user's
  // place while focus is elsewhere, so there is no rememberCard counterpart.
  let rememberedId = null;

  // The row a POINTER press placed the cursor on. Same reason as the queue's
  // row--pointed: the ring cannot be a plain :focus, or the pane cycle landing
  // here would ring a row after a keystroke aimed at another region entirely.
  let pointedRow = null;

  const rowOf = (node) => (node && node.closest ? node.closest(itemSelector) : null);
  const mark = (row) => row && pointedClass && row.classList.add(pointedClass);
  const unmark = (row) => row && pointedClass && row.classList.remove(pointedClass);

  if (list) {
    // pointerdown, not click: the mark has to be set BEFORE focus moves. A press
    // landing on a control inside the row is an ACTION, not a placement, so it
    // does not mark — those take focus themselves and the focusin below would
    // clear the mark anyway. What it is load-bearing for is a press on the row's
    // own body, which focuses the row itself and must ring.
    list.addEventListener('pointerdown', (e) => {
      const row = rowOf(e.target);
      const control = e.target && e.target.closest ? e.target.closest('a, button') : null;
      const placed = control && row && row.contains(control) ? null : row;
      if (pointedRow !== placed) unmark(pointedRow);
      pointedRow = placed;
      mark(placed);
    });

    // focusin (not focus) because it BUBBLES: the note must be taken whether
    // focus landed on the row itself or on a link or button inside it — the same
    // closest() rule the per-row keys resolve by.
    list.addEventListener('focusin', (e) => {
      const row = rowOf(e.target);
      const id = row && row.dataset ? row.dataset[idKey] : null;
      if (id) rememberedId = id;
      // The mark survives only while focus is on the marked row ITSELF, and is
      // retired the moment focus moves anywhere else — the next row, or a
      // control reached inside this one.
      if (pointedRow && e.target !== pointedRow) {
        unmark(pointedRow);
        pointedRow = null;
      }
    });
  }

  /** This list's rows, in DOM order. Re-queried every time, never cached. */
  function rows() {
    return list ? Array.from(list.querySelectorAll(itemSelector)) : [];
  }

  /**
   * The row to resume at: the remembered id if it is still rendered, else the
   * first row, else null (an empty list). Matched by comparing the dataset value
   * rather than through an attribute selector, so an id needs no escaping.
   */
  function rememberedRow(items) {
    if (rememberedId) {
      for (const row of items) {
        if (row.dataset[idKey] === rememberedId) return row;
      }
    }
    return items[0] || null;
  }

  /**
   * Does the walk apply to the key being handled right now? THE ONE GATE — every
   * move asks it, so there is one answer.
   *
   * ANYWHERE ON THE PAGE — <body> after a fresh load, the nav strip, inside the
   * list alike — so the arrows walk the moment the page opens, with no pane
   * switch to discover first. It is initQueueFocus's rule, not a looser one:
   * that gate declines only inside the PLAYER pane, the one region with a
   * native scroll of its own to protect. A single-column page has no such
   * region, so nothing is carved out and a press from outside ENTERS the list
   * (see moveItem).
   *
   * The one decline is an EMPTY list: with nothing to walk, every one of these
   * keys keeps its native document scrolling and its native meaning.
   * @returns {boolean} false = decline the key entirely, changing nothing
   */
  function walkApplies() {
    return Boolean(list) && rows().length > 0;
  }

  /**
   * Step focus along the list in `dir` (-1 = up/previous, +1 = down/next) and
   * report whether the key was HANDLED — the caller preventDefaults on true and
   * only on true, so everything this declines keeps its native scrolling.
   *
   * ONE FUNCTION FOR BOTH RELATIVE KEYS: the arrows step 1, PageUp/PageDown pass
   * `{ page: true }` and step `pageStep`. The step SIZE is all that differs —
   * both scroll by a plain focus(), so a destination already on screen is not
   * scrolled to at all — and both ends CLAMP rather than wrap, the clamp still
   * placing focus while reporting NOT-handled so the document gets its native
   * scroll back there. See moveCard: they are the same decisions.
   *
   * ENTERING FROM OUTSIDE THE LIST lands on the remembered row — the first until
   * the user has been in the list — in EITHER direction, and takes the key. A
   * page key entering is still an entry, with no "from" to page away from yet,
   * so it lands in the same place a single step would. moveCard's rule exactly.
   * @param {number} dir
   * @param {object} [opts]
   * @param {boolean} [opts.page] true = one page key's worth of rows instead of
   *   a single step. Nothing else about the move differs.
   * @returns {boolean} true only when focus moved to a DIFFERENT row
   */
  function moveItem(dir, { page = false } = {}) {
    if (!walkApplies()) return false;
    const items = rows();
    const i = items.indexOf(rowOf(document.activeElement));
    if (i === -1) {
      // Outside the list, or in it but not on a row: an ENTRY, not a step. The
      // gate guarantees a row to land on, so this always takes the key.
      rememberedRow(items).focus();
      return true;
    }
    const step = page ? pageStep : 1;
    const next = Math.min(items.length - 1, Math.max(0, i + dir * step));
    // ONE focus() for both keys — see moveCard. Nothing here overrides the
    // browser's "nearest", so a row already on screen is focused where it sits.
    items[next].focus();
    return next !== i; // clamped: focus placed, key NOT taken — see above
  }

  /**
   * Home / End: focus one END of the list — dir -1 = the first row, +1 = the
   * last — on moveItem's took-the-key contract.
   *
   * ABSOLUTE where moveItem's keys are relative, so there is no position to step
   * from, nothing to clamp, and no entry rule to need: naming an end answers
   * "from outside the list" already. An ordinary focus() lets the scroll follow,
   * which for the first and last rows is the top and the bottom of the document
   * anyway. An EMPTY list declines at the gate, keeping the keys' native meaning.
   * @param {number} dir
   * @returns {boolean}
   */
  function focusEdge(dir) {
    if (!walkApplies()) return false;
    const items = rows();
    (dir < 0 ? items[0] : items[items.length - 1]).focus();
    return true;
  }

  /**
   * Focus the row the walk would resume at. ONE caller today, the pane cycle's
   * landing on this list, which is exactly why it exists: the moment a row
   * becomes focusable, initPaneNav's default landing (the first focusable
   * DESCENDANT) silently changes from the first row's link to the first row, and
   * either way it restarts at the top instead of resuming where the user was.
   *
   * preventScroll defaults to true, matching initQueueFocus, for a caller that
   * has just positioned the list itself; the pane cycle turns it off, having no
   * scroll of its own to protect and a possibly off-screen row to bring into view.
   * @param {object} [opts]
   * @param {boolean} [opts.preventScroll]
   * @returns {Element|null} the row focused, or null when the list is empty —
   *   the pane cycle's cue to skip this pane
   */
  function focusRemembered({ preventScroll = true } = {}) {
    const target = rememberedRow(rows());
    if (target) target.focus({ preventScroll });
    return target;
  }

  return { moveItem, focusEdge, focusRemembered };
}

// ---------------------------------------------------------------------------
// Pane navigation
//
// A CYCLE of the page's regions — the nav strip, the toolbar, the queue actions,
// the queue, the player (and the stash's add form) — stepped by [ and ] and
// wrapping at both ends, plus / as the one absolute jump between the two big
// panes. It is the keyboard's answer to a queue long enough that tabbing out of
// it is not a gesture anyone will make twice.
//
// WHAT A PANE IS is entirely the page's business: an ordered array of
// descriptors, each naming its container and, where the default is wrong, how it
// takes focus. This module never names a selector, so a new region is one entry
// in one array and nothing here changes. Panes are DISJOINT — never nested in
// one another — which is what lets el.contains(activeElement) decide the origin
// with no innermost-wins rule to get wrong.
//
// THE LANDING IS A CONTROL, not a container, everywhere but the player: a region
// focused as a whole is a tab stop the user then has to escape, and focusFirst
// already skips the hidden and the disabled by verifying activeElement. The
// player is the exception because being focusable AS A PANE is the entire point
// — it scrolls natively, and a long description is otherwise unreachable; it
// carries tabindex="0" and takes the escape cost deliberately. The queue lands
// on the remembered card, so arriving resumes the walk where it left off rather
// than at card 1.
//
// A PANE THAT CANNOT TAKE FOCUS IS SKIPPED, the step continuing in the same
// direction (paneCandidates in queue.js supplies the order). Not tidiness: a
// fresh stash has BOTH its queue-action buttons disabled at once, and an empty
// queue has no card to land on, so without the skip the key would die against a
// region the user cannot see is unreachable.
//
// THE ORIGIN FALLS BACK TO THE LAST PANE FOCUS WAS IN, because focus is on
// <body> constantly — bindIframeFocusGuard puts it there on every click of the
// video. Reading that as "the queue" would send [ backwards PAST the queue to
// the queue actions right after a click on the player, the one moment the user
// is unambiguously standing in the player. Same principle as the remembered
// card: focus landing outside every pane leaves the note standing.
// ---------------------------------------------------------------------------

/** Everything inside `el` that could plausibly take focus, in DOM order. */
function paneFocusables(el) {
  return Array.from(
    el.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  );
}

/**
 * Wire up pane-to-pane focus movement for one page and hand back the two
 * gestures its keydown table calls. Installs exactly one listener — a document
 * `focusin`, which is how the fallback origin is kept up to date — and binds no
 * keys of its own, like everything else in this module.
 *
 * @param {object} opts
 * @param {Array<{el:HTMLElement|null, focus?:() => Element|null, role?:string}>} opts.panes
 *   the page's regions IN DOM ORDER. `el` is the container; an entry whose `el`
 *   is missing is dropped, so a page may hand over a selector that found
 *   nothing. `focus` defaults to the first focusable descendant that will
 *   actually take it — override it only where that is wrong (the queue, which
 *   resumes at the remembered card, and the player and the stash's add form,
 *   which are focused WHOLE; note paneFocusables is a querySelectorAll and so
 *   never matches `el` itself, which is why those two need the override at all)
 *   — and MUST report what it landed on, or null, since that is what "skip this
 *   pane" is decided by. `role` is read by togglePane alone: exactly one
 *   'queue' and one 'player', or / is inert (channels.html has neither).
 * @returns {{movePane: (dir:number) => boolean, togglePane: () => boolean}}
 */
export function initPaneNav({ panes = [] } = {}) {
  const cycle = (Array.isArray(panes) ? panes : []).filter((p) => p && p.el);
  const roleAt = (role) => cycle.findIndex((p) => p.role === role);
  const queueAt = roleAt('queue');
  const playerAt = roleAt('player');

  // Where a step starts from when focus is not in any pane — see the banner. The
  // queue is the honest default: it is the page, and it is where a fresh load's
  // <body> focus conceptually sits.
  let lastPaneIndex = queueAt >= 0 ? queueAt : 0;

  /** The index of the pane containing `node`, or -1. */
  function paneOf(node) {
    if (!node) return -1;
    return cycle.findIndex((p) => p.el.contains(node));
  }

  // focusin (not focus) because it BUBBLES: the note has to be taken wherever
  // inside a pane focus landed. Written only on a hit — focus outside every pane
  // (the skip link, <body> itself) leaves the previous note standing, because
  // the note answers "which pane was the user last in", and those are not panes.
  document.addEventListener('focusin', (e) => {
    const i = paneOf(e.target);
    if (i >= 0) lastPaneIndex = i;
  });

  /** The pane a step starts from: where focus actually is, else the note. */
  function originIndex() {
    const at = paneOf(document.activeElement);
    return at >= 0 ? at : lastPaneIndex;
  }

  /**
   * Try to put focus in pane `i`, and report what took it. The note moves only
   * on success, so a failed landing never leaves the fallback pointing at a pane
   * the user was never in.
   */
  function enterPane(i) {
    const pane = cycle[i];
    if (!pane) return null;
    const landed = pane.focus ? pane.focus() : focusFirst(...paneFocusables(pane.el));
    if (landed) lastPaneIndex = i;
    return landed;
  }

  /**
   * Step to the next pane in `dir` (-1 = previous, +1 = next), skipping any that
   * cannot take focus, and report whether the key was HANDLED — the caller
   * preventDefaults on true and only on true, on moveCard's contract.
   *
   * NOT gated by walkApplies: pane navigation is the one move that has to work at
   * every width and from inside the player, since leaving the player is exactly
   * what it is for.
   * @param {number} dir
   * @returns {boolean}
   */
  function movePane(dir) {
    for (const i of paneCandidates(cycle.length, originIndex(), dir)) {
      if (enterPane(i)) return true;
    }
    return false;
  }

  /**
   * The absolute jump between the two big panes, with THE QUEUE AS HOME: from
   * the queue into the player, from anywhere else (the player, any of the small
   * panes, or the <body> fallback) back to the remembered card. At every width;
   * the player pane is otherwise unreachable without tabbing through every
   * control of every card, stacked as well as side by side.
   *
   * A page with no queue or no player pane declines outright, which is the whole
   * reason channels.html can share this module and still have no / key. With no
   * cards at all, leaving the player does NOTHING and focus stays put: there is
   * no honest target, and blurring to <body> would be a silent loss.
   * @returns {boolean} whether focus moved
   */
  function togglePane() {
    if (queueAt < 0 || playerAt < 0) return false;
    return Boolean(enterPane(originIndex() === queueAt ? playerAt : queueAt));
  }

  return { movePane, togglePane };
}
