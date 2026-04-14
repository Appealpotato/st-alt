/**
 * Drag-to-resize for the right panel.
 * Handle sits between chat area and panel; dragging changes width.
 * Magnetic snap at the default width (400px) — pulls within 20px, must drag past to break free.
 */

const DEFAULT_WIDTH = 400;
const SNAP_RANGE    = 20;
const MIN_WIDTH     = 300;
const MAX_WIDTH     = 700;
const STORAGE_KEY   = 'panelWidth';

/** Returns saved panel width or DEFAULT_WIDTH */
export function getSavedPanelWidth() {
  const v = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  return (v && v !== DEFAULT_WIDTH) ? v : null;
}

/**
 * Apply saved width to the panel (call when panel opens).
 * Remove inline width (call when panel closes) so CSS width:0 takes effect.
 */
export function applyPanelWidth(panel, open) {
  if (open) {
    const saved = getSavedPanelWidth();
    if (saved) panel.style.width = saved + 'px';
  } else {
    panel.style.width = '';
  }
}

export function initPanelResize() {
  const panel  = document.getElementById('right-panel');
  const handle = document.querySelector('.panel-resize-handle');
  if (!handle) return;

  let dragging = false;
  let snapped  = false;

  handle.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('open')) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);

    dragging = true;
    snapped  = false;
    panel.classList.add('resizing');
    document.body.classList.add('panel-resizing');

    const onMove = (ev) => {
      if (!dragging) return;
      let w = window.innerWidth - ev.clientX;

      // Magnetic snap logic
      const dist = Math.abs(w - DEFAULT_WIDTH);
      if (snapped) {
        if (dist > SNAP_RANGE) snapped = false;
        else w = DEFAULT_WIDTH;
      } else {
        if (dist <= SNAP_RANGE) { snapped = true; w = DEFAULT_WIDTH; }
      }

      w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
      panel.style.width = w + 'px';
      document.documentElement.style.setProperty('--active-panel-width', w + 'px');
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('resizing');
      document.body.classList.remove('panel-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);

      const final = parseInt(panel.style.width, 10) || DEFAULT_WIDTH;
      document.documentElement.style.setProperty('--active-panel-width', final + 'px');
      if (final === DEFAULT_WIDTH) {
        panel.style.width = '';
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, String(final));
      }
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}
