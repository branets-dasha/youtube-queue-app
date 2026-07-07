// js/ui.js
//
// Rendering helpers. STRICT XSS SAFETY: every API-derived string (video title,
// channel name, etc.) is rendered via textContent or created DOM text nodes.
// We NEVER assign API data into innerHTML. Video URLs are built with
// encodeURIComponent on the id, and thumbnails are set via img.src only.

import { STATE_WATCHED, STATE_NOT_INTERESTED } from './config.js';
import { formatDuration, isShort } from './queue.js';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an element with optional props and children.
 * @param {string} tag
 * @param {object} [props] assigned via setAttribute for attrs, or as
 *        properties for className/textContent/onclick etc.
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = value; // safe text assignment
    } else if (key === 'html') {
      // Deliberately unused for API data. Only pass trusted static strings.
      node.innerHTML = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else {
      node.setAttribute(key, value);
    }
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const child of kids) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * Absolute, locale-aware timestamp string.
 * @param {string} iso
 * @returns {string}
 */
export function formatAbsolute(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Relative time like "3 hours ago" / "in 2 days".
 * @param {string} iso
 * @param {number} [nowMs=Date.now()]
 * @returns {string}
 */
export function formatRelative(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diffMs = t - nowMs; // negative => past
  const abs = Math.abs(diffMs);
  const rtf =
    typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
      ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
      : null;

  const units = [
    ['year', 365 * 24 * 3600 * 1000],
    ['month', 30 * 24 * 3600 * 1000],
    ['week', 7 * 24 * 3600 * 1000],
    ['day', 24 * 3600 * 1000],
    ['hour', 3600 * 1000],
    ['minute', 60 * 1000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') {
      const value = Math.round(diffMs / ms);
      if (rtf) return rtf.format(value, unit);
      const n = Math.abs(value);
      return diffMs < 0 ? `${n} ${unit}${n === 1 ? '' : 's'} ago` : `in ${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Status / banner region
// ---------------------------------------------------------------------------

/**
 * Show a status message in the given container.
 * @param {HTMLElement} container
 * @param {string} message
 * @param {'info'|'error'|'success'|'progress'} [kind='info']
 */
export function showStatus(container, message, kind = 'info') {
  clear(container);
  container.className = `status status--${kind}`;
  container.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  container.append(document.createTextNode(message));
  container.hidden = false;
}

export function hideStatus(container) {
  clear(container);
  container.hidden = true;
}

// ---------------------------------------------------------------------------
// Queue rendering
// ---------------------------------------------------------------------------

/**
 * Reflect a record's state on an ALREADY-RENDERED card, in place, without
 * rebuilding it: toggle the greyed "handled" styling and mirror the taken action
 * onto the action buttons via aria-pressed (CSS paints the active button's
 * background from it). Preserves the .row element (and thus its focus), its
 * data-video-id, and child order, so the app.js focus/keyboard contract is
 * untouched — and it adds/removes nothing that affects layout, so card height is
 * identical in every state.
 * @param {HTMLElement} card the <li class="row">
 * @param {string} state 'new' | 'watched' | 'not_interested'
 */
export function setCardState(card, state) {
  if (!card) return;
  const handled = state === STATE_WATCHED || state === STATE_NOT_INTERESTED;

  card.classList.remove('row--watched', 'row--not_interested', 'row--handled');
  if (handled) {
    card.classList.add('row--handled');
    card.classList.add(state === STATE_WATCHED ? 'row--watched' : 'row--not_interested');
  }

  const watchedBtn = card.querySelector('.btn--watched');
  const notBtn = card.querySelector('.btn--not');
  if (watchedBtn) watchedBtn.setAttribute('aria-pressed', String(state === STATE_WATCHED));
  if (notBtn) notBtn.setAttribute('aria-pressed', String(state === STATE_NOT_INTERESTED));
}

/**
 * A neutral circular placeholder avatar (first letter of the channel title),
 * used when a channel has no avatar so card height stays uniform.
 * @param {string} title channel title
 * @returns {HTMLElement}
 */
function avatarPlaceholder(title) {
  const letter = ((title || '').trim().charAt(0) || '?').toUpperCase();
  return el('span', {
    class: 'row__avatar row__avatar--placeholder',
    'aria-hidden': 'true',
    text: letter, // safe text
  });
}

/**
 * Build the channel avatar for a card, looked up by channelId in the channels
 * map (decoupled from the video record, so it self-heals for already-stored
 * videos once the map is populated). Falls back to a placeholder circle.
 * img.src ONLY; alt = channel title.
 * @param {object} rec video record
 * @param {Record<string,{title:string,avatarUrl:string}>} channels
 * @returns {HTMLElement}
 */
function buildAvatar(rec, channels) {
  const ch = channels && rec.channelId ? channels[rec.channelId] : null;
  const title = rec.channelTitle || (ch && ch.title) || '';
  const avatarUrl = ch && ch.avatarUrl ? ch.avatarUrl : '';
  if (!avatarUrl) return avatarPlaceholder(title);

  const img = el('img', {
    class: 'row__avatar',
    alt: title, // channel title
    loading: 'lazy',
    width: '36',
    height: '36',
  });
  // If the avatar fails to load, swap in the placeholder so height stays uniform.
  img.onerror = () => {
    img.onerror = null;
    img.replaceWith(avatarPlaceholder(title));
  };
  img.src = avatarUrl; // img.src only
  return img;
}

/**
 * Render the player's info meta row (avatar + channel + posted date) for `rec`
 * into `container`, mirroring a card's meta row and reusing the same avatar
 * rendering + channels map. Pass rec = null to clear it. XSS-safe (textContent,
 * img.src, encodeURIComponent via buildAvatar/formatters).
 * @param {HTMLElement} container
 * @param {object|null} rec video record
 * @param {Record<string,{title:string,avatarUrl:string}>} [channels]
 */
export function renderPlayerMeta(container, rec, channels = {}) {
  if (!container) return;
  clear(container);
  if (!rec) return;
  container.append(
    buildAvatar(rec, channels),
    el('span', { class: 'row__channel', text: rec.channelTitle || '' }),
    el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
    el('time', {
      class: 'row__time-abs',
      datetime: rec.publishedAt,
      text: formatAbsolute(rec.publishedAt),
      title: rec.publishedAt,
    }),
    el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
    el('span', { class: 'row__time-rel', text: formatRelative(rec.publishedAt) })
  );
}

/**
 * Build a single queue row (<li>). All text is set safely.
 * @param {object} rec video record
 * @param {object} handlers { onWatched(id), onNotInterested(id), onPlay(id) }
 * @param {Record<string,{title:string,avatarUrl:string}>} [channels] avatar map
 * @returns {HTMLLIElement}
 */
export function buildQueueRow(rec, handlers, channels = {}) {
  const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(rec.videoId);

  const thumb = el('img', {
    class: 'row__thumb',
    alt: '',
    loading: 'lazy',
    width: '480',
    height: '270',
  });
  // Show the FULL frame with NO vertical crop: use genuinely 16:9 sources ONLY
  // (never the 4:3 hqdefault/sddefault). maxresdefault (1280x720) is sharp and
  // 16:9 but not always present — a missing maxres loads as a tiny gray 120x90
  // stub WITHOUT firing onerror, so we detect that in onload (naturalWidth < 320)
  // and swap to mqdefault (320x180, 16:9, essentially always present). onerror
  // covers hard failures. img.src ONLY — no innerHTML, no background-image.
  const vid = rec.videoId ? encodeURIComponent(rec.videoId) : '';
  const maxresSrc = vid ? `https://i.ytimg.com/vi/${vid}/maxresdefault.jpg` : '';
  const mqSrc = vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : '';
  const swapToMq = () => {
    if (mqSrc && thumb.getAttribute('src') !== mqSrc) {
      thumb.onerror = null; // one-shot: never loop on a broken fallback
      thumb.src = mqSrc;
    }
  };
  thumb.onload = () => {
    if (thumb.naturalWidth && thumb.naturalWidth < 320) swapToMq();
  };
  thumb.onerror = () => {
    thumb.onerror = null;
    swapToMq();
  };
  const primarySrc = maxresSrc || mqSrc;
  if (primarySrc) thumb.src = primarySrc; // img.src only

  // Absolute-positioned thumbnail overlays — no layout impact, so card height is
  // unchanged: video length bottom-right, and a SHORTS tag for likely Shorts.
  const overlays = [];
  const durSecs = rec.durationSeconds;
  if (typeof durSecs === 'number' && durSecs > 0) {
    overlays.push(
      el('span', { class: 'row__duration', 'aria-hidden': 'true', text: formatDuration(durSecs) })
    );
  }
  if (isShort(durSecs)) {
    overlays.push(el('span', { class: 'row__shorts', 'aria-hidden': 'true', text: 'SHORTS' }));
  }

  // Play-in-embedded-player overlay (▶), revealed on hover of the thumbnail.
  const playOverlay = el('span', { class: 'row__play', 'aria-hidden': 'true' }, [
    el('span', { class: 'row__play-icon', text: '▶' }),
  ]);

  // The thumbnail is a mouse-convenience PLAY trigger (loads the embedded
  // player). It is aria-hidden / out of the tab order because the footer "Play"
  // button is the accessible, keyboard-reachable equivalent.
  const thumbBtn = el(
    'button',
    {
      class: 'row__thumb-btn',
      type: 'button',
      tabindex: '-1',
      'aria-hidden': 'true',
      onclick: () => handlers.onPlay && handlers.onPlay(rec.videoId),
    },
    [thumb, ...overlays, playOverlay]
  );

  const titleLink = el('a', {
    class: 'row__title',
    href: watchUrl,
    target: '_blank',
    rel: 'noopener',
    text: rec.title, // safe
  });

  const avatar = buildAvatar(rec, channels);
  const channel = el('span', { class: 'row__channel', text: rec.channelTitle || '' });

  const timeAbs = el('time', {
    class: 'row__time-abs',
    datetime: rec.publishedAt,
    text: formatAbsolute(rec.publishedAt),
    title: rec.publishedAt,
  });
  const timeRel = el('span', {
    class: 'row__time-rel',
    text: formatRelative(rec.publishedAt),
  });

  const meta = el('div', { class: 'row__meta' }, [
    titleLink,
    el('div', { class: 'row__sub' }, [
      avatar,
      channel,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeAbs,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeRel,
    ]),
  ]);

  // Compact ICON actions on ONE row. Glyphs are static unicode (never API data);
  // each carries an aria-label AND a title tooltip. Watched/Not keep their
  // classes so setCardState's aria-pressed + the active-colour CSS still apply.
  const playBtn = el('button', {
    class: 'btn btn--icon btn--play',
    type: 'button',
    'aria-label': `Play "${rec.title}" in the player`,
    title: 'Play',
    text: '▶',
    onclick: () => handlers.onPlay && handlers.onPlay(rec.videoId),
  });
  const ytLink = el('a', {
    class: 'btn btn--icon btn--yt',
    href: watchUrl,
    target: '_blank',
    rel: 'noopener',
    'aria-label': `Open "${rec.title}" on YouTube`,
    title: 'Open on YouTube',
    text: '↗',
  });
  const watchedBtn = el('button', {
    class: 'btn btn--icon btn--watched',
    type: 'button',
    'aria-label': `Mark "${rec.title}" as watched`,
    'aria-pressed': 'false',
    title: 'Watched',
    text: '✓',
    onclick: () => handlers.onWatched(rec.videoId),
  });
  const notBtn = el('button', {
    class: 'btn btn--icon btn--not',
    type: 'button',
    'aria-label': `Mark "${rec.title}" as not interested`,
    'aria-pressed': 'false',
    title: 'Not interested',
    text: '✕',
    onclick: () => handlers.onNotInterested(rec.videoId),
  });

  const actions = el('div', { class: 'row__actions' }, [
    playBtn,
    ytLink,
    watchedBtn,
    notBtn,
  ]);

  const li = el(
    'li',
    {
      class: 'row',
      tabindex: '0',
      role: 'listitem',
      dataset: { videoId: rec.videoId },
      'aria-label': `${rec.title}, ${rec.channelTitle || 'unknown channel'}`,
    },
    [thumbBtn, meta, actions]
  );

  // Reflect the record's initial state (marked videos render greyed on load).
  setCardState(li, rec.state);

  return li;
}

/**
 * Render the queue list into `listEl`.
 * @param {HTMLElement} listEl the <ul>
 * @param {Array<object>} queue records (already sorted oldest-first)
 * @param {object} handlers { onWatched, onNotInterested }
 * @param {Record<string,{title:string,avatarUrl:string}>} [channels] avatar map
 */
export function renderQueue(listEl, queue, handlers, channels = {}) {
  clear(listEl);
  for (const rec of queue) {
    listEl.append(buildQueueRow(rec, handlers, channels));
  }
}

/**
 * Update the header counts and cutoff display.
 * @param {object} refs { queuedCountEl, handledCountEl, cutoffEl }
 * @param {object} data { queued, handled, cutoff }
 */
export function renderStats(refs, { queued, handled, cutoff }) {
  if (refs.queuedCountEl) refs.queuedCountEl.textContent = String(queued);
  if (refs.handledCountEl) refs.handledCountEl.textContent = String(handled);
  if (refs.cutoffEl) {
    if (cutoff) {
      refs.cutoffEl.textContent = formatAbsolute(cutoff);
      refs.cutoffEl.setAttribute('datetime', cutoff);
      refs.cutoffEl.setAttribute('title', cutoff);
    } else {
      refs.cutoffEl.textContent = 'not set';
      refs.cutoffEl.removeAttribute('datetime');
    }
  }
}

/**
 * Toggle visibility of a section element.
 * @param {HTMLElement} node
 * @param {boolean} visible
 */
export function setVisible(node, visible) {
  if (!node) return;
  node.hidden = !visible;
}
