// js/channels-page.js
//
// Entry point for the standalone Channels page (channels.html): every known
// channel (the yqa_channels map, refreshed by the main app on each fetch)
// listed alphabetically, with per-channel prefs (yqa_channel_prefs) — an
// Ignore toggle (channel skipped entirely on future fetches) and a preferred
// speed (filled in on the videos a fetch newly adds, and on "Refresh all" over
// every stored video of that channel with no speed of its own). This page NEVER
// touches video records, calls no API and needs no auth, so it is always safe
// alongside a main-app tab; the main tab reads the prefs fresh at refresh
// time, so edits here apply to its next fetch without a reload.

import { migrateLocalStorage } from './migrations.js';
import { loadChannels, loadChannelPrefs, saveChannelPrefs } from './store.js';
import {
  sortChannels,
  setChannelPref,
  isChannelIgnored,
  channelPreferredSpeed,
} from './queue.js';
import { el, buildAvatar, setCardSpeed, setVisible } from './ui.js';
import { focusFirst, initCurtain, initListWalk, initPaneNav } from './page-chrome.js';

let prefs = {};

// Privacy curtain controls, from page-chrome.js's initCurtain(); it owns the
// covering flag, this page only wires Esc to it.
let curtain = null;

// Pane-to-pane focus movement, from page-chrome.js's initPaneNav(). Two panes
// here and NEITHER role, so [ and ] work and '/' is inert — this page has no
// queue and no player for it to jump between.
let paneNav = null;

// The channel list's arrow walk, from page-chrome.js's initListWalk(). Not the
// queue's initQueueFocus: that one is built around video cards, a windowing
// footer, the card menu and re-renders that change which records exist, none of
// which this page has (see the banner over initListWalk).
let walk = null;

// Digit -> preferred speed for the FOCUSED row, the same three presets and the
// same mnemonic as the queue's CARD_SPEED_KEYS ('5' is "point-five" for 1.5×, so
// an explicit table rather than Number(key)). A Map, so a stray key name can
// never resolve to an inherited Object property.
const CHANNEL_SPEED_KEYS = new Map([
  ['1', 1],
  ['5', 1.5],
  ['2', 2],
]);

document.addEventListener('DOMContentLoaded', init);

function init() {
  // This page never boots subscriptions-page.js, so it runs the one-shot
  // storage migrations itself — otherwise it would render prefs straight off
  // disk in a stale shape.
  migrateLocalStorage();

  const listEl = document.getElementById('channel-list');
  const emptyEl = document.getElementById('channels-empty');

  const channels = loadChannels();
  prefs = loadChannelPrefs();

  const sorted = sortChannels(channels);
  setVisible(listEl, sorted.length > 0);
  setVisible(emptyEl, sorted.length === 0);
  for (const ch of sorted) {
    listEl.append(buildChannelRow(ch));
  }

  // coverOnWheelDown: false is DELIBERATE — do not "fix" this into consistency
  // with index.html. This page's <body> has no `app-active` class, so it is not
  // a 100dvh flex column: the whole DOCUMENT scrolls at every width. If a
  // wheel-down covered here you could never scroll the channel list. Wheel-up
  // still lifts and Esc still toggles — the same rule the ≤900px breakpoint
  // already encodes on index.html, stated by layout instead of by width.
  curtain = initCurtain({
    node: document.getElementById('curtain'),
    exemptSelector: '.channels-main',
    coverOnWheelDown: false,
  });

  // The channel walk: ↑/↓ by one row, PageUp/PageDown by QUEUE_PAGE_STEP, and
  // Home/End to the ends — the queue's six keys over this page's one column.
  // Rows carry tabindex="0" (see buildChannelRow), so they are the stops the
  // walk moves between and the tab stop their own controls follow.
  walk = initListWalk({
    list: listEl,
    itemSelector: '.chan',
    idKey: 'channelId',
    pointedClass: 'chan--pointed',
  });

  // The pane cycle, IN DOM ORDER: the nav strip and the channel list. The nav
  // takes the default landing (its first link); the LIST cannot, and this is not
  // cosmetic — now that a row is focusable, paneFocusables matches the <li>
  // itself, which precedes its own link in DOM order, so the default landing
  // silently moved from the first channel's link to the first row and either way
  // restarts at the top. focusRemembered resumes at the row the user left, and
  // reports what it landed on, which is what "skip this pane" is decided by.
  paneNav = initPaneNav({
    panes: [
      { el: document.querySelector('.topbar__nav') },
      { el: listEl, focus: () => walk.focusRemembered({ preventScroll: false }) },
    ],
  });

  // The skip link does NOT navigate its fragment, for the two reasons the queue's
  // does not either: the navigation would scroll the list into view on its own,
  // nudging a page already at the top, and landing on an invisible container
  // reads as nothing having happened for what is a keyboard gesture. focusEdge
  // is "the first row" — it rings on arrival, :focus-visible propagating from the
  // keyboard-focused link. It declines on an EMPTY list, where the <ul> is
  // genuinely `hidden` and focusing it would be a silent no-op, so the ladder
  // falls to the empty state, which is what actually occupies the region;
  // focusFirst verifies each candidate really took focus, so the <ul> behind it
  // costs nothing and stays the tail.
  const skipToList = document.querySelector('.skip-link[href="#channel-list"]');
  if (skipToList) {
    skipToList.addEventListener('click', (e) => {
      e.preventDefault();
      if (!(walk && walk.focusEdge(-1))) focusFirst(emptyEl, listEl);
    });
  }

  document.addEventListener('keydown', onKeydown);
}

