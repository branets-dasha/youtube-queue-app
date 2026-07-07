// js/player.js
//
// Thin wrapper around the YouTube IFrame Player API. It loads the API script
// asynchronously, creates a single YT.Player in the right pane, and exposes a
// small imperative API. It holds NO queue/app state — auto-mark, next-eligible
// selection, titles, etc. live in app.js and are wired in via callbacks.

const IFRAME_API_SRC = 'https://www.youtube.com/iframe_api';

let player = null; // YT.Player instance (once created)
let ready = false; // true once the player's onReady has fired
let currentVideoId = null; // id of the video currently loaded
let currentRate = 1; // playback rate, re-applied on each new video
let pending = null; // a videoId requested before the player was ready
let handlers = {}; // { onEnded(videoId), onReady() }

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
 * @param {{ mountId:string, onEnded?:(videoId:string)=>void, onReady?:()=>void }} opts
 */
export function initPlayer({ mountId, onEnded, onReady }) {
  if (player) return;
  handlers = { onEnded, onReady };
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
        applyRate();
        if (pending) {
          const id = pending;
          pending = null;
          doLoad(id);
        }
        if (typeof handlers.onReady === 'function') handlers.onReady();
      },
      onStateChange: (e) => {
        // ENDED === 0. Report the video that just finished (currentVideoId).
        if (
          e.data === window.YT.PlayerState.ENDED &&
          typeof handlers.onEnded === 'function'
        ) {
          handlers.onEnded(currentVideoId);
        }
      },
    },
  });
}

function doLoad(videoId) {
  currentVideoId = videoId;
  try {
    // Attempts autoplay; a browser that blocks it simply loads the video paused
    // (an acceptable fallback). The session begins from a user gesture (Play).
    player.loadVideoById(videoId);
    applyRate();
  } catch {
    /* ignore transient player errors */
  }
}

/**
 * Load + play a video by id. If the player is not ready yet, the request is
 * queued and run on ready.
 * @param {string} videoId
 */
export function loadVideo(videoId) {
  if (!videoId) return;
  if (!ready || !player) {
    pending = videoId;
    currentVideoId = videoId;
    return;
  }
  doLoad(videoId);
}

function applyRate() {
  try {
    if (player && player.setPlaybackRate) player.setPlaybackRate(currentRate);
  } catch {
    /* ignore */
  }
}

/** Set the playback rate; persists across subsequent in-session video loads. */
export function setRate(rate) {
  currentRate = rate;
  applyRate();
}

export function getRate() {
  return currentRate;
}

export function getCurrentVideoId() {
  return currentVideoId;
}

export function isReady() {
  return ready;
}
