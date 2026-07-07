// js/ui.js
//
// Rendering helpers. STRICT XSS SAFETY: every API-derived string (video title,
// channel name, etc.) is rendered via textContent or created DOM text nodes.
// We NEVER assign API data into innerHTML. Video URLs are built with
// encodeURIComponent on the id, and thumbnails are set via img.src only.

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
 * Build a single queue row (<li>). All text is set safely.
 * @param {object} rec video record
 * @param {object} handlers { onWatched(id), onNotInterested(id) }
 * @returns {HTMLLIElement}
 */
export function buildQueueRow(rec, handlers) {
  const watchUrl = 'https://www.youtube.com/watch?v=' + encodeURIComponent(rec.videoId);

  const thumb = el('img', {
    class: 'row__thumb',
    alt: '',
    loading: 'lazy',
    width: '480',
    height: '270',
  });
  // Thumbnails must stay sharp at 400px+ card widths. The stored thumbnailUrl may
  // be a low-res (medium/320px) URL from an older fetch, so we self-heal by
  // deriving a reliably-available high-res image straight from the video id:
  // hqdefault (480x360) is essentially always present, and CSS object-fit: cover
  // crops it to the card's 16:9 box. If it ever 404s, fall back once to the
  // stored URL (or mqdefault). img.src ONLY — no innerHTML, no background-image.
  const vid = rec.videoId ? encodeURIComponent(rec.videoId) : '';
  const hiResSrc = vid ? `https://i.ytimg.com/vi/${vid}/hqdefault.jpg` : '';
  const fallbackSrc =
    rec.thumbnailUrl || (vid ? `https://i.ytimg.com/vi/${vid}/mqdefault.jpg` : '');
  thumb.onerror = () => {
    thumb.onerror = null; // one-shot: never loop on a broken fallback
    if (fallbackSrc && thumb.getAttribute('src') !== fallbackSrc) {
      thumb.src = fallbackSrc;
    }
  };
  const primarySrc = hiResSrc || fallbackSrc;
  if (primarySrc) thumb.src = primarySrc; // img.src only

  const thumbLink = el(
    'a',
    {
      class: 'row__thumb-link',
      href: watchUrl,
      target: '_blank',
      rel: 'noopener',
      tabindex: '-1',
      'aria-hidden': 'true',
    },
    [thumb]
  );

  const titleLink = el('a', {
    class: 'row__title',
    href: watchUrl,
    target: '_blank',
    rel: 'noopener',
    text: rec.title, // safe
  });

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
      channel,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeAbs,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeRel,
    ]),
  ]);

  const watchedBtn = el('button', {
    class: 'btn btn--watched',
    type: 'button',
    'aria-label': `Mark "${rec.title}" as watched`,
    text: 'Watched',
    onclick: () => handlers.onWatched(rec.videoId),
  });
  const notBtn = el('button', {
    class: 'btn btn--not',
    type: 'button',
    'aria-label': `Mark "${rec.title}" as not interested`,
    text: 'Not interested',
    onclick: () => handlers.onNotInterested(rec.videoId),
  });

  const actions = el('div', { class: 'row__actions' }, [watchedBtn, notBtn]);

  const li = el(
    'li',
    {
      class: 'row',
      tabindex: '0',
      role: 'listitem',
      dataset: { videoId: rec.videoId },
      'aria-label': `${rec.title}, ${rec.channelTitle || 'unknown channel'}`,
    },
    [thumbLink, meta, actions]
  );

  return li;
}

/**
 * Render the queue list into `listEl`.
 * @param {HTMLElement} listEl the <ul>
 * @param {Array<object>} queue records (already sorted oldest-first)
 * @param {object} handlers { onWatched, onNotInterested }
 */
export function renderQueue(listEl, queue, handlers) {
  clear(listEl);
  for (const rec of queue) {
    listEl.append(buildQueueRow(rec, handlers));
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
