// js/ui.js
//
// Rendering helpers. STRICT XSS SAFETY: every API-derived string (video title,
// channel name, etc.) is rendered via textContent or created DOM text nodes.
// We NEVER assign API data into innerHTML. Video URLs are built with
// encodeURIComponent on the id, and thumbnails are set via img.src only.

import { STATE_NEW } from './config.js';
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
 * @param {string} state 'new' | 'skipped'
 */
export function setCardState(card, state) {
  if (!card) return;
  const handled = state !== STATE_NEW; // single "handled" state

  card.classList.toggle('row--handled', handled);

  const skipBtn = card.querySelector('.btn--skip');
  if (skipBtn) skipBtn.setAttribute('aria-pressed', String(handled));
}

/**
 * Reflect a record's per-video preferred speed on its card's speed buttons
 * (active / deep-blue accent on the matching rate; none active when unset), in
 * place — no full re-render. Attribute/class only (XSS-safe).
 * @param {HTMLElement} card
 * @param {number|undefined} preferredRate
 */
export function setCardRate(card, preferredRate) {
  if (!card) return;
  for (const b of card.querySelectorAll('.btn--cardrate')) {
    const active = Number(b.dataset.rate) === preferredRate;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  }
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
 * Build the channel name element. When the record carries a channelId, render it
 * as a link to that channel on YouTube (new tab, noopener); the id is passed
 * through encodeURIComponent and the visible name via textContent (XSS-safe). A
 * click is stopPropagation'd so it opens the channel even if an ancestor has a
 * click-to-play handler. With no channelId, render plain text.
 * @param {object} rec video record
 * @returns {HTMLElement}
 */
function buildChannelLink(rec) {
  const title = rec.channelTitle || '';
  if (rec.channelId) {
    return el('a', {
      class: 'row__channel',
      href: 'https://www.youtube.com/channel/' + encodeURIComponent(rec.channelId),
      target: '_blank',
      rel: 'noopener',
      text: title, // safe
      onclick: (e) => e.stopPropagation(),
    });
  }
  return el('span', { class: 'row__channel', text: title });
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
    buildChannelLink(rec),
    el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
    el('time', {
      class: 'row__time-abs',
      datetime: rec.publishedAt,
      text: formatAbsolute(rec.publishedAt),
      title: rec.publishedAt,
    })
  );
}

/**
 * Build a single queue row (<li>). All text is set safely.
 * @param {object} rec video record
 * @param {object} handlers { onSkip(id), onPlay(id), onCardRate(id, rate) }
 * @param {Record<string,{title:string,avatarUrl:string}>} [channels] avatar map
 * @returns {HTMLLIElement}
 */