/**
 * This page's keydown table — the same shape as the two player pages', with the
 * gestures it has no counterpart for left out. Esc is the PANIC key, so it is
 * handled BEFORE any typing/modifier guard; modifier combos are still left to
 * the browser. There is no `appMain` here to gate on: this page has no
 * onboarding to be inert throughout.
 * @param {KeyboardEvent} e
 */
function onKeydown(e) {
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    curtain.toggle();
    return;
  }
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const key = e.key.toLowerCase();
  if (key === 'arrowup' || key === 'arrowdown') {
    // ↑/↓ walk the channel rows. The whole rule lives in page-chrome's moveItem
    // — what it walks, the clamp at both ends, and the entry from outside that
    // makes the list walkable straight off a fresh load, with focus still on
    // <body> — and it reports whether it TOOK the key. preventDefault ONLY on
    // true, so everything it declines keeps its native scrolling: a clamp at
    // either end, and every key on a page with no channels at all.
    if (walk && walk.moveItem(key === 'arrowup' ? -1 : 1)) e.preventDefault();
  } else if (key === 'pageup' || key === 'pagedown') {
    // The SAME move as ↑/↓, only further: moveItem steps QUEUE_PAGE_STEP rows
    // instead of one. The step size is the only difference — the scroll is the
    // browser's own either way, so with many rows on screen a page jump often
    // moves focus without scrolling at all. Same took-the-key contract, so a
    // clamp at either end reports false and native scrolling finishes the job,
    // and the same entry rule, a press from outside the list landing on the
    // remembered row rather than paging from nowhere.
    if (walk && walk.moveItem(key === 'pageup' ? -1 : 1, { page: true })) e.preventDefault();
  } else if (key === 'home' || key === 'end') {
    // ABSOLUTE keys: the first / last ROW, named rather than stepped to, from
    // anywhere on the page. Only an empty list declines, leaving Home/End their
    // native meaning.
    if (walk && walk.focusEdge(key === 'home' ? -1 : 1)) e.preventDefault();
  } else if (key === '[' || key === ']') {
    // [ / ] step the pane cycle — here just the nav strip and the channel list.
    // page-chrome's movePane owns the wrap, the skip past a pane that cannot
    // take focus and the fallback to the last pane focus was in, and reports
    // whether it took the key; neither bracket has a native action to preserve.
    if (paneNav && paneNav.movePane(key === '[' ? -1 : 1)) e.preventDefault();
  } else if (key === 'x') {
    // x = Ignore, this page's counterpart to the queue's skip — both mean "keep
    // this out of the queue", and both toggle. Focus does NOT move: an ignored
    // channel greys in place and is never removed, so there is nothing to rescue.
    const channelId = focusedChannelId();
    if (channelId) {
      e.preventDefault();
      onToggleIgnore(channelId);
    }
  } else if (CHANNEL_SPEED_KEYS.has(key)) {
    // 1 / 5 / 2 = the same three presets the cards use, routed through the same
    // handler the speed buttons call — so pressing the one already active clears
    // the pref, exactly as clicking it does. No focus move, like the card keys.
    const channelId = focusedChannelId();
    if (channelId) {
      e.preventDefault();
      onSpeed(channelId, CHANNEL_SPEED_KEYS.get(key));
    }
  }
}

/**
 * The channelId of the row that CONTAINS focus, or null when focus is outside
 * the list altogether. Resolved by closest('.chan') rather than an exact match,
 * which is what keeps the per-row keys alive while focus sits on a control
 * INSIDE a row — the channel link, a speed button, Ignore.
 * @returns {string|null}
 */
function focusedChannelId() {
  const active = document.activeElement;
  const row = active && active.closest ? active.closest('.chan') : null;
  return (row && row.dataset.channelId) || null;
}

