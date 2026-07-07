// js/toast.js
//
// Fixed top-right toast notifications. XSS-SAFE: message text is only ever set
// via textContent (never innerHTML). showToast returns a small handle so a
// single toast can be updated in place (e.g. refresh progress) and dismissed.

let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toasts';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Show a toast in the top-right stack.
 * Defaults: progress = sticky (no auto-dismiss), error = 8s + dismiss button,
 * info/success = 4s.
 * @param {string} message
 * @param {{type?:'info'|'success'|'error'|'progress', duration?:number, dismissible?:boolean}} [opts]
 * @returns {{ update:(msg:string,o?:object)=>void, dismiss:()=>void, el:HTMLElement }}
 */
export function showToast(message, opts = {}) {
  const type = opts.type || 'info';
  const dismissible = opts.dismissible != null ? opts.dismissible : type === 'error';
  const defaultDuration = type === 'progress' ? 0 : type === 'error' ? 8000 : 4000;
  const duration = opts.duration != null ? opts.duration : defaultDuration;

  const root = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const textEl = document.createElement('span');
  textEl.className = 'toast__text';
  textEl.textContent = message; // safe: never innerHTML
  toast.appendChild(textEl);

  let timer = null;
  const dismiss = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    toast.remove();
  };
  const arm = (d) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (d > 0) timer = setTimeout(dismiss, d);
  };

  if (dismissible) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×'; // ×
    close.addEventListener('click', dismiss);
    toast.appendChild(close);
  }

  root.appendChild(toast);
  arm(duration);

  return {
    update(msg, o = {}) {
      textEl.textContent = msg; // safe
      if (o.type) {
        toast.className = `toast toast--${o.type}`;
        toast.setAttribute('role', o.type === 'error' ? 'alert' : 'status');
      }
      arm(o.duration != null ? o.duration : duration);
    },
    dismiss,
    el: toast,
  };
}
