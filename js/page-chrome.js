// js/page-chrome.js
//
// Leaf page chrome shared by every entry point — the single-tab lock, the
// fatal-storage halt screens, the privacy curtain, and the two-pane focus
// navigation both player pages drive from their arrow keys. No app state and no
// queue logic: it imports only ui.js, toast.js and the two error classes from
// store.js, and is never imported by queue.js/migrations.js.
//
// Everything here is per-DOCUMENT, not per-page: each export takes what varies
// (the lock name, the curtain node, the iframe getter, the two panes) as an
// argument, so a new entry point gets the same chrome without this module
// learning about it. Nothing here BINDS a key: the focus navigation, like the
// curtain's Esc, is exposed as plain functions that each page's own keydown
// table calls.

import { el, setVisible } from './ui.js';
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

// One fatal storage screen per page load — see FIRST CAUSE WINS below.
let fatalStorageErrorShown = false;

// Onboarding/app scaffolding hidden behind the overlay. Resolved by id at call
// time rather than passed in, because this module holds no `dom` map;
// setVisible() is null-tolerant, so an id a given page does not have is a
// silent no-op.
const SCAFFOLD_IDS = ['setup-panel', 'cutoff-panel', 'app-main'];

/**
 * Full-screen BLOCKING error for a FATAL storage condition: the video store is
 * unusable, so the page halts rather than run on a queue it cannot read or
 * save. Shared by the four callers below; only the copy differs. All are
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
  const overlay = document.getElementById('blocked-overlay');
  if (!overlay) {
    // Defensive: without the container, at least surface it as a toast.
    showToast(toast, { type: 'error' });
    return;
  }
  // Hide the onboarding/app scaffolding behind the overlay.
  for (const id of SCAFFOLD_IDS) setVisible(document.getElementById(id), false);

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
 */
export function showSupersededError() {
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
 *   toggle: () => void}}
 */
