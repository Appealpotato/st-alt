/**
 * Command palette — Ctrl+K global search overlay.
 *
 * Usage (in app.js):
 *   import { initCommandPalette } from './lib/commandPalette.js';
 *   const palette = initCommandPalette(State, searchInstance);
 *   // palette.open() / palette.close() for programmatic control
 */
export function initCommandPalette(State, search, { asyncSearch } = {}) {
  // ── Build DOM ────────────────────────────────────────────────────────────

  const overlay = document.createElement('div');
  overlay.className = 'cp-overlay cp-overlay--hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const box = document.createElement('div');
  box.className = 'cp-box';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'cp-input-wrap';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cp-input';
  input.placeholder = 'Search characters, chats, actions…';
  input.setAttribute('autocomplete', 'off');

  inputWrap.appendChild(input);

  const results = document.createElement('div');
  results.className = 'cp-results';

  box.appendChild(inputWrap);
  box.appendChild(results);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // ── State ─────────────────────────────────────────────────────────────────

  let _open        = false;
  let _focusedIdx  = -1;
  let _flatItems   = [];  // flat list of result items for keyboard nav

  // ── Recent selections ─────────────────────────────────────────────────────

  const RECENT_KEY = 'cp-recent';
  const RECENT_MAX = 5;

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? []; } catch { return []; }
  }

  function pushRecent(item) {
    if (!item.id) return;
    const list = getRecent().filter(id => id !== item.id);
    list.unshift(item.id);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  }

  function selectItem(item) {
    pushRecent(item);
    item.action?.();
    close();
  }

  // ── Render results ────────────────────────────────────────────────────────

  function renderResults(term) {
    const groups = search.query(term);
    _flatItems = [];
    _focusedIdx = -1;
    results.innerHTML = '';

    // On empty query, inject a "Recent" group from recently selected items
    if (!term.trim() && groups.length > 0) {
      const recentIds = getRecent();
      if (recentIds.length > 0) {
        const allItems = groups.flatMap(g => g.items);
        const recentItems = recentIds
          .map(id => allItems.find(it => it.id === id))
          .filter(Boolean);
        if (recentItems.length > 0) {
          groups.unshift({ category: 'Recent', items: recentItems });
        }
      }
    }

    if (groups.length === 0) {
      results.innerHTML = `<div class="cp-empty">${term ? 'No results' : 'Start typing to search…'}</div>`;
      return;
    }



    for (const group of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'cp-group';

      const label = document.createElement('div');
      label.className = 'cp-group-label';
      label.textContent = group.category;
      groupEl.appendChild(label);

      for (const item of group.items) {
        const itemEl = document.createElement('div');
        itemEl.className = 'cp-item';
        itemEl.dataset.idx = _flatItems.length;

        if (item.icon) {
          const img = document.createElement('img');
          img.src = item.icon;
          img.className = 'cp-item-icon';
          img.alt = '';
          itemEl.appendChild(img);
        } else {
          const dot = document.createElement('span');
          dot.className = 'cp-item-dot';
          dot.textContent = '◉';
          itemEl.appendChild(dot);
        }

        const textWrap = document.createElement('span');
        textWrap.className = 'cp-item-text';
        textWrap.innerHTML = `<span class="cp-item-label">${esc(item.label)}</span>`;
        if (item.sublabel) {
          textWrap.innerHTML += ` <span class="cp-item-sublabel">${esc(item.sublabel)}</span>`;
        }
        itemEl.appendChild(textWrap);

        itemEl.addEventListener('mouseenter', () => setFocus(parseInt(itemEl.dataset.idx, 10)));
        itemEl.addEventListener('click', () => selectItem(item));

        groupEl.appendChild(itemEl);
        _flatItems.push({ el: itemEl, item });
      }

      results.appendChild(groupEl);
    }

    // Auto-select first result
    setFocus(0);
  }

  function setFocus(idx) {
    if (_focusedIdx >= 0 && _flatItems[_focusedIdx]) {
      _flatItems[_focusedIdx].el.classList.remove('cp-item--focused');
    }
    _focusedIdx = Math.max(-1, Math.min(idx, _flatItems.length - 1));
    if (_focusedIdx >= 0 && _flatItems[_focusedIdx]) {
      _flatItems[_focusedIdx].el.classList.add('cp-item--focused');
      _flatItems[_focusedIdx].el.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function open() {
    if (_open) return;
    _open = true;
    overlay.classList.remove('cp-overlay--hidden');
    requestAnimationFrame(() => overlay.classList.add('cp-overlay--visible'));
    input.value = '';
    renderResults('');
    input.focus();
  }

  function close() {
    if (!_open) return;
    _open = false;
    overlay.classList.remove('cp-overlay--visible');
    overlay.addEventListener('transitionend', () => {
      overlay.classList.add('cp-overlay--hidden');
    }, { once: true });
    input.blur();
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  let _asyncTimer = null;
  let _asyncId = 0;

  function scheduleAsync(term) {
    clearTimeout(_asyncTimer);
    if (!asyncSearch || !term.trim() || term.length < 2) return;
    const id = ++_asyncId;
    _asyncTimer = setTimeout(async () => {
      const items = await asyncSearch(term);
      if (id !== _asyncId || !_open) return; // stale
      if (!items?.length) return;
      const groupEl = document.createElement('div');
      groupEl.className = 'cp-group';
      const label = document.createElement('div');
      label.className = 'cp-group-label';
      label.textContent = 'Messages';
      groupEl.appendChild(label);
      for (const item of items) {
        const itemEl = document.createElement('div');
        itemEl.className = 'cp-item';
        itemEl.dataset.idx = _flatItems.length;
        const dot = document.createElement('span');
        dot.className = 'cp-item-dot';
        dot.textContent = item.role === 'user' ? '👤' : '🤖';
        itemEl.appendChild(dot);
        const textWrap = document.createElement('span');
        textWrap.className = 'cp-item-text';
        textWrap.innerHTML = `<span class="cp-item-label">${esc(item.label)}</span>`;
        if (item.sublabel) textWrap.innerHTML += ` <span class="cp-item-sublabel">${esc(item.sublabel)}</span>`;
        itemEl.appendChild(textWrap);
        itemEl.addEventListener('mouseenter', () => setFocus(parseInt(itemEl.dataset.idx, 10)));
        itemEl.addEventListener('click', () => selectItem(item));
        groupEl.appendChild(itemEl);
        _flatItems.push({ el: itemEl, item });
      }
      results.appendChild(groupEl);
    }, 300);
  }

  input.addEventListener('input', () => { renderResults(input.value); scheduleAsync(input.value); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocus(_focusedIdx + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocus(_focusedIdx - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_focusedIdx >= 0 && _flatItems[_focusedIdx]) {
        selectItem(_flatItems[_focusedIdx].item);
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });

  // Close on backdrop click (not on box click)
  overlay.addEventListener('click', (e) => {
    if (!box.contains(e.target)) close();
  });

  // Global Ctrl+K / Cmd+K
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      _open ? close() : open();
    }
  });

  return { open, close };
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
