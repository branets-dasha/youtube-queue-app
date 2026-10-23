// js/comments.js
//
// The now-playing video's comments, loaded ON DEMAND: a "Load comments" button
// under the description, then 20 top-level threads per press with a "Load more
// comments" button while YouTube reports another page, each thread's replies
// behind an "N replies" disclosure: fetched WHOLE on its first open, grouped by
// @mention and sorted by likes (queue.js's nestReplies), then shown from memory
// 20 at a time ("Show more replies"). Shared by both player pages; everything
// page-specific — the section element, the page's authorize() and its error
// router — comes in as a parameter, so this module knows no page.
//
// It owns everything INSIDE the section, the section's visibility included:
// shown while a video is set, hidden (and emptied) when none is. What it does
// NOT own is the hand-off when the whole now-playing region goes — that is the
// page's showPlayerEmpty, whose focus gate must include this section.
//
// STRICT XSS SAFETY, as ui.js: comment text arrives as plain text (api.js asks
// for textFormat=plainText) and only ever reaches the DOM through textContent.

import { ApiError, getCommentThreads, getCommentReplies } from './api.js';
import { REPLY_SHOW_STEP, NESTED_REPLIES_SHOWN } from './config.js';
import { unseenById, repliesComplete, nestReplies } from './queue.js';
import { el, buildAvatar, formatAbsolute, formatRelative, setVisible } from './ui.js';
import { focusFirst } from './page-chrome.js';

// Element ids for the reply panels' aria-controls. A counter rather than the
// thread's own id: nothing about an API string has to be a safe id.
let replyPanelSeq = 0;

/**
 * Bind the comments section.
 * @param {object} opts
 * @param {HTMLElement} opts.container the (initially hidden) section element
 * @param {() => Promise<unknown>} opts.authorize the page's on-demand
 *   authorization, called first thing inside every click that fetches, so the
 *   GIS popup keeps its user-gesture exemption
 * @param {(err:unknown) => void} opts.onError the page's error router
 * @returns {{ setVideo: (videoId:string|null) => void }}
 */
