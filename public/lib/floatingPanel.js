/**
 * createFloatingPanel — reusable overlay that covers #chat-area.
 *
 * Usage:
 *   const panel = createFloatingPanel({ width: '700px', title: 'Characters', onClose });
 *   panel.open();
 *   panel.setContent(domNode);                   // or (container => { ... })
 *   panel.setTitle('← Chasity', onBackFn);       // back button if onBack provided
 *   panel.close();
 *   panel.destroy();
 */
import { icon, X, ChevronLeft } from './icons.js';

export function createFloatingPanel({ width = '640px', title = '', onClose } = {}) {
  // ── Build DOM ──────────────────────────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.className = 'fp-overlay fp-overlay--hidden';

  const box = document.createElement('div');
  box.className = 'fp-box';
  box.style.maxWidth = width;

  const header = document.createElement('div');
  header.className = 'fp-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'fp-back btn-ghost hidden';
  backBtn.appendChild(icon(ChevronLeft, 16));
  backBtn.title = 'Back';

  const titleEl = document.createElement('span');
  titleEl.className = 'fp-title';
  titleEl.textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'fp-close btn-ghost';
  closeBtn.appendChild(icon(X, 16));
  closeBtn.title = 'Close';

  header.appendChild(backBtn);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  const content = document.createElement('div');
  content.className = 'fp-content';

  box.appendChild(header);
  box.appendChild(content);
  overlay.appendChild(box);

  const chatArea = document.getElementById('chat-area');
  chatArea.appendChild(overlay);

  // ── State ─────────────────────────────────────────────────────────────────

  let _backHandler = null;
  let _escHandler  = null;
  let _open        = false;

  // ── Internal helpers ──────────────────────────────────────────────────────

  function _removeEsc() {
    if (_escHandler) {
      document.removeEventListener('keydown', _escHandler);
      _escHandler = null;
    }
  }

  function _addEsc() {
    _removeEsc();
    _escHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', _escHandler);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function open() {
    if (_open) return;
    _open = true;
    overlay.classList.remove('fp-overlay--hidden');
    // Trigger entrance animation on next frame
    requestAnimationFrame(() => overlay.classList.add('fp-overlay--visible'));
    _addEsc();
  }

  function close() {
    if (!_open) return;
    _open = false;
    overlay.classList.remove('fp-overlay--visible');
    _removeEsc();
    // Wait for transition then hide; fallback timeout guards against transitionend not firing (mobile).
    // Filter bubbled child transitionends and bail if the user reopened in the meantime.
    const hide = (e) => {
      if (e && e.target !== overlay) return;
      if (_open) return;
      overlay.classList.add('fp-overlay--hidden');
    };
    overlay.addEventListener('transitionend', hide, { once: true });
    setTimeout(() => hide(null), 150);
    onClose?.();
  }

  function destroy() {
    _removeEsc();
    overlay.remove();
  }

  /** setContent(nodeOrFn)
   *  - Pass a DOM node: it is appended to the content area.
   *  - Pass a function: called with the content container; function builds DOM inside it.
   */
  function setContent(nodeOrFn) {
    content.innerHTML = '';
    if (typeof nodeOrFn === 'function') {
      nodeOrFn(content);
    } else if (nodeOrFn instanceof Node) {
      content.appendChild(nodeOrFn);
    }
  }

  /** setTitle(str, onBack?)
   *  If onBack is provided, shows ← button wired to it (replaces previous).
   *  If onBack is null/omitted, hides ← button.
   */
  function setTitle(str, onBack) {
    titleEl.textContent = str;
    // Tear down previous back listener
    if (_backHandler) {
      backBtn.removeEventListener('click', _backHandler);
      _backHandler = null;
    }
    if (typeof onBack === 'function') {
      _backHandler = onBack;
      backBtn.addEventListener('click', _backHandler);
      backBtn.classList.remove('hidden');
    } else {
      backBtn.classList.add('hidden');
    }
  }

  // Wire close button
  closeBtn.addEventListener('click', close);

  return { open, close, destroy, setContent, setTitle, el: overlay };
}
