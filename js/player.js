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
let handlers = {}; // { onEnded(videoId), onReady(), onProgress(videoId, seconds), onError(videoId) }
let progressTimer = null; // interval polling getCurrentTime() while playing
// True only once the CURRENT load has reached PLAYING. getCurrentTime() answers
// 0 in every error, unstarted, cued and loading state, so a capture outside this
// window — the poll outliving an error, the page-hide flush of the very reload
// that recovers from one — would overwrite the stored resume position with 0.
let positionTrusted = false;

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
 *          onProgress?:(videoId:string, seconds:number)=>void,
 *          onError?:(videoId:string)=>void }} opts
 */
export function initPlayer({ mountId, onEnded, onReady, onProgress, onError }) {
  if (player) return;
  handlers = { onEnded, onReady, onProgress, onError };
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
 * Tab from anywhere inside the player pane would continue into this frame, and
 * a frame that holds focus takes the app's whole keyboard layer with it. The
 * guard alone cannot do this job: it takes focus back out after the fact, and a
 * bounce on every Tab is no tab order — worse, a bounce that left focus on
 * <body> left Chrome's sequential-focus starting point on the iframe, so the
 * next Tab re-entered and bounced again, a loop that killed forward Tab for the
 * rest of the session and stranded every control after the frame.
 *
 * So the frame is not Tab-reachable ON THE WAY IN, and that stays: a focused
 * cross-origin frame swallows keydown and takes the app's whole keyboard layer
 * with it. The one keyboard door is the '\' key, page-chrome's `focusFrame`,
 * which the guard lets stand — YouTube's own controls (captions, audio tracks,
 * quality) exist nowhere else — and Shift+Tab is the way back out. A CLICK
 * still focuses the frame (tabindex governs sequential navigation only), so
 * bindIframeFocusGuard is still necessary.
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
          positionTrusted = true;
          startProgressPoll(); // poll getCurrentTime() ~every 5s while playing
        } else if (e.data === YT.PlayerState.PAUSED) {
          captureProgress();
          stopProgressPoll();
        } else if (e.data === YT.PlayerState.ENDED) {
          // The page resets a finished video's position; a later capture (the
          // switch to the next video) would re-store the end time over it.
          distrustPosition();
          // ENDED === 0. Report the video that just finished (currentVideoId).
          if (typeof handlers.onEnded === 'function') handlers.onEnded(currentVideoId);
        } else if (
          e.data === YT.PlayerState.UNSTARTED ||
          e.data === YT.PlayerState.CUED
        ) {
          distrustPosition();
        }
      },
      onError: () => {
        distrustPosition();
        // Reported whatever the code: the codes say little reliable about cause
        // (a missing id reports 150 in an embed, not 100).
        if (currentVideoId && typeof handlers.onError === 'function') handlers.onError(currentVideoId);
      },
    },
  });
  // The YT.Player constructor replaces the mount <div> with its <iframe>
  // synchronously, so the element is already here — no need to wait for onReady,
  // which fires only once the frame has actually loaded.
  detachIframeFromTabOrder();
}

function doLoad(videoId, startSeconds = 0) {
  // Capture the OUTGOING video's position before switching away. Distrusting
  // after it also covers the PAUSED a load-while-playing fires, which already
  // reads 0 and already names the INCOMING video.
  if (currentVideoId && currentVideoId !== videoId) captureProgress();
  distrustPosition();
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
    distrustPosition();
    pending = { videoId, startSeconds };
    currentVideoId = videoId;
    return;
  }
  doLoad(videoId, startSeconds);
}

// --- Watch-progress tracking ---------------------------------------------

function captureProgress() {
  if (!positionTrusted || !player || !currentVideoId) return;
  if (typeof player.getCurrentTime !== 'function') return;
  let t = 0;
  try {
    t = player.getCurrentTime();
  } catch {
    return;
  }
  // Never a 0 either: a failure that reports no state change still reads 0, and
  // resumeStart treats anything this low as "from the start" anyway.
  if (!(t > 0)) return;
  if (typeof handlers.onProgress === 'function') handlers.onProgress(currentVideoId, t);
}
function distrustPosition() {
  positionTrusted = false;
  stopProgressPoll();
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

/**
 * Stop playback outright and forget what was loaded — for the moments the page
 * tears the now-playing region down (the queue ran out) while the video is still
 * running: the empty-state overlay covers the frame opaquely, so an un-stopped
 * video is invisible but fully audible.
 *
 * Distrust the position BEFORE stopping, so nothing after this — the poll, the
 * PAUSED or stop event, a page-hide flush — re-persists a time over the position
 * the caller just reset; clearing currentVideoId makes any late capture a no-op
 * as well. Clearing `pending` covers a load queued before ready, which onReady
 * would otherwise run after this.
 */
export function stopPlayback() {
  distrustPosition();
  currentVideoId = null;
  pending = null;
  if (!player || typeof player.stopVideo !== 'function') return;
  try {
    player.stopVideo();
  } catch {
    /* ignore */
  }
}

/**
 * Seek the current video by `deltaSeconds` (clamped at 0). Inert until this
 * load has played: before that getCurrentTime() reads 0, so a seek "forward"
 * from a resume point would jump back to the start.
 */
export function seekBy(deltaSeconds) {
  if (!positionTrusted || !player || typeof player.seekTo !== 'function') return;
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