export function initComments({ container, authorize, onError }) {
  // The ladder's last rung (see landAfter): a landing, never a tab stop.
  container.tabIndex = -1;

  // One per video. Every async step checks it is still `current` before it
  // touches the DOM, so a response for a video the player has moved on from is
  // dropped — and its busy flag dies with it, leaving the new video's button live.
  let current = null;

  /**
   * Point the section at `videoId`: the bare "Load comments" button, or hidden
   * and empty for null. The same id again keeps whatever is loaded.
   * @param {string|null} videoId
   */
  function setVideo(videoId) {
    const id = videoId || null;
    if (current && current.videoId === id) return;
    // A new video while focus is in here (auto-advance mid-read): land on the
    // fresh button rather than <body>. With no video the page's own gate takes it.
    const hadFocus = container.contains(document.activeElement);
    current = id ? { videoId: id, busy: false, nextPageToken: null, threads: [], list: null } : null;
    container.replaceChildren();
    setVisible(container, !!id);
    if (!current) return;
    const session = current;
    const btn = el('button', { class: 'btn comments__load', type: 'button', text: 'Load comments' });
    btn.addEventListener('click', () => loadPage(session, btn));
    container.append(btn);
    if (hadFocus) focusFirst(btn);
  }

  /**
   * Fetch the next page into the section. `trigger` is the pressed button —
   * "Load comments" the first time, "Load more comments" after — busy for the
   * flight by aria-disabled, so it keeps focus; `session.busy` is the guard.
   */
  async function loadPage(session, trigger) {
    if (session.busy) return;
    session.busy = true;
    trigger.setAttribute('aria-disabled', 'true');
    let page;
    try {
      await authorize();
      page = await getCommentThreads(session.videoId, session.nextPageToken || undefined);
    } catch (err) {
      session.busy = false;
      trigger.removeAttribute('aria-disabled');
      if (err instanceof ApiError && err.kind === 'commentsDisabled') {
        if (session === current) showMessage(trigger, err.message);
        return;
      }
      onError(err); // auth state is the page's even when the video has moved on
      return;
    }
    session.busy = false;
    trigger.removeAttribute('aria-disabled');
    if (session !== current) return;

    const added = unseenById(session.threads, page.threads);
    session.threads.push(...added);
    session.nextPageToken = page.nextPageToken;

    if (!session.threads.length && !session.nextPageToken) {
      showMessage(trigger, 'No comments yet.');
      return;
    }
    if (!session.list) {
      session.list = el('ol', { class: 'comments__list' });
      trigger.before(session.list);
    }
    const nodes = added.map((t) => buildThread(session, t));
    session.list.append(...nodes);

    if (!session.nextPageToken) {
      landAfter(trigger, nodes[0] && nodes[0].querySelector('.comment'));
      return;
    }
    if (trigger.classList.contains('comments__more')) return; // stays, focus and all
    const more = el('button', { class: 'btn comments__more', type: 'button', text: 'Load more comments' });
    more.addEventListener('click', () => loadPage(session, more));
    trigger.after(more);
    landAfter(trigger, nodes[0] && nodes[0].querySelector('.comment'), more);
  }

  /**
   * Remove `trigger`, first handing its focus (only if it holds it) to the first
   * candidate that takes it — the first comment just loaded, as a rule — with
   * the section itself as the rung that cannot fail.
   */
  function landAfter(trigger, ...candidates) {
    const hadFocus = trigger.contains(document.activeElement);
    if (hadFocus) focusFirst(...candidates, container);
    trigger.remove();
  }

  /** Replace the section's contents after `trigger` with one line of text. */
  function showMessage(trigger, text) {
    const msg = el('p', { class: 'comments__status', tabindex: '-1', text });
    container.append(msg);
    landAfter(trigger, msg);
    for (const node of [...container.children]) if (node !== msg) node.remove();
  }

  /**
   * Expand or collapse one thread's replies. The FIRST expand builds the panel
   * from the whole set — the free replies when they are all of them (no
   * request), else every page fetched while the toggle is busy — because they
   * are ordered by likes, which no partial set can answer. Built once: a
   * collapse and re-expand costs nothing and keeps whatever has been shown.
   *
   * A fetch that fails, or that the player moves on from, builds NOTHING: the
   * pages already fetched are dropped with it (api.js's all-or-nothing), the
   * toggle comes back collapsed and live, the error goes to the page's router,
   * and the next press starts again from page one.
   */
  async function toggleReplies(session, thread) {
    const { toggle, panel } = thread;
    if (toggle.getAttribute('aria-expanded') === 'true') {
      toggle.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      return;
    }
    if (!thread.built) {
      let replies = thread.replies;
      if (!repliesComplete(thread)) {
        if (thread.busy) return;
        thread.busy = true;
        toggle.setAttribute('aria-disabled', 'true');
        try {
          await authorize();
          replies = await getCommentReplies(thread.comment.id);
        } catch (err) {
          onError(err);
          return;
        } finally {
          thread.busy = false;
          toggle.removeAttribute('aria-disabled');
        }
        if (session !== current) return;
      }
      const list = el('ol', { class: 'comments__replies' });
      panel.append(list);
      showInSteps(list, nestReplies(replies, thread.comment.authorName), buildReplyRoot, {
        first: REPLY_SHOW_STEP,
        step: REPLY_SHOW_STEP,
        label: () => 'Show more replies',
        fallback: toggle,
      });
      thread.built = true;
    }
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
  }

  /**
   * One root reply and its sub-thread. A long sub-thread shows its first few
   * and holds the rest behind one "Show N more in this conversation" — every
   * nested reply at once would let a single back-and-forth push the next root
   * a screen away.
   */
  function buildReplyRoot(root) {
    const comment = buildComment(root.reply, true);
    const li = el('li', {}, [comment]);
    if (root.replies.length) {
      const sub = el('ol', { class: 'comments__subreplies' });
      li.append(sub);
      showInSteps(sub, root.replies, (r) => el('li', {}, [buildComment(r, true)]), {
        first: NESTED_REPLIES_SHOWN,
        step: Infinity,
        label: (n) => `Show ${n} more in this conversation`,
        fallback: comment,
        btnClass: 'comments__more-nested',
      });
    }
    return li;
  }

  /**
   * Render `items` into `list` from MEMORY — `first` now, then `step` per press
   * of a button placed after the list — with the Load more focus rules: the
   * button keeps focus while more remain, and when it goes, its focus moves to
   * the first comment the last press showed, else to `fallback`.
   */
  function showInSteps(list, items, render, { first, step, label, fallback, btnClass = '' }) {
    let shown = 0;
    const reveal = (count) => {
      const nodes = items.slice(shown, shown + count).map(render);
      shown += nodes.length;
      list.append(...nodes);
      return nodes;
    };
    reveal(first);
    if (shown >= items.length) return;
    const btn = el('button', {
      class: `comments__text-btn ${btnClass}`.trim(),
      type: 'button',
      text: label(items.length - shown),
    });
    btn.addEventListener('click', () => {
      const nodes = reveal(step);
      if (shown < items.length) {
        btn.textContent = label(items.length - shown);
        return;
      }
      landAfter(btn, nodes[0] && nodes[0].querySelector('.comment'), fallback);
    });
    list.after(btn);
  }

  /** One top-level thread: its comment, then the reply disclosure if any. */
  function buildThread(session, thread) {
    const li = el('li', { class: 'comments__thread' }, [buildComment(thread.comment, true)]);
    const count = Math.max(thread.totalReplyCount, thread.replies.length);
    if (count > 0) {
      const panelId = `comment-replies-${++replyPanelSeq}`;
      thread.panel = el('div', { class: 'comments__replies-panel', id: panelId });
      thread.panel.hidden = true;
      thread.toggle = el('button', {
        class: 'comments__text-btn comments__toggle',
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': panelId,
        text: count === 1 ? '1 reply' : `${count.toLocaleString()} replies`,
      });
      thread.toggle.addEventListener('click', () => toggleReplies(session, thread));
      li.append(el('div', { class: 'comments__thread-tail' }, [thread.toggle, thread.panel]));
    }
    return li;
  }

  return { setVideo };
}

