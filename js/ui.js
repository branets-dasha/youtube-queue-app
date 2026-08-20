// js/ui.js
//
// Rendering helpers. STRICT XSS SAFETY: every API-derived string (video title,
// channel name, etc.) is rendered via textContent or created DOM text nodes.
// We NEVER assign API data into innerHTML. Video URLs are built with
// encodeURIComponent on the id, and thumbnails are set via img.src only.
//
// This module holds NO data policy. It never decides where a channel title or
// avatar comes from: each page passes a `resolveChannel(rec)` closure built on
// the pure resolvers in queue.js (subscriptionChannelInfo / stashChannelInfo),
// and everything here simply renders the answer it is handed.

import { STATE_NEW } from './config.js';
import { formatDuration, isShort, parseDescription } from './queue.js';

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
 * data-video-id, and child order, so the calling page's focus/keyboard
 * contract is untouched — and it adds/removes nothing that affects layout, so
 * card height is identical in every state.
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
 * (active / deep-blue accent on the matching speed; none active when unset), in
 * place — no full re-render. Attribute/class only (XSS-safe).
 * @param {HTMLElement} card
 * @param {number|undefined} preferredSpeed
 */
export function setCardSpeed(card, preferredSpeed) {
  if (!card) return;
  for (const b of card.querySelectorAll('.btn--cardspeed')) {
    const active = Number(b.dataset.speed) === preferredSpeed;
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
export function avatarPlaceholder(title) {
  const letter = ((title || '').trim().charAt(0) || '?').toUpperCase();
  return el('span', {
    class: 'row__avatar row__avatar--placeholder',
    'aria-hidden': 'true',
    text: letter, // safe text
  });
}

/**
 * Build the channel avatar from ALREADY-RESOLVED display info. This function
 * holds NO resolution policy of its own — where the title and the URL came from
 * (the record, the yqa_channels map, or both, and in which order) is the calling
 * page's business, settled by the pure resolvers in queue.js. Given no URL it
 * renders the neutral letter placeholder, so card height stays uniform.
 * img.src ONLY; alt = channel title, or '' when `decorative` (the avatar sits
 * inside the channel link next to the name, so the name alone is the link's
 * accessible name and the image must not repeat it).
 * @param {{title?:string,avatarUrl?:string}|null} info resolved channel display
 *        info, from subscriptionChannelInfo / stashChannelInfo (queue.js)
 * @param {boolean} [decorative] render with an empty alt
 * @returns {HTMLElement}
 */
export function buildAvatar(info, decorative = false) {
  const title = (info && info.title) || '';
  const avatarUrl = (info && info.avatarUrl) || '';
  if (!avatarUrl) return avatarPlaceholder(title);

  const img = el('img', {
    class: 'row__avatar',
    alt: decorative ? '' : title, // channel title (or nothing when inside the link)
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
 * Build the channel badge: the avatar + the channel name. When the record
 * carries a channelId, BOTH sit inside a SINGLE anchor to that channel on
 * YouTube (new tab, noopener) — one link, one tab stop, so clicking the icon or
 * the name both navigate. The id is passed through encodeURIComponent and the
 * visible name via textContent (XSS-safe). A click is stopPropagation'd so it
 * opens the channel even if an ancestor has a click-to-play handler. With no
 * channelId, render the avatar + plain text, unlinked.
 *
 * Returns a DocumentFragment in the unlinked case so callers can spread it into
 * their flex row exactly as before.
 *
 * The channel's title and avatar are NOT derived here: `resolveChannel` — the
 * calling page's policy, bound to that page's channels map — answers both, and
 * the one resolved title feeds the avatar AND the visible name, so a card can
 * never show two different answers for the same channel.
 * @param {object} rec video record (supplies channelId, for the link href)
 * @param {(rec:object) => {title?:string,avatarUrl?:string}} resolveChannel
 * @returns {Node}
 */
function buildChannelBadge(rec, resolveChannel) {
  const info = (typeof resolveChannel === 'function' && resolveChannel(rec)) || null;
  const title = (info && info.title) || '';
  if (rec.channelId) {
    return el(
      'a',
      {
        class: 'row__channel-link',
        href: 'https://www.youtube.com/channel/' + encodeURIComponent(rec.channelId),
        target: '_blank',
        rel: 'noopener',
        onclick: (e) => e.stopPropagation(),
      },
      [
        buildAvatar(info, true), // decorative: name below is the link text
        el('span', { class: 'row__channel', text: title }), // safe
      ]
    );
  }
  const frag = document.createDocumentFragment();
  frag.append(buildAvatar(info), el('span', { class: 'row__channel', text: title }));
  return frag;
}

/**
 * Render the player's info meta row (avatar + channel + posted date) for `rec`
 * into `container`, mirroring a card's meta row through the very same channel
 * badge — so the now-playing bar and the cards can never resolve a channel
 * differently. Pass rec = null to clear it; the resolver is then never called,
 * which is why the clearing callers may omit it. XSS-safe (textContent,
 * img.src, encodeURIComponent via buildAvatar/formatters).
 * @param {HTMLElement} container
 * @param {object|null} rec video record
 * @param {(rec:object) => {title?:string,avatarUrl?:string}} [resolveChannel]
 *        the calling page's channel resolver (see buildChannelBadge)
 */
export function renderPlayerMeta(container, rec, resolveChannel) {
  if (!container) return;
  clear(container);
  if (!rec) return;
  container.append(
    buildChannelBadge(rec, resolveChannel),
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
 * Render the currently-playing video's description into `container`, with
 * clickable in-video timestamps (seek the built-in player) and clickable plain
 * URLs (open in a new tab). Segments come from the pure `parseDescription`
 * (queue.js). STRICT XSS SAFETY: all description-derived text is set via
 * textContent / text nodes — never innerHTML; the videoId is passed through
 * encodeURIComponent when building the timestamp href.
 *
 * Timestamp links get a REAL youtube.com/watch?v=…&t=…s href so the native
 * right-click "Open link in new tab" still works, but a plain left-click is
 * intercepted to seek the built-in player instead of navigating.
 *
 * @param {HTMLElement} container the #player-description element
 * @param {object|null} rec video record (uses rec.description, rec.videoId)
 * @param {{ onSeek: (seconds:number) => void }} handlers
 */
export function renderDescription(container, rec, { onSeek } = {}) {
  if (!container) return;
  clear(container);
  if (!rec || !rec.description || !rec.description.trim()) {
    container.hidden = true;
    return;
  }
  const watchBase = 'https://www.youtube.com/watch?v=' + encodeURIComponent(rec.videoId);
  for (const seg of parseDescription(rec.description)) {
    if (seg.type === 'timestamp') {
      const a = el('a', {
        class: 'player__desc-ts',
        href: `${watchBase}&t=${seg.seconds}s`,
        text: seg.text, // safe
      });
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof onSeek === 'function') onSeek(seg.seconds);
      });
      container.append(a);
    } else if (seg.type === 'url') {
      container.append(
        el('a', {
          class: 'player__desc-link',
          href: seg.url,
          target: '_blank',
          rel: 'noopener noreferrer',
          text: seg.text, // safe
        })
      );
    } else {
      // Plain text: append as a text node (newlines preserved via CSS pre-wrap).
      container.append(document.createTextNode(seg.text));
    }
  }
  container.hidden = false;
}

// ---------------------------------------------------------------------------
// Card "⋯" overflow menu
// ---------------------------------------------------------------------------

// The ONE open card menu, module-wide. Keeping the reference here is what makes
// opening a second menu close the first, and what lets renderQueue() drop a
// menu — together with its document listeners — when it rebuilds the list out
// from under it.
let activeCardMenu = null;

/**
 * Close the open card menu, if any. Safe to call at any time: that is how
 * renderQueue clears a menu whose DOM it is about to throw away.
 * @param {object} [opts]
 * @param {boolean} [opts.restoreFocus=true] pass false when focus is ALREADY
 *        leaving on its own (the wrapper's focusout path), so the close never
 *        pulls it back from wherever the user is deliberately taking it.
 */
function closeCardMenu({ restoreFocus = true } = {}) {
  const open = activeCardMenu;
  if (!open) return;
  activeCardMenu = null;
  document.removeEventListener('keydown', open.onKeydown, true);
  document.removeEventListener('pointerdown', open.onPointerDown);
  // Ask BEFORE hiding: hiding an ancestor of the focused element drops focus to
  // <body>, and we must never yank focus back from wherever the user put it.
  const hadFocus = restoreFocus && open.panel.contains(document.activeElement);
  open.panel.hidden = true;
  open.trigger.setAttribute('aria-expanded', 'false');
  // Back to the trigger, but ONLY from inside the panel — an Esc press, or an
  // item being used. Opening leaves focus on the trigger, so every other close
  // (focus already gone, or a pointerdown outside) has nothing to restore.
  if (hadFocus) open.trigger.focus();
}

/**
 * Open one card menu (closing any other) and install its two document-level
 * dismissal listeners. FOCUS DOES NOT MOVE: this is a disclosure, not an ARIA
 * menu, so the trigger keeps focus — pressing the same key again toggles it
 * shut — and Tab steps from there into the panel, its next sibling. Dismissal
 * on the way OUT is the wrapper's own focusout listener (see buildCardMenu);
 * these two cover the cases focus never moves for: Esc, and a pointerdown on
 * something unfocusable.
 * @param {HTMLElement} trigger the "⋯" button
 * @param {HTMLElement} panel the menu panel
 */
function openCardMenu(trigger, panel) {
  closeCardMenu();

  // Capture phase, so the staleness check below runs before the page's own
  // keydown table reads the key. It SWALLOWS NOTHING: every key reaches that
  // table, so the card shortcuts keep working with a menu open — they resolve
  // the card by walking up from whatever holds focus, and j/k move focus onto
  // the .row itself, which leaves this wrapper and lets its focusout dismiss
  // the menu.
  const onKeydown = (e) => {
    // A card can be dropped WITHOUT renderQueue — with Hide-marked on, marking a
    // video removes just its card (auto-advance does exactly that when the
    // playing video ends) — taking this panel with it. Such a menu is stale: it
    // is detached but still holds both document listeners, so retire it here,
    // on the next key, and let that key through UNTOUCHED.
    if (!panel.isConnected) {
      closeCardMenu();
      return;
    }
    if (e.key === 'Escape') {
      // Esc is the app's PANIC key, unconditionally. Close this menu — a
      // detached-but-live one would keep both document listeners behind the
      // curtain — but do NOT stop or prevent anything: the same press must
      // still reach the page's table and cover the page.
      closeCardMenu();
    }
  };
  const onPointerDown = (e) => {
    if (panel.contains(e.target) || trigger.contains(e.target)) return;
    closeCardMenu();
  };

  activeCardMenu = { trigger, panel, onKeydown, onPointerDown };
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('pointerdown', onPointerDown);
}

/**
 * Build a card's "⋯" overflow menu: the trigger button plus its (hidden) panel,
 * wrapped in a .row__menu div. The wrapper earns its keep three times over — it
 * is the panel's positioning context; it keeps the trigger from being a direct
 * .btn child of .row__actions, whose "flex: 1 1 0" share would squeeze ▶ Play;
 * and it is the subtree focusout watches, which is what dismisses the menu when
 * focus leaves it in any direction.
 *
 * A DISCLOSURE, not the ARIA menu-button pattern — that pattern REQUIRES focus
 * to move into the menu on open, and this one deliberately leaves focus on the
 * trigger so the same key toggles it shut. Claiming role="menu"/"menuitem"
 * while refusing the focus contract would describe the widget to a screen
 * reader as something it is not, so the roles are gone, and aria-haspopup with
 * them (it announces a menu/dialog/listbox, none of which this is). What is
 * left — aria-expanded plus aria-controls — IS the whole disclosure contract.
 *
 * Nothing here carries btn--skip or btn--cardspeed (setCardState/setCardSpeed
 * query those), and the wrapper is not a .row (j/k navigation walks those).
 *
 * THE ITEMS ARE THE PAGE'S, not this module's: it renders the descriptors it is
 * handed and holds no policy about what a card can do.
 * @param {object} rec video record
 * @param {Array<{label:string,onSelect:Function,disabled?:boolean}>} items the
 *        calling page's menu model for this record, known non-empty
 * @returns {HTMLElement} the .row__menu wrapper
 */
function buildCardMenu(rec, items) {
  // aria-controls needs a per-card id. A videoId is already URL-safe, but every
  // id this module builds goes through encodeURIComponent — no exceptions.
  const panelId = `row-menu-${encodeURIComponent(rec.videoId)}`;

  const itemNodes = items.map((item) => {
    const node = el('button', {
      class: 'row__menu-item',
      type: 'button',
      // Page-authored static strings, never API data — but text: is textContent
      // either way, which is the rule this module keeps without exceptions.
      text: item.label,
      onclick: () => {
        // Close FIRST — and note it cannot double-close: closeCardMenu clears
        // activeCardMenu before it hides the panel, so the focusout that hiding
        // fires finds no menu of its own to dismiss.
        closeCardMenu();
        item.onSelect();
      },
    });
    // The PROPERTY, not the attribute: el() would setAttribute a `false` too,
    // and `disabled="false"` still disables. An item is not a .btn, so
    // styles.css gives .row__menu-item:disabled its own dimmed treatment.
    if (item.disabled) node.disabled = true;
    return node;
  });

  // A plain container needs no accessible name, so the aria-label that
  // role="menu" once required is gone with it; the trigger keeps its own.
  const panel = el('div', { class: 'row__menu-panel', id: panelId }, itemNodes);
  panel.hidden = true;

  const label = 'More actions';

  const trigger = el('button', {
    class: 'btn btn--menu',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': panelId,
    'aria-label': label,
    title: label,
    text: '⋯', // U+22EF (midline ellipsis), static
    onclick: () => {
      // Focus never left, so a second Enter/Space on the still-focused trigger
      // lands right back here and toggles the menu shut. No special-casing.
      if (activeCardMenu && activeCardMenu.trigger === trigger) closeCardMenu();
      else openCardMenu(trigger, panel);
    },
  });

  const wrapper = el('div', { class: 'row__menu' }, [trigger, panel]);

  // THE fix for a Tab that used to walk away leaving the menu open: focus
  // leaving this subtree in any direction closes it — Tab off the item,
  // Shift+Tab off the trigger, a click onto another control. A null
  // relatedTarget (focus fell into the cross-origin player iframe, or nowhere)
  // is not the usual "can't tell" problem here: all this widget needs to know is
  // that focus is no longer inside it, and it is not — so closing is correct.
  // The identity check keeps one card's stale listener from closing ANOTHER
  // card's menu: clicking a second trigger swaps which menu is open (via
  // pointerdown) before this focusout arrives.
  wrapper.addEventListener('focusout', (e) => {
    if (!activeCardMenu || activeCardMenu.panel !== panel) return;
    if (e.relatedTarget && wrapper.contains(e.relatedTarget)) return;
    closeCardMenu({ restoreFocus: false });
  });

  return wrapper;
}

/**
 * Build a single queue row (<li>). All text is set safely.
 * @param {object} rec video record
 * @param {object} handlers { onSkip(id), onPlay(id), onCardSpeed(id, speed),
 *        cardMenu(rec)? }. cardMenu is OPTIONAL and returns this card's menu
 *        model — an array of { label, onSelect, disabled? } descriptors; its
 *        presence AND a non-empty return are together what render the "⋯"
 *        overflow menu, so a page can suppress it per record without a second
 *        flag. stash-page.js passes no such key, so its cards render none. It
 *        runs during row construction, once per card: keep it cheap and
 *        side-effect-free.
 * @param {(rec:object) => {title?:string,avatarUrl?:string}} resolveChannel the
 *        calling page's channel resolver (see buildChannelBadge)
 * @param {string} [skipLabel='Skip'] visible label for the mark button
 *        ('Remove' on the stash page); also used in its aria-label and title.
 *        The btn--skip CLASS never changes — styles.css and setCardState key off
 *        it. A trailing positional param with a default (like `more`) rather
 *        than an options object (over-general for one string) or a key on
 *        `handlers`, which is a pure bag of callbacks everywhere else — a
 *        display string smuggled in there would hide from the next reader.
 * @returns {HTMLLIElement}
 */
export function buildQueueRow(rec, handlers, resolveChannel, skipLabel = 'Skip') {
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

  const channelBadge = buildChannelBadge(rec, resolveChannel);

  const timeAbs = el('time', {
    class: 'row__time-abs',
    datetime: rec.publishedAt,
    text: formatAbsolute(rec.publishedAt),
    title: rec.publishedAt,
  });
  const meta = el('div', { class: 'row__meta' }, [
    titleLink,
    el('div', { class: 'row__sub' }, [
      channelBadge,
      el('span', { class: 'row__dot', text: '·', 'aria-hidden': 'true' }),
      timeAbs,
    ]),
  ]);

  // The footer is plain source order — [▶ Play] · 1× 1.5× 2× · [Skip] — with Play
  // stretching, so the compact speed group is pushed hard right against Skip (no
  // wrapper, no `order`). The ▶ glyph is static unicode (never API data); each
  // button carries an aria-label AND a title. The card title itself links to the
  // video on YouTube, so there is no separate ↗ button. Skip keeps its class so
  // setCardState's aria-pressed + the active-colour CSS still apply.
  const playBtn = el('button', {
    class: 'btn btn--play',
    type: 'button',
    'aria-label': `Play "${rec.title}" in the player`,
    title: 'Play',
    text: '▶ Play',
    onclick: () => handlers.onPlay && handlers.onPlay(rec.videoId),
  });
  // All THREE label surfaces come from skipLabel, so the stash can say "Remove".
  // The btn--skip CLASS is deliberately NOT derived from it and must stay put:
  // styles.css keys the [aria-pressed='true'] slate fill off it and setCardState
  // finds this button with card.querySelector('.btn--skip'). Renaming the class
  // to match a relabelled button would silently break both.
  const skipBtn = el('button', {
    class: 'btn btn--skip',
    type: 'button',
    'aria-label': `${skipLabel} "${rec.title}"`,
    'aria-pressed': 'false',
    title: skipLabel,
    text: skipLabel,
    onclick: () => handlers.onSkip && handlers.onSkip(rec.videoId),
  });

  // Per-video preferred-speed group (1× / 1.5× / 2× — the full set of valid
  // presets, the same three offered per channel on channels.html) placed right
  // after Play. It sets a preference only — does NOT start playback. Glyphs are
  // static text.
  const speedGroup = el(
    'div',
    {
      class: 'row__speeds',
      role: 'group',
      'aria-label': `Preferred speed for "${rec.title}"`,
    },
    [1, 1.5, 2].map((r) => {
      const label = `${r}×`;
      return el('button', {
        class: 'btn btn--cardspeed',
        type: 'button',
        dataset: { speed: String(r) },
        text: label,
        'aria-label': `Set ${label} speed for this video`,
        'aria-pressed': 'false',
        title: `${label} preferred speed`,
        onclick: () => handlers.onCardSpeed && handlers.onCardSpeed(rec.videoId, r),
      });
    })
  );

  // Non-embeddable videos can't play in the app, so their footer replaces the
  // Play button with a single "↗ YouTube" link (a real anchor, so it is
  // keyboard-reachable, activates on Enter, and opens a new tab natively) and
  // drops the speed group entirely — there is no in-app playback to set a speed
  // for. Skip is kept in both cases, and CSS gives it a fixed share of the
  // footer so it renders at the same width either way. ↗ / YouTube are static
  // strings (never API data).
  const youtubeBtn = el('a', {
    class: 'btn btn--youtube',
    href: watchUrl,
    target: '_blank',
    rel: 'noopener',
    'aria-label': `Open "${rec.title}" on YouTube (can't play in the app)`,
    title: 'Open on YouTube',
    text: '↗ YouTube',
  });

  // The "⋯" menu sits after Skip in BOTH footers — a non-embeddable video can
  // still be stashed. It is null when the page offers this card no commands at
  // all (no cardMenu, or an empty return); el() skips a null child.
  const items = typeof handlers.cardMenu === 'function' ? handlers.cardMenu(rec) || [] : [];
  const menu = items.length ? buildCardMenu(rec, items) : null;

  const actions = el(
    'div',
    { class: 'row__actions' },
    noEmbed ? [youtubeBtn, skipBtn, menu] : [playBtn, speedGroup, skipBtn, menu]
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
  setCardSpeed(li, rec.preferredSpeed);

  return li;
}

/**
 * Render the queue list into `listEl`.
 * @param {HTMLElement} listEl the <ul>
 * @param {Array<object>} queue records (already sorted oldest-first)
 * @param {object} handlers { onSkip, onPlay, onCardSpeed, cardMenu? } — see
 *        buildQueueRow; an optional cardMenu(rec) is what supplies the "⋯" card
 *        menu's items, and a non-empty return is what renders it
 * @param {(rec:object) => {title?:string,avatarUrl?:string}} resolveChannel the
 *        calling page's channel resolver, threaded straight to buildQueueRow
 *        (see buildChannelBadge)
 * @param {object|null} [more] optional { total, onShowAll } "Show all" footer
 * @param {string} [skipLabel='Skip'] visible label for each row's mark button
 *        ('Remove' on the stash page), threaded straight to buildQueueRow; also
 *        used in its aria-label and title. The btn--skip CLASS never changes —
 *        styles.css and setCardState key off it.
 */
export function renderQueue(listEl, queue, handlers, resolveChannel, more = null, skipLabel = 'Skip') {
  // Any open card menu belongs to a card we are about to discard: close it so
  // its document listeners come off with it and the reference never dangles.
  closeCardMenu();
  clear(listEl);
  for (const rec of queue) {
    listEl.append(buildQueueRow(rec, handlers, resolveChannel, skipLabel));
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