export function buildQueueRow(rec, handlers, channels = {}) {
  const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(rec.videoId);

  // A card is treated as non-embeddable ONLY when the details fetch has
  // explicitly reported it so (rec.embeddable === false). While embeddable is
  // still undefined (details not yet loaded) the card keeps the normal in-app
  // Play + speed treatment; it never flips to the YouTube treatment on a merely
  // falsy/unknown value.
  const noEmbed = rec.embeddable === false;

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

  // Hover overlay on the thumbnail. Embeddable cards get the in-app PLAY (▶)
  // trigger; non-embeddable cards can't be framed, so the glyph becomes ↗ ("opens
  // off-app") and the click opens the video on YouTube instead of a dead in-app
  // play. Both glyphs are static unicode (never API data).
  const playOverlay = el(
    'span',
    { class: noEmbed ? 'row__play row__play--external' : 'row__play', 'aria-hidden': 'true' },
    [el('span', { class: 'row__play-icon', text: noEmbed ? '↗' : '▶' })]
  );

  // The thumbnail is a mouse-convenience trigger. It is aria-hidden / out of the
  // tab order because the footer button (▶ Play, or ↗ YouTube for non-embeddable)
  // is the accessible, keyboard-reachable equivalent. For non-embeddable videos
  // the click opens YouTube in a new tab rather than attempting an in-app play.
  // An <a> (not a <button>) so a right-click offers the browser's LINK context
  // menu (Open in new tab, Copy link address, …) like the title link, instead of
  // the image-only menu. href is the same safe youtube.com/watch URL as the title.
  const thumbBtn = el(
    'a',
    noEmbed
      ? {
          // Non-embeddable: let the native link handle everything. Plain
          // left-click opens YouTube in a new tab (same as the old window.open).
          class: 'row__thumb-btn',
          href: watchUrl,
          target: '_blank',
          rel: 'noopener',
          tabindex: '-1',
          'aria-hidden': 'true',
        }
      : {
          // Embeddable: plain left-click plays in-app; any modified click (or a
          // non-left button) falls through to the native href so ctrl/cmd/shift/
          // middle-click still opens YouTube in a new tab.
          class: 'row__thumb-btn',
          href: watchUrl,
          tabindex: '-1',
          'aria-hidden': 'true',
          onclick: (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            handlers.onPlay && handlers.onPlay(rec.videoId);
          },
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
  const channel = buildChannelLink(rec);

  const timeAbs = el('time', {
    class: 'row__time-abs',
    datetime: rec.publishedAt,
    text: formatAbsolute(rec.publishedAt),
    title: rec.publishedAt,
  });
  const meta = el('div', { class: 'row__meta' }, [
    titleLink,
    el('div', { class: 'row__sub' }, [
      avatar,
      channel,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeAbs,
    ]),
  ]);

  // Two TEXT action buttons flank the compact speed group: [▶ Play] · 1× 2× ·
  // [Skip]. The ▶ glyph is static unicode (never API data); each button carries
  // an aria-label AND a title. The card title itself links to the video on
  // YouTube, so there is no separate ↗ button. Skip keeps its class so
  // setCardState's aria-pressed + the active-colour CSS still apply.
  const playBtn = el('button', {
    class: 'btn btn--play',
    type: 'button',
    'aria-label': `Play "${rec.title}" in the player`,
    title: 'Play',
    text: '▶ Play',
    onclick: () => handlers.onPlay && handlers.onPlay(rec.videoId),
  });
  const skipBtn = el('button', {
    class: 'btn btn--skip',
    type: 'button',
    'aria-label': `Skip "${rec.title}"`,
    'aria-pressed': 'false',
    title: 'Skip',
    text: 'Skip',
    onclick: () => handlers.onSkip && handlers.onSkip(rec.videoId),
  });

  // Per-video preferred-speed group (1× / 2×) placed right after Play. It sets a
  // preference only — does NOT start playback. Glyphs are static text. (1.5× is a
  // valid preset but is only exposed in the player controls, not on cards.)
  const speedGroup = el(
    'div',
    {
      class: 'row__rates',
      role: 'group',
      'aria-label': `Preferred speed for "${rec.title}"`,
    },
    [1, 2].map((r) => {
      const label = `${r}×`;
      return el('button', {
        class: 'btn btn--cardrate',
        type: 'button',
        dataset: { rate: String(r) },
        'aria-label': `Set ${label} speed for this video`,
        'aria-pressed': 'false',
        title: `${label} preferred speed`,
        text: label,
        onclick: () => handlers.onCardRate && handlers.onCardRate(rec.videoId, r),
      });
    })
  );

  // Non-embeddable videos can't play in the app, so their footer replaces the
  // Play button + speed group with a single "↗ YouTube" link (a real anchor, so
  // it is keyboard-reachable, activates on Enter, and opens a new tab natively).
  // Skip is kept in both cases. ↗ / YouTube are static strings (never API data).
  const youtubeBtn = el('a', {
    class: 'btn btn--youtube',
    href: watchUrl,
    target: '_blank',
    rel: 'noopener',
    'aria-label': `Open "${rec.title}" on YouTube (can't play in the app)`,
    title: 'Open on YouTube',
    text: '↗ YouTube',
  });

  const actions = el(
    'div',
    { class: 'row__actions' },
    noEmbed ? [youtubeBtn, skipBtn] : [playBtn, speedGroup, skipBtn]
  );

  const li = el(
    'li',
    {
      class: noEmbed ? 'row row--noembed' : 'row',
      tabindex: '0',
      role: 'listitem',
      dataset: { videoId: rec.videoId },
      'aria-label': `${rec.title}, ${rec.channelTitle || 'unknown channel'}`,
    },
    [thumbBtn, meta, actions]
  );

  // Reflect the record's initial state (marked videos render greyed on load).
  setCardState(li, rec.state);
  setCardRate(li, rec.preferredRate);

  return li;
}

/**
 * Render the queue list into `listEl`.
 * @param {HTMLElement} listEl the <ul>
 * @param {Array<object>} queue records (already sorted oldest-first)
 * @param {object} handlers { onSkip, onPlay, onCardRate }
 * @param {Record<string,{title:string,avatarUrl:string}>} [channels] avatar map
 */
export function renderQueue(listEl, queue, handlers, channels = {}, more = null) {
  clear(listEl);
  for (const rec of queue) {
    listEl.append(buildQueueRow(rec, handlers, channels));
  }
  // Optional "Show all (N)" button at the bottom (pure display windowing). It is
  // NOT a .row, so keyboard j/k skip it. Text via textContent (XSS-safe).
  if (more && typeof more.onShowAll === 'function') {
    const btn = el('button', {
      class: 'btn queue-more__btn',
      type: 'button',
      text: `Show all (${more.total})`,
      onclick: more.onShowAll,
    });
    listEl.append(el('li', { class: 'queue-more', role: 'presentation' }, [btn]));
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