/**
 * One comment: a decorative avatar beside the author, the age, the like count,
 * an "(edited)" mark and the text. The author is plain text, not a link: twenty
 * threads would otherwise add twenty tab stops to a pane read top to bottom.
 * The avatar goes through ui.js's buildAvatar, the same path as every channel
 * avatar: decorative, lazy, and the letter placeholder only when there is no
 * URL or the image fails.
 * @param {{authorName:string, authorAvatarUrl:string, text:string, likeCount:number, publishedAt:string, edited:boolean}} c
 * @param {boolean} [landing] a focus LANDING (tabindex -1), never a tab stop:
 *   what focus moves to when the button that loaded it goes away
 * @returns {HTMLElement}
 */
function buildComment(c, landing = false) {
  const head = [el('span', { class: 'comment__author', text: c.authorName })];
  const dot = () => [' ', el('span', { class: 'comment__dot', 'aria-hidden': 'true', text: '·' }), ' '];
  if (c.publishedAt) {
    head.push(
      ...dot(),
      el('time', {
        datetime: c.publishedAt,
        title: formatAbsolute(c.publishedAt),
        text: formatRelative(c.publishedAt),
      })
    );
  }
  if (c.likeCount > 0) {
    head.push(...dot(), c.likeCount === 1 ? '1 like' : `${c.likeCount.toLocaleString()} likes`);
  }
  if (c.edited) head.push(...dot(), 'edited');

  return el('div', { class: 'comment', tabindex: landing ? '-1' : null }, [
    // The leading @ is the handle's, not the name's: the letter placeholder skips it.
    buildAvatar({ title: c.authorName.replace(/^@/, ''), avatarUrl: c.authorAvatarUrl }),
    el('div', { class: 'comment__body' }, [
      el('p', { class: 'comment__head' }, head),
      el('p', { class: 'comment__text', text: c.text }),
    ]),
  ]);
}
