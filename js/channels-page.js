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
import { initCurtain } from './page-chrome.js';

let prefs = {};

// Privacy curtain controls, from page-chrome.js's initCurtain(); it owns the
// covering flag, this page only wires Esc to it.
let curtain = null;

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
  document.addEventListener('keydown', onKeydown);
}

/**
 * The page's only shortcut. Esc is the PANIC key, so — matching
 * subscriptions-page.js — it is handled before any typing/modifier guard;
 * modifier combos are still left to the browser.
 * @param {KeyboardEvent} e
 */
function onKeydown(e) {
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    curtain.toggle();
  }
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

  const li = el(
    'li',
    { class: 'chan', role: 'listitem', dataset: { channelId: ch.channelId } },
    [link, el('div', { class: 'chan__controls' }, [speeds, ignoreBtn])]
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
