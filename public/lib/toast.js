import { icon, X } from './icons.js';

let container = null;
const active = new Set();
const MAX_TOASTS = 5;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

function dismiss(el) {
  if (!active.has(el)) return;
  active.delete(el);
  el.classList.add('toast--exit');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 200); // fallback
}

/**
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 * @param {{ duration?: number, action?: { label: string, onClick: () => void } }} options
 */
export function showToast(message, type = 'info', options = {}) {
  const { duration = 4000, action } = options;
  ensureContainer();

  // Evict oldest if at cap
  if (active.size >= MAX_TOASTS) {
    const oldest = active.values().next().value;
    dismiss(oldest);
  }

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => { dismiss(el); action.onClick(); });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.appendChild(icon(X, 14));
  close.addEventListener('click', () => dismiss(el));
  el.appendChild(close);

  container.appendChild(el);
  active.add(el);

  // Trigger entry animation
  requestAnimationFrame(() => el.classList.add('toast--visible'));

  if (duration > 0) {
    setTimeout(() => dismiss(el), duration);
  }
}