/**
 * Build one channel row (<li>): avatar + title in a single anchor to the
 * channel on YouTube, then the controls — the same 1× / 1.5× / 2× speed buttons
 * the video cards use, and an Ignore toggle. All API-derived text is set via
 * textContent (XSS-safe); the id goes through encodeURIComponent.
 *
 * This page has no video records and needs none: sortChannels already hands us
 * the title and avatarUrl, which is exactly what buildAvatar wants, so the
 * channel IS the display info — no lookup, and no video record to fake.
 * @param {{channelId:string,title:string,avatarUrl:string}} ch
 * @returns {HTMLLIElement}
 */
function buildChannelRow(ch) {
  const link = el(
    'a',
    {
      class: 'chan__link',
      href: 'https://www.youtube.com/channel/' + encodeURIComponent(ch.channelId),
      target: '_blank',
      rel: 'noopener',
    },
    [
      buildAvatar({ title: ch.title, avatarUrl: ch.avatarUrl }),
      el('span', { class: 'chan__title', text: ch.title }), // safe
    ]
  );

  // Mirrors the per-video speed group on queue cards: same 1× / 1.5× / 2×
  // presets, same classes (btn--cardspeed + is-active/aria-pressed via
  // setCardSpeed), same toggle-off-on-active-click semantics.
  const speeds = el(
    'div',
    {
      class: 'chan__speeds',
      role: 'group',
      'aria-label': `Preferred speed for videos from "${ch.title}"`,
    },
    [1, 1.5, 2].map((r) => {
      const label = `${r}×`;
      return el('button', {
        class: 'btn btn--cardspeed',
        type: 'button',
        dataset: { speed: String(r) },
        'aria-label': `Set ${label} speed for videos from this channel`,
        'aria-pressed': 'false',
        title: `${label} preferred speed`,
        text: label,
        onclick: () => onSpeed(ch.channelId, r),
      });
    })
  );

  const ignoreBtn = el('button', {
    class: 'btn chan__ignore',
    type: 'button',
    'aria-label': `Ignore "${ch.title}" on future fetches`,
    'aria-pressed': 'false',
    title: 'Skip this channel on future fetches',
    text: 'Ignore',
    onclick: () => onToggleIgnore(ch.channelId),
  });

  // The card meta row's shape, for the same reason (styles.css, .row__sub): the
  // OUTER div is the flex item and the positioning context the avatar is pinned
  // to, the INNER span is the inline formatting context, and the link inside it
  // is plain inline — so its focus ring hugs the NAME instead of running out to
  // the end of the row. Two elements because a flex container blockifies its
  // children: the link has to be a grandchild to stay inline.
  const identity = el('div', { class: 'chan__identity' }, [
    el('span', { class: 'chan__identity-text' }, [link]),
  ]);

  const li = el(
    'li',
    {
      class: 'chan',
      role: 'listitem',
      // A REAL tab stop, like a queue card (ui.js) and like the panes: the row
      // is the cursor position x and 1/5/2 act on, and reachable by the walk but
      // not by Tab would be incoherent. Its own controls follow it in the order.
      tabindex: '0',
      dataset: { channelId: ch.channelId },
    },
    [identity, el('div', { class: 'chan__controls' }, [speeds, ignoreBtn])]
  );
  syncRow(li, ch.channelId);
  return li;
}

/** Find the rendered row (<li class="chan">) for a channelId. */
function findRow(channelId) {
  for (const row of document.querySelectorAll('.chan')) {
    if (row.dataset.channelId === channelId) return row;
  }
  return null;
}

/** Reflect the current prefs onto a row: speed buttons + ignore state, in place. */
function syncRow(row, channelId) {
  if (!row) return;
  setCardSpeed(row, channelPreferredSpeed(prefs, channelId));
  const ignored = isChannelIgnored(prefs, channelId);
  row.classList.toggle('chan--ignored', ignored);
  const btn = row.querySelector('.chan__ignore');
  if (btn) btn.setAttribute('aria-pressed', String(ignored));
}

function onToggleIgnore(channelId) {
  // Re-read before every write (same read-fresh discipline as runRefresh), so a
  // second Channels tab's edits are never clobbered by this tab's stale snapshot.
  prefs = loadChannelPrefs();
  prefs = setChannelPref(prefs, channelId, {
    ignored: !isChannelIgnored(prefs, channelId),
  });
  saveChannelPrefs(prefs);
  syncRow(findRow(channelId), channelId);
}

/** Set/toggle a channel's preferred speed: clicking the active one turns it off. */
function onSpeed(channelId, speed) {
  prefs = loadChannelPrefs(); // read fresh before the write (see onToggleIgnore)
  const wasActive = channelPreferredSpeed(prefs, channelId) === speed;
  prefs = setChannelPref(prefs, channelId, { speed: wasActive ? undefined : speed });
  saveChannelPrefs(prefs);
  syncRow(findRow(channelId), channelId);
}
