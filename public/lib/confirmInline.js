import { icon, Check, X } from './icons.js';

/**
 * Replaces `btn` content with ✓/✗ confirm buttons in-place.
 * Clicking ✓ calls onConfirm(). Clicking ✗ (or after 3s) restores the button.
 *
 * @param {HTMLElement} btn        - The button to swap
 * @param {Function}    onConfirm  - Called when the user confirms
 * @param {Function}   [onCancel]  - Called when the user cancels or timeout expires
 */
export function confirmInline(btn, onConfirm, onCancel) {
  const savedHTML    = btn.innerHTML;
  const savedTitle   = btn.title;
  const savedClasses = [...btn.classList];

  let timer;

  function restore(cancelled = false) {
    clearTimeout(timer);
    btn.innerHTML = savedHTML;
    btn.title     = savedTitle;
    btn.className = savedClasses.join(' ');
    btn.onclick   = null;
    if (cancelled && onCancel) onCancel();
  }

  // Build ✓ and ✗ as sibling spans inside the button
  btn.innerHTML = '';
  btn.title     = '';

  const confirmSpan = document.createElement('span');
  confirmSpan.className = 'ci-confirm';
  confirmSpan.appendChild(icon(Check, 14));

  const cancelSpan = document.createElement('span');
  cancelSpan.className = 'ci-cancel';
  cancelSpan.appendChild(icon(X, 14));

  btn.appendChild(confirmSpan);
  btn.appendChild(cancelSpan);
  btn.classList.add('ci-pending');

  confirmSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    restore();
    onConfirm();
  });

  cancelSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    restore(true);
  });

  // Prevent the original button click handler from firing while pending
  btn.onclick = (e) => e.stopPropagation();

  timer = setTimeout(() => restore(true), 3000);
}
