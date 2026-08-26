// js/player.js
//
// Thin wrapper around the YouTube IFrame Player API. It loads the API script
// asynchronously, creates a single YT.Player in the right pane, and exposes a
// small imperative API. It holds NO queue/app state — auto-mark, next-eligible
// selection, titles, etc. live in the page modules that embed it and are wired
// in via callbacks.
//
// The one exception to "no DOM policy" is detachIframeFromTabOrder() below: the
// iframe is created here and nowhere else, so keeping it out of the tab order
// belongs beside its creation. Read its comment before touching focus behavior.

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

let player = null; // YT.Player instance (once created)
let ready = false; // true once the player's onReady has fired
let currentVideoId = null; // id of the video currently loaded
let currentSpeed = 1; // playback speed, re-applied on each new video
let pending = null; // { videoId, startSeconds } requested before the player was ready
let handlers = {}; // { onEnded(videoId), onReady(), onProgress(videoId, seconds) }
let progressTimer = null; // interval polling getCurrentTime() while playing
let justEnded = false; // set on ENDED so switching away won't re-capture end-time

function loadApiScript() {
  if (window.YT && window.YT.Player) return; // already available
  if (document.getElementById('yt-iframe-api')) return; // already requested
  const tag = document.createElement('script');
  tag.id = 'yt-iframe-api';
  tag.src = IFRAME_API_SRC;
  document.head.appendChild(tag);
}

/**
 * Initialize the player ONCE. Loads the IFrame API (if needed) and creates a
 * YT.Player in the element with id `mountId` (sized 16:9 responsively by CSS).
 * @param {{ mountId:string, onEnded?:(videoId:string)=>void, onReady?:()=>void,
 *          onProgress?:(videoId:string, seconds:number)=>void }} opts
 */
export function initPlayer({ mountId, onEnded, onReady, onProgress }) {
  if (player) return;
  handlers = { onEnded, onReady, onProgress };
  // The IFrame API invokes this global once it finishes loading. Chain any
  // previously-registered callback so we do not clobber it.
  const prev = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = () => {
    if (typeof prev === 'function') prev();
    createPlayer(mountId);
  };
  if (window.YT && window.YT.Player) createPlayer(mountId);
  else loadApiScript();
}

/**
 * Keep the player iframe OUT of the sequential tab order. It lives here because
 * this module CREATES the element and is the only one that knows when it exists.
 *
 * Tab from anywhere inside the player pane continues into this frame;
 * bindIframeFocusGuard blurs it back to <body>, but Chrome's sequential-focus
 * starting point STAYS on the iframe, so the next Tab re-enters and bounces
 * again — a loop that kills forward Tab for the rest of the session and strands
 * every control after the frame.
 *
 * Deliberate cost: YouTube's own in-frame controls are no longer Tab-reachable,
 * and that is not to be "fixed" — a focused cross-origin frame swallows keydown
 * and takes the app's whole keyboard layer with it, so the guard would bounce
 * focus out anyway. A CLICK still focuses the frame (tabindex governs sequential
 * navigation only), so bindIframeFocusGuard is still necessary.
 */
function detachIframeFromTabOrder() {
  const iframe = getIframe();
  if (iframe) iframe.tabIndex = -1;
}

function createPlayer(mountId) {
  if (player || !window.YT || !window.YT.Player) return;
  const mount = document.getElementById(mountId);
  if (!mount) return;
  player = new window.YT.Player(mountId, {
    width: '100%',
    height: '100%',
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        ready = true;
        // Again on ready, covering any swap the API makes before it. Nothing
        // AFTER ready can replace the frame — loadVideoById postMessages into
        // the existing one, initPlayer/createPlayer early-return once `player`
        // is set, destroy() is never called — so these two sites are the whole
        // lifecycle and no observer is warranted.
        detachIframeFromTabOrder();
        applySpeed();
        if (pending) {
          const p = pending;
          pending = null;
          doLoad(p.videoId, p.startSeconds);
        }
        if (typeof handlers.onReady === 'function') handlers.onReady();
      },
      onStateChange: (e) => {
        const YT = window.YT;
        if (e.data === YT.PlayerState.PLAYING) {
          justEnded = false;
          startProgressPoll(); // poll getCurrentTime() ~every 5s while playing
        } else if (e.data === YT.PlayerState.PAUSED) {
          captureProgress();
          stopProgressPoll();
        } else if (e.data === YT.PlayerState.ENDED) {
          justEnded = true;
          stopProgressPoll();
          // ENDED === 0. Report the video that just finished (currentVideoId).
          if (typeof handlers.onEnded === 'function') handlers.onEnded(currentVideoId);
        }
      },
    },
  });
  // The YT.Player constructor replaces the mount <div> with its <iframe>
  // synchronously, so the element is already here — no need to wait for onReady,
  // which fires only once the frame has actually loaded.
  detachIframeFromTabOrder();
}

