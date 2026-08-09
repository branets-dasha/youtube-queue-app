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

import { loadChannels, loadChannelPrefs, saveChannelPrefs } from './store.js';
import {
  sortChannels,
  setChannelPref,
  isChannelIgnored,
  channelPreferredRate,
} from './queue.js';
import { el, buildAvatar, setCardRate, setVisible } from './ui.js';

let prefs = {};

document.addEventListener('DOMContentLoaded', init);

function init() {
  const listEl = document.getElementById('channel-list');
  const emptyEl = document.getElementById('channels-empty');

  const channels = loadChannels();
  prefs = loadChannelPrefs();

  const sorted = sortChannels(channels);
  setVisible(listEl, sorted.length > 0);
  setVisible(emptyEl, sorted.length === 0);
  for (const ch of sorted) {
    listEl.append(buildChannelRow(ch, channels));
  }
}

/**
 * Build one channel row (<li>): avatar + title in a single anchor to the
 * channel on YouTube, then the controls — the same 1×/2× speed buttons the
 * video cards use, and an Ignore toggle. All API-derived text is set via
 * textContent (XSS-safe); the id goes through encodeURIComponent.
 * @param {{channelId:string,title:string,avatarUrl:string}} ch
 * @param {Record<string,{title:string,avatarUrl:string}>} channels
 * @returns {HTMLLIElement}
 */
function buildChannelRow(ch, channels) {
  const link = el(
    'a',
    {
      class: 'chan__link',
      href: 'https://www.youtube.com/channel/' + encodeURIComponent(ch.channelId),
      target: '_blank',
      rel: 'noopener',
    },
    [
      buildAvatar({ channelId: ch.channelId, channelTitle: ch.title }, channels, true),
      el('span', { class: 'chan__title', text: ch.title }), // safe
    ]
  );

  // Mirrors the per-video speed group on queue cards: same 1×/2× presets, same
  // classes (btn--cardrate + is-active/aria-pressed via setCardRate), same
  // toggle-off-on-active-click semantics.
  const rates = el(
    'div',
    {
      class: 'chan__rates',
      role: 'group',
      'aria-label': `Preferred speed for videos from "${ch.title}"`,
    },
    [1, 2].map((r) => {
      const label = `${r}×`;
      return el('button', {
        class: 'btn btn--cardrate',
        type: 'button',
        dataset: { rate: String(r) },
        'aria-label': `Set ${label} speed for videos from this channel`,
        'aria-pressed': 'false',
        title: `${label} preferred speed`,
        text: label,
        onclick: () => onRate(ch.channelId, r),
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
    [link, el('div', { class: 'chan__controls' }, [rates, ignoreBtn])]
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
  setCardRate(row, channelPreferredRate(prefs, channelId));
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
function onRate(channelId, rate) {
  prefs = loadChannelPrefs(); // read fresh before the write (see onToggleIgnore)
  const wasActive = channelPreferredRate(prefs, channelId) === rate;
  prefs = setChannelPref(prefs, channelId, { rate: wasActive ? undefined : rate });
  saveChannelPrefs(prefs);
  syncRow(findRow(channelId), channelId);
}