export function initCurtain({
  node,
  exemptSelector = '.workspace',
  narrowQuery = '(max-width: 900px)',
  coverOnWheelDown = true,
} = {}) {
  let covering = false;

  /** Reflect the covering flag onto the overlay element (class + aria). */
  function set(next) {
    covering = Boolean(next);
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

// ---------------------------------------------------------------------------
// Two-pane focus navigation
//
// Both player pages are the same two-pane workspace — a scrolling queue on the
// left, a scrolling player on the right — and both need the same three moves:
// walk the cards with ArrowUp/ArrowDown, get back INTO the list after focus has
// wandered off it, and throw focus from one pane to the other. The mechanics
// live here for one reason: the two pages' keydown tables have drifted apart
// before, and this is the part of them that has no page-specific behavior at
// all. Everything that varies — which nodes the panes are, which media query
// says "stacked" — is a parameter, and each page still writes its OWN table
// entries calling in, because this module owns no keyboard shortcut (see the
// curtain's Esc, which is bound the same way).
//
// THE REMEMBERED CARD is the whole idea. Focus leaves the card list constantly
// — onto the toolbar, onto a header button, and onto <body>, where
// bindIframeFocusGuard (above) puts it every time the user clicks the video and
// where a re-render that drops the focused card leaves it. An arrow press then
// has nowhere to resume from unless we kept a note of where the user was — so
// we keep the last-focused card's VIDEOID, not its element, because
// renderQueue() empties the <ul> and rebuilds it, and an element reference
// would be a detached node the very next render. The id is resolved against the
// CURRENT list at use time and falls back to the first card when that video is
// gone (cleaned up, filtered out, or scrolled out of the render window), which
// is also the natural answer for a first press with nothing remembered at all.
//
// This module never touches the DOM outside the two nodes it is handed.
// ---------------------------------------------------------------------------

/**
 * Wire up the queue/player focus moves for a two-pane page and hand back the
 * two gestures its keydown table needs. Installs exactly one listener — a
 * `focusin` on the queue list, which is how the remembered card is kept up to
 * date — and binds no keys of its own.
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.queueList the `<ul>` of `.row` cards. Its
 *   contents are re-created wholesale by renderQueue, so nothing is cached.
 * @param {HTMLElement|null} opts.queuePane the scrolling `.workspace__queue`
 *   around it. Only the STACKED layout consults it — there it is the region
 *   arrow navigation is confined to, which is still wider than the list: it
 *   takes in the sticky header buttons, from which a press enters the list
 *   rather than doing nothing. The two-pane layout asks about the player pane
 *   instead; see moveCard.
 * @param {HTMLElement|null} opts.playerPane the `.workspace__player` aside. It
 *   carries `tabindex="-1"` in the HTML so it can be focused programmatically
 *   without becoming a tab stop; once focused it scrolls natively, which is the
 *   only way to read a long description without tabbing through every control
 *   of every card.
 * @param {string} [opts.narrowQuery] media query for the STACKED layout, where
 *   the document scrolls rather than the panes. Same question initCurtain asks,
 *   asked the same way, for the same reason — see moveCard.
 * @returns {{moveCard: (dir:number) => boolean, togglePane: () => void}}
 */
export function initQueueFocus({ queueList, queuePane, playerPane, narrowQuery = '(max-width: 900px)' } = {}) {
  // The videoId of the last card that CONTAINED focus — an id, never a node,
  // so it survives every re-render. Null until the user has been in the list.
  let rememberedId = null;

  if (queueList) {
    // focusin (not focus) because it BUBBLES: the note must be taken whether
    // focus landed on the card itself or on ▶ Play, Skip, a speed button or a
    // card-menu item inside it — the same closest('.row') rule the card
    // shortcuts resolve by. Focus on something in the list that is NOT a card
    // (the "Show all (N)" footer button) leaves the previous note standing,
    // which is what lets an arrow press from there resume where the user was.
    queueList.addEventListener('focusin', (e) => {
      const card = e.target && e.target.closest ? e.target.closest('.row') : null;
      const id = card && card.dataset ? card.dataset.videoId : null;
      if (id) rememberedId = id;
    });
  }

  /** This list's cards, in DOM order. Re-queried every time: the <ul> is rebuilt. */
  function cards() {
    return queueList ? Array.from(queueList.querySelectorAll('.row')) : [];
  }

  /**
   * The card to resume at: the remembered videoId if it is still rendered, else
   * the first card, else null (an empty list). Matched by walking `rows` and
   * comparing dataset.videoId rather than by a [data-video-id="…"] selector —
   * the same way findCard() does on both pages — so an id needs no escaping to
   * be safe in a selector.
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
   * Move focus one card in `dir` (-1 = previous/up, +1 = next/down), and report
   * whether the key was HANDLED — the caller preventDefaults on true and only
   * on true, so everything this declines keeps its native scrolling.
   *
   * WHERE IT APPLIES IS A QUESTION ABOUT LAYOUT, not about what happens to hold
   * focus. In the two-pane layout `body.app-active` is a 100dvh flex column
   * whose panes scroll INTERNALLY: the document does not scroll at all, so
   * outside the player pane there is no native scroll for an arrow to belong
   * to, and it belongs to the queue — from the topbar, the toolbar, the stats
   * and from <body>, which is where focus keeps landing (bindIframeFocusGuard
   * puts it there on every click of the video). In the stacked (<=900px) layout
   * the queue pane is `overflow: visible` and the DOCUMENT scrolls, so there
   * very much is one, and only focus genuinely INSIDE the queue pane is taken.
   * Asked by media query rather than by measuring, following initCurtain, so
   * the breakpoint is written the same way in both places.
   *
   * CLAMPS at both ends rather than wrapping — and the clamp still places focus
   * on the .row while reporting NOT-handled. Both halves matter. Landing on the
   * .row is how the arrows get focus OUT of an open card menu: it leaves the
   * .row__menu wrapper, whose focusout dismisses it, so a menu on the first or
   * last card would have no arrow exit if the key did nothing at all there.
   * Reporting not-handled is what gives the pane its native scroll back at the
   * ends of the list, so ArrowDown on the last card still scrolls to the bottom
   * of a tall card and on to the "Show all (N)" footer. The focus() is a no-op
   * in the ordinary case (the card already had focus) and only really moves
   * anything when focus was on a control inside that card.
   * @param {number} dir
   * @returns {boolean} true only when focus moved to a DIFFERENT card
   */
  function moveCard(dir) {
    const active = document.activeElement;
    if (playerPane && active && playerPane.contains(active)) return false;
    // Stacked: the document scrolls, so take the key only inside the queue pane.
    if (window.matchMedia(narrowQuery).matches) {
      if (!(queuePane && active && queuePane.contains(active))) return false;
    }
    const rows = cards();
    if (!rows.length) return false;
    const card = active && active.closest ? active.closest('.row') : null;
    const i = card ? rows.indexOf(card) : -1;
    if (i === -1) {
      // Entering the list: from the sticky header, from "Show all (N)", from the
      // toolbar, or from nowhere at all. Always the remembered card, never index
      // 0 blindly.
      rememberedCard(rows).focus();
      return true;
    }
    const next = Math.min(rows.length - 1, Math.max(0, i + dir));
    rows[next].focus();
    return next !== i; // clamped: focus placed, key NOT taken — see above
  }

  /**
   * Throw focus between the two panes ('/'): out of the player and back to the
   * remembered card, or from anywhere else INTO the player. Works at every
   * width — the player pane is the one thing on the page that is otherwise
   * unreachable without tabbing through every control of every card, and that
   * is true stacked as well as side by side.
   *
   * With no cards at all, leaving the player does NOTHING and focus stays put:
   * there is no honest target, and blurring to <body> would be a silent loss.
   */
  function togglePane() {
    const active = document.activeElement;
    if (playerPane && active && playerPane.contains(active)) {
      const target = rememberedCard(cards());
      if (target) target.focus();
      return;
    }
    if (playerPane) playerPane.focus();
  }

  return { moveCard, togglePane };
}