function doLoad(videoId, startSeconds = 0) {
  // Capture the OUTGOING video's position before switching away — UNLESS it just
  // ended (its position was reset; capturing would re-store the end-time).
  if (currentVideoId && currentVideoId !== videoId && !justEnded) captureProgress();
  justEnded = false;
  stopProgressPoll();
  currentVideoId = videoId;
  try {
    // Object form supports startSeconds (resume). Attempts autoplay; a browser
    // that blocks it simply loads the video paused (an acceptable fallback). The
    // session begins from a user gesture (Play).
    player.loadVideoById(startSeconds > 0 ? { videoId, startSeconds } : { videoId });
    applySpeed();
  } catch {
    /* ignore transient player errors */
  }
}

/**
 * Load + play a video by id, optionally resuming at `startSeconds`. If the
 * player is not ready yet, the request is queued and run on ready.
 * @param {string} videoId
 * @param {number} [startSeconds=0]
 */
export function loadVideo(videoId, startSeconds = 0) {
  if (!videoId) return;
  if (!ready || !player) {
    pending = { videoId, startSeconds };
    currentVideoId = videoId;
    return;
  }
  doLoad(videoId, startSeconds);
}

// --- Watch-progress tracking ---------------------------------------------

function captureProgress() {
  if (!player || !currentVideoId || typeof player.getCurrentTime !== 'function') return;
  let t = 0;
  try {
    t = player.getCurrentTime() || 0;
  } catch {
    t = 0;
  }
  if (typeof handlers.onProgress === 'function') handlers.onProgress(currentVideoId, t);
}
function startProgressPoll() {
  stopProgressPoll();
  progressTimer = setInterval(captureProgress, 5000);
}
function stopProgressPoll() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

/** Force a progress capture NOW (e.g. on page hide / unload). */
export function capturePosition() {
  captureProgress();
}

function applySpeed() {
  try {
    // setPlaybackRate is the YouTube IFrame Player API's own method name — keep it.
    if (player && player.setPlaybackRate) player.setPlaybackRate(currentSpeed);
  } catch {
    /* ignore */
  }
}

/** Set the playback speed; persists across subsequent in-session video loads. */
export function setSpeed(speed) {
  currentSpeed = speed;
  applySpeed();
}

export function getSpeed() {
  return currentSpeed;
}

export function getCurrentVideoId() {
  return currentVideoId;
}

export function isReady() {
  return ready;
}

/**
 * The <iframe> element YT.Player created, or null if the player isn't up yet.
 * Two consumers: page-chrome.js's bindIframeFocusGuard, which undoes focus
 * moving into the cross-origin frame (it would otherwise swallow the page's
 * document-level keyboard shortcuts), and detachIframeFromTabOrder() above.
 * @returns {HTMLIFrameElement|null}
 */
export function getIframe() {
  if (!player || typeof player.getIframe !== 'function') return null;
  try {
    return player.getIframe();
  } catch {
    return null;
  }
}

// --- Imperative playback controls (thin wrappers over the IFrame Player API) ---

/** Toggle play/pause of the current video. No-op until the player exists. */
export function togglePlay() {
  if (!player || typeof player.getPlayerState !== 'function') return;
  try {
    if (player.getPlayerState() === window.YT.PlayerState.PLAYING) player.pauseVideo();
    else player.playVideo();
  } catch {
    /* ignore */
  }
}

/** Seek the current video by `deltaSeconds` (clamped at 0). */
export function seekBy(deltaSeconds) {
  if (!player || typeof player.seekTo !== 'function') return;
  try {
    const t = (player.getCurrentTime() || 0) + deltaSeconds;
    player.seekTo(Math.max(0, t), true);
  } catch {
    /* ignore */
  }
}

/** Seek the current video to an absolute position `seconds` (clamped at 0). */
export function seekTo(seconds) {
  if (!player || typeof player.seekTo !== 'function') return;
  try {
    player.seekTo(Math.max(0, seconds), true);
  } catch {
    /* ignore */
  }
}

/** Toggle mute. */
export function toggleMute() {
  if (!player || typeof player.isMuted !== 'function') return;
  try {
    if (player.isMuted()) player.unMute();
    else player.mute();
  } catch {
    /* ignore */
  }
}

/** Request fullscreen on the player iframe (guard: player must exist). */
export function requestFullscreen() {
  if (!player || typeof player.getIframe !== 'function') return;
  try {
    const iframe = player.getIframe();
    if (iframe && iframe.requestFullscreen) iframe.requestFullscreen();
  } catch {
    /* ignore */
  }
}
