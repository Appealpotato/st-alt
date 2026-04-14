import {
  getPrompts, addPrompt, updatePrompt, deletePrompt, reorderPrompts,
  getPromptPresets, createPromptPreset, updatePromptPreset, deletePromptPreset,
  setActivePrompt,
} from '../lib/api.js';
import { icon, Pencil, Plus, Copy, Trash2, Check, X, Maximize2 } from '../lib/icons.js';
import { confirmInline } from '../lib/confirmInline.js';
import { countTokens, pickEncoder, getCachedTokens } from '../lib/tokenizer.js';
import { createFloatingPanel } from '../lib/floatingPanel.js';
import { showToast } from '../lib/toast.js';

// ── Shared preset state (global — same presets across all instances) ───────────
let _presets  = [];
let _activeId = null;

// ── Init ──────────────────────────────────────────────────────────────────────
// isPanel: true when called inside a floating panel (hides pop-out button)

export async function init(State, container, { isPanel = false } = {}) {
  // Scoped DOM helper — all queries relative to this container
  const el = id => container.querySelector('#' + id);

  // Per-instance state
  const _tokenCounts = new Map();
  let sortable = null;

  container.innerHTML = `
    <div class="ps-preset-row">
      <select id="pp-preset-select"></select>
      <button id="pp-rename" class="btn-ghost preset-icon-btn" title="Rename preset"></button>
      <button id="pp-new" class="btn-ghost preset-icon-btn" title="New preset"></button>
      <button id="pp-dup" class="btn-ghost preset-icon-btn" title="Duplicate preset"></button>
      <button id="pp-del" class="btn-ghost preset-icon-btn" title="Delete preset"></button>
    </div>
    <div id="pp-rename-row" class="pp-rename-row" style="display:none">
      <input id="pp-preset-name" type="text" class="ps-preset-name" placeholder="Preset name" />
      <button id="pp-rename-save" class="btn-ghost" title="Save"></button>
      <button id="pp-rename-cancel" class="btn-ghost" title="Cancel"></button>
    </div>
    <div class="ps-toolbar">
      <h2>Prompt Stack <span id="ps-token-total" class="ps-token-total ps-token-total--pending">…</span></h2>
      <div class="ps-toolbar-actions">
        <div class="ps-add-wrap">
          <button id="ps-add" class="btn-secondary">+ Add ▾</button>
          <div id="ps-add-menu" class="ps-add-menu" style="display:none">
            <button class="ps-add-item" data-type="entry">Entry</button>
            <div class="ps-add-divider"></div>
            <button class="ps-add-item ps-add-sentinel" data-type="character">Character Card</button>
            <button class="ps-add-item ps-add-sentinel" data-type="persona">Persona Description</button>
          </div>
        </div>
        <label class="btn-secondary" style="cursor:pointer" title="Import a SillyTavern preset JSON">
          Import ST Preset
          <input id="ps-import-file" type="file" accept=".json" style="display:none" />
        </label>
        ${!isPanel ? `<button id="ps-popout" class="btn-ghost preset-icon-btn" title="Pop out to panel"></button>` : ''}
      </div>
    </div>
    <p class="hint" style="margin-bottom:1rem">Entries are sent to the model in order, top to bottom. The <span class="ps-type-badge" style="font-size:0.72rem">character</span> entry expands from the active character card.</p>

    <div id="ps-import-status" class="hint" style="margin-bottom:0.5rem"></div>
    <div id="ps-list"></div>
  `;

  el('pp-rename').appendChild(icon(Pencil, 16));
  el('pp-new').appendChild(icon(Plus, 16));
  el('pp-dup').appendChild(icon(Copy, 16));
  el('pp-del').appendChild(icon(Trash2, 16));
  el('pp-rename-save').appendChild(icon(Check, 16));
  el('pp-rename-cancel').appendChild(icon(X, 16));
  if (!isPanel) el('ps-popout').appendChild(icon(Maximize2, 16));

  // ── Inner helpers (closed over container, el, sortable, _tokenCounts) ────────

  function updateTokenTotal() {
    const totalEl = el('ps-token-total');
    if (!totalEl) return;
    const sum = [..._tokenCounts.values()]
      .filter(v => v.enabled)
      .reduce((acc, v) => acc + v.count, 0);
    totalEl.textContent = sum.toLocaleString() + ' tok';
    totalEl.classList.remove('ps-token-total--pending');
  }

  function scheduleTokenCounts(State) {
    const encoder = pickEncoder(State);
    const totalEl = el('ps-token-total');
    if (totalEl) { totalEl.textContent = '…'; totalEl.classList.add('ps-token-total--pending'); }

    for (const entry of State.prompts) {
      if (entry.type === 'chatHistory') continue;

      const cacheId = entry.type === 'character'
        ? (State.sessionCharacter?.id ?? State.activeCharacterId ?? null)
        : entry.type === 'persona'
          ? (State.sessionPersona?.id ?? State.activePersonaId ?? null)
          : null;

      if (cacheId !== null) {
        const cached = getCachedTokens(cacheId);
        if (cached !== null) {
          _tokenCounts.set(entry.id, { count: cached, enabled: !!entry.enabled });
          const b = container.querySelector(`.ps-token-badge[data-entry-id="${CSS.escape(entry.id)}"]`);
          if (b) { b.textContent = cached.toLocaleString(); b.classList.remove('ps-token-badge--pending'); }
          updateTokenTotal();
          continue;
        }
      }

      const badge = container.querySelector(`.ps-token-badge[data-entry-id="${CSS.escape(entry.id)}"]`);
      if (badge) badge.classList.add('ps-token-badge--pending');
      countTokens(getEntryText(entry, State), encoder).then(count => {
        _tokenCounts.set(entry.id, { count, enabled: !!entry.enabled });
        const b = container.querySelector(`.ps-token-badge[data-entry-id="${CSS.escape(entry.id)}"]`);
        if (b) { b.textContent = count.toLocaleString(); b.classList.remove('ps-token-badge--pending'); }
        updateTokenTotal();
      });
    }
  }

  function openEditor(entry, State) {
    const row = container.querySelector(`.ps-row[data-id="${entry.id}"]`);
    if (!row) return;

    const labelWrap = row.querySelector('.ps-label-wrap');
    const actions   = row.querySelector('.ps-actions');

    const isInChat = entry.injection_position === 1 || (!entry.injection_position && (entry.injection_depth ?? 0) > 0);
    labelWrap.innerHTML = `
      <input class="ps-edit-label" type="text" value="${esc(entry.label)}" placeholder="Label" />
      <div class="ps-edit-meta">
        <select class="ps-edit-role">
          <option value="system"    ${entry.role === 'system'    ? 'selected' : ''}>system</option>
          <option value="user"      ${entry.role === 'user'      ? 'selected' : ''}>user</option>
          <option value="assistant" ${entry.role === 'assistant' ? 'selected' : ''}>assistant</option>
        </select>
        <select class="ps-edit-position" title="Where to insert this entry">
          <option value="0" ${!isInChat ? 'selected' : ''}>Relative</option>
          <option value="1" ${isInChat  ? 'selected' : ''}>In-chat @ Depth</option>
        </select>
        <input class="ps-edit-depth" type="number" min="1" max="99"
          value="${isInChat ? (entry.injection_depth || 4) : 4}"
          style="width:3.2rem;display:${isInChat ? '' : 'none'}"
          title="Messages from the bottom of chat history" />
      </div>
      <textarea class="ps-edit-content" rows="5" placeholder="Prompt content…">${esc(entry.content ?? '')}</textarea>
    `;

    labelWrap.querySelector('.ps-edit-position').addEventListener('change', e => {
      labelWrap.querySelector('.ps-edit-depth').style.display = e.target.value === '1' ? '' : 'none';
    });

    actions.innerHTML = `
      <button class="ps-save-edit btn-ghost" title="Save"></button>
      <button class="ps-cancel-edit btn-ghost" title="Cancel"></button>
    `;
    actions.querySelector('.ps-save-edit').appendChild(icon(Check, 16));
    actions.querySelector('.ps-cancel-edit').appendChild(icon(X, 16));

    actions.querySelector('.ps-save-edit').addEventListener('click', async () => {
      const label              = labelWrap.querySelector('.ps-edit-label').value;
      const role               = labelWrap.querySelector('.ps-edit-role').value;
      const content            = labelWrap.querySelector('.ps-edit-content').value;
      const injection_position = parseInt(labelWrap.querySelector('.ps-edit-position').value, 10);
      const injection_depth    = injection_position === 1
        ? (parseInt(labelWrap.querySelector('.ps-edit-depth').value, 10) || 4)
        : 0;
      await updatePrompt(entry.id, { label, role, content, injection_position, injection_depth });
      Object.assign(entry, { label, role, content, injection_position, injection_depth });
      renderList(State);
    });

    actions.querySelector('.ps-cancel-edit').addEventListener('click', () => renderList(State));
  }

  function renderList(State) {
    const list = el('ps-list');
    list.innerHTML = '';
    _tokenCounts.clear();

    for (const entry of State.prompts) {
      const row = document.createElement('div');
      row.className = 'ps-row' + (entry.enabled ? '' : ' ps-row--disabled');
      row.dataset.id = entry.id;

      const isPersona  = entry.type === 'persona';
      const isSentinel = entry.type === 'character' || entry.type === 'chatHistory' || isPersona;
      const isChar     = entry.type === 'character';
      const isChatHist = entry.type === 'chatHistory';
      const hasDepth   = entry.injection_position === 1 || (!entry.injection_position && (entry.injection_depth ?? 0) > 0);

      function badgeHtml() {
        if (isChar)     return '<span class="ps-type-badge ps-badge--char">character</span>';
        if (isChatHist) return '<span class="ps-type-badge ps-badge--hist">chat history</span>';
        if (isPersona)  return '<span class="ps-type-badge ps-badge--persona">persona</span>';
        const roleBadge = `<span class="ps-role-badge ps-role--${entry.role}">${esc(entry.role)}</span>`;
        const depthBadge = hasDepth
          ? `<span class="ps-depth-badge" title="In-chat @ depth ${entry.injection_depth}">@${entry.injection_depth}</span>`
          : '';
        return roleBadge + depthBadge;
      }

      const tokenBadgeHtml = isChatHist
        ? `<span class="ps-token-badge ps-token-badge--na" data-entry-id="${esc(entry.id)}">—</span>`
        : `<span class="ps-token-badge ps-token-badge--pending${entry.enabled ? '' : ' ps-token-badge--disabled'}" data-entry-id="${esc(entry.id)}">…</span>`;

      row.innerHTML = `
        <span class="ps-drag-handle" title="Drag to reorder">⠿</span>
        <label class="ps-toggle">
          <input type="checkbox" class="ps-enabled" ${entry.enabled ? 'checked' : ''} />
        </label>
        <div class="ps-label-wrap">
          <span class="ps-label">${esc(entry.label)}</span>
          ${badgeHtml()}
        </div>
        ${tokenBadgeHtml}
        <div class="ps-actions">
          ${!isSentinel ? `<button class="ps-edit btn-ghost" title="Edit"></button>` : ''}
          ${(!isSentinel || isChar) ? `<button class="ps-delete btn-ghost" title="Delete"></button>` : ''}
        </div>
      `;

      row.querySelector('.ps-edit')?.appendChild(icon(Pencil, 16));
      row.querySelector('.ps-delete')?.appendChild(icon(Trash2, 16));

      if (!isChatHist) {
        row.querySelector('.ps-enabled').addEventListener('change', async (e) => {
          const enabled = e.target.checked;
          row.classList.toggle('ps-row--disabled', !enabled);
          await updatePrompt(entry.id, { enabled });
          entry.enabled = enabled;
          const cached = _tokenCounts.get(entry.id);
          if (cached) {
            cached.enabled = enabled;
            updateTokenTotal();
          }
          const badge = container.querySelector(`.ps-token-badge[data-entry-id="${CSS.escape(entry.id)}"]`);
          if (badge) badge.classList.toggle('ps-token-badge--disabled', !enabled);
        });
      }

      const editBtn   = row.querySelector('.ps-edit');
      const deleteBtn = row.querySelector('.ps-delete');

      if (!isSentinel) {
        editBtn.addEventListener('click', () => openEditor(entry, State));
      }
      if (!isSentinel || isChar) {
        deleteBtn.addEventListener('click', () => {
          if (!editBtn) {
            confirmInline(deleteBtn, async () => {
              await deletePrompt(entry.id);
              State.prompts = State.prompts.filter(p => p.id !== entry.id);
              renderList(State);
            });
            return;
          }

          deleteBtn.innerHTML = ''; deleteBtn.appendChild(icon(X, 16));
          editBtn.innerHTML = '';   editBtn.appendChild(icon(Check, 16));

          let timer;
          function restore() {
            clearTimeout(timer);
            deleteBtn.innerHTML = ''; deleteBtn.appendChild(icon(Trash2, 16));
            editBtn.innerHTML = '';   editBtn.appendChild(icon(Pencil, 16));
            deleteBtn.onclick = null;
            editBtn.onclick   = null;
          }

          deleteBtn.onclick = (e) => { e.stopPropagation(); restore(); };
          editBtn.onclick   = async (e) => {
            e.stopPropagation();
            restore();
            await deletePrompt(entry.id);
            State.prompts = State.prompts.filter(p => p.id !== entry.id);
            renderList(State);
          };

          timer = setTimeout(restore, 3000);
        });
      }

      list.appendChild(row);
    }

    if (window.Sortable) {
      if (sortable) sortable.destroy();
      sortable = Sortable.create(list, {
        handle: '.ps-drag-handle',
        animation: 150,
        onEnd: async () => {
          const ids = [...list.querySelectorAll('.ps-row')].map(r => r.dataset.id);
          await reorderPrompts(ids);
          const map = Object.fromEntries(State.prompts.map(e => [e.id, e]));
          State.prompts = ids.map(id => map[id]).filter(Boolean);
        },
      });
    }

    scheduleTokenCounts(State);
  }

  function populatePresetSelector() {
    const sel = el('pp-preset-select');
    if (!sel) return;
    sel.innerHTML = _presets.map(p =>
      `<option value="${esc(p.id)}">${esc(p.name)}</option>`
    ).join('');
    sel.value = _activeId;
  }

  async function load() {
    const { entries } = await getPrompts();
    State.prompts = entries;
    renderList(State);
  }

  // Store callbacks on the container for onShow to use (tab instance)
  container._psLoad = load;
  container._psPopulateSelector = populatePresetSelector;

  // Load presets and wire selector
  try {
    const { presets, activeId } = await getPromptPresets();
    _presets  = presets;
    _activeId = activeId;
  } catch (err) {
    console.error('Failed to load prompt presets:', err);
  }
  populatePresetSelector();

  await load();

  // ── Preset CRUD ─────────────────────────────────────────────────────────────

  function showRenameRow() {
    const preset = _presets.find(p => p.id === _activeId);
    el('pp-preset-name').value = preset?.name ?? '';
    el('pp-rename-row').style.display = 'flex';
    el('pp-preset-name').focus();
    el('pp-preset-name').select();
  }

  function hideRenameRow() {
    el('pp-rename-row').style.display = 'none';
  }

  async function savePresetName() {
    const name = el('pp-preset-name').value.trim();
    if (!name || !_activeId) return;
    try {
      await updatePromptPreset(_activeId, { name });
      const idx = _presets.findIndex(p => p.id === _activeId);
      if (idx >= 0) _presets[idx].name = name;
      const opt = el('pp-preset-select')?.querySelector(`option[value="${_activeId}"]`);
      if (opt) opt.textContent = name;
    } catch (err) {
      console.error('Failed to rename prompt preset:', err);
    }
  }

  el('pp-preset-select').addEventListener('change', async (e) => {
    hideRenameRow();
    try {
      await setActivePrompt(e.target.value);
      _activeId = e.target.value;
      await load();
    } catch (err) {
      console.error('Failed to switch prompt preset:', err);
    }
  });

  el('pp-rename').addEventListener('click', () => {
    el('pp-rename-row').style.display === 'none' ? showRenameRow() : hideRenameRow();
  });

  el('pp-rename-save').addEventListener('click', async () => {
    await savePresetName();
    hideRenameRow();
  });

  el('pp-rename-cancel').addEventListener('click', hideRenameRow);

  el('pp-preset-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); savePresetName().then(hideRenameRow); }
    if (e.key === 'Escape') { hideRenameRow(); }
  });

  el('pp-new').addEventListener('click', async () => {
    try {
      const { preset } = await createPromptPreset({
        name: 'New Preset',
        stack: [],
        generationSettings: { temperature: 0.85, top_p: 0.95, frequency_penalty: 0, presence_penalty: 0, max_tokens: 1000 },
      });
      await setActivePrompt(preset.id);
      _presets.push(preset);
      _activeId = preset.id;
      populatePresetSelector();
      await load();
      showRenameRow();
    } catch (err) {
      console.error('Failed to create prompt preset:', err);
    }
  });

  el('pp-dup').addEventListener('click', async () => {
    const src = _presets.find(p => p.id === _activeId);
    if (!src) return;
    try {
      const { preset } = await createPromptPreset({
        name: src.name + ' (copy)',
        stack: JSON.parse(JSON.stringify(src.stack || [])),
        generationSettings: { ...(src.generationSettings || {}) },
      });
      await setActivePrompt(preset.id);
      _presets.push(preset);
      _activeId = preset.id;
      populatePresetSelector();
      await load();
    } catch (err) {
      console.error('Failed to duplicate prompt preset:', err);
    }
  });

  el('pp-del').addEventListener('click', () => {
    if (_presets.length < 2) { showToast('Cannot delete the last prompt preset.', 'error'); return; }
    const src = _presets.find(p => p.id === _activeId);
    if (!src) return;
    confirmInline(el('pp-del'), async () => {
      try {
        hideRenameRow();
        const { activeId } = await deletePromptPreset(_activeId);
        _presets = _presets.filter(p => p.id !== src.id);
        _activeId = activeId;
        populatePresetSelector();
        await load();
      } catch (err) {
        console.error('Failed to delete prompt preset:', err);
      }
    });
  });

  const SENTINEL_TYPES = {
    character: { label: 'Character Card',      content: null },
    persona:   { label: 'Persona Description', content: null },
  };

  el('ps-add').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = el('ps-add-menu');
    menu.querySelectorAll('.ps-add-sentinel').forEach(btn => {
      const already = State.prompts.some(p => p.type === btn.dataset.type);
      btn.classList.toggle('ps-add-item--disabled', already);
    });
    menu.style.display = menu.style.display === 'none' ? '' : 'none';
  });

  el('ps-add-menu').addEventListener('click', async (e) => {
    const btn = e.target.closest('.ps-add-item');
    if (!btn || btn.classList.contains('ps-add-item--disabled')) return;
    el('ps-add-menu').style.display = 'none';
    const type = btn.dataset.type;
    let entry;
    if (type === 'entry') {
      entry = await addPrompt({ label: 'New Entry', content: '', enabled: true, role: 'system' });
    } else {
      const def = SENTINEL_TYPES[type];
      entry = await addPrompt({ type, label: def.label, content: def.content, enabled: true, role: 'system' });
    }
    State.prompts.push(entry);
    renderList(State);
  });

  document.addEventListener('click', (e) => {
    if (!container.contains(e.target) || !e.target.closest('#ps-add')) {
      const menu = el('ps-add-menu');
      if (menu) menu.style.display = 'none';
    }
  });

  el('ps-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const statusEl = el('ps-import-status');
    statusEl.textContent = 'Importing…';
    try {
      const text = await file.text();
      const stack = importSTPreset(JSON.parse(text));
      stack.forEach(entry => { entry.id = 'entry_' + Math.random().toString(36).slice(2, 10); });

      const presetName = file.name.replace(/\.json$/i, '');
      const { preset } = await createPromptPreset({
        name: presetName,
        stack,
        generationSettings: { temperature: 0.85, top_p: 0.95, frequency_penalty: 0, presence_penalty: 0, max_tokens: 1000 },
      });
      await setActivePrompt(preset.id);
      _presets.push(preset);
      _activeId = preset.id;
      await load();
      populatePresetSelector();
      statusEl.textContent = `Imported "${presetName}" (${stack.length} entries)`;
    } catch (err) {
      statusEl.textContent = 'Import failed: ' + err.message;
    }
    e.target.value = '';
  });

  if (!isPanel) {
    el('ps-popout').addEventListener('click', () => openPromptStackPanel(State));
  }
}

export async function onShow(State, container) {
  try {
    const { presets, activeId } = await getPromptPresets();
    _presets  = presets;
    _activeId = activeId;
    container._psPopulateSelector?.();
  } catch (err) {
    console.error('Failed to reload prompt presets:', err);
  }
  await container._psLoad?.();
}

// ── Pop-out panel ─────────────────────────────────────────────────────────────

let _promptStackPanel = null;

export function openPromptStackPanel(State) {
  if (_promptStackPanel) { _promptStackPanel.open(); return; }

  const panel = createFloatingPanel({
    width: '700px',
    title: 'Prompt Stack',
    onClose: () => { _promptStackPanel = null; },
  });
  _promptStackPanel = panel;

  panel.setContent(content => {
    init(State, content, { isPanel: true });
  });
  panel.open();
}

// ── ST Preset Import ──────────────────────────────────────────────────────────

/**
 * Parse a SillyTavern preset JSON into our PromptEntry format.
 *
 * ST format:
 *   prompts[]        — custom prompt definitions (identifier, name, content, enable,
 *                      role, injection_position, injection_depth)
 *   prompt_order[]   — one entry per character (character_id 100000 is the generic
 *                      default, 100001+ are per-character overrides). Each has
 *                      .order = [{identifier, enabled}] defining the stack order for
 *                      that character. We merge ALL orders so prompts referenced by
 *                      any character are imported.
 *
 * Built-in identifiers and how they map:
 *   chatHistory              → type:'chatHistory' sentinel (marks injection point)
 *   charDescription,
 *   charPersonality,
 *   scenario,
 *   dialogueExamples         → collapse into one type:'character' sentinel
 *   personaDescription       → type:'persona' sentinel (expands to active persona at
 *                              assembly time)
 *   worldInfoBefore,
 *   worldInfoAfter           → imported as disabled system entries if they have content
 *
 * injection_depth > 0 (Authors Note, etc.):
 *   Preserved on the entry. The assembler weaves these into the chat history block.
 */
function importSTPreset(data) {
  const CHAR_MARKERS = new Set([
    'charDescription', 'charPersonality', 'scenario', 'dialogueExamples',
  ]);
  const WI_MARKERS = new Set(['worldInfoBefore', 'worldInfoAfter']);

  const promptsByIdentifier = {};
  for (const p of (data.prompts ?? [])) {
    const key = p.identifier ?? p.name;
    if (key) promptsByIdentifier[key] = p;
  }

  // Merge every prompt_order entry's `.order` into a single list. First-seen
  // position wins (preserves the default character's ordering); enabled flag
  // is OR'd across all orders (if any character uses it enabled, we keep it on).
  const merged = new Map(); // identifier → { id, enabled }
  for (const po of (data.prompt_order ?? [])) {
    for (const o of (po.order ?? [])) {
      if (!o?.identifier) continue;
      const existing = merged.get(o.identifier);
      if (existing) {
        existing.enabled = existing.enabled || (o.enabled ?? true);
      } else {
        merged.set(o.identifier, { id: o.identifier, enabled: o.enabled ?? true });
      }
    }
  }
  const orderedIds = merged.size > 0
    ? Array.from(merged.values())
    : (data.prompts ?? []).map(p => ({ id: p.identifier ?? p.name, enabled: p.enable ?? true }));

  const entries = [];
  let charSentinelAdded = false;
  let chatHistorySentinelAdded = false;
  let personaSentinelAdded = false;

  for (const { id, enabled } of orderedIds) {
    if (id === 'chatHistory') {
      if (!chatHistorySentinelAdded) {
        entries.push({
          type: 'chatHistory', label: 'Chat History',
          content: null, enabled: true, role: null, injection_depth: 0,
        });
        chatHistorySentinelAdded = true;
      }
      continue;
    }

    if (id === 'personaDescription') {
      if (!personaSentinelAdded) {
        entries.push({
          type: 'persona', label: 'Persona Description',
          content: null, enabled: !!enabled, role: 'system', injection_depth: 0,
        });
        personaSentinelAdded = true;
      }
      continue;
    }

    if (CHAR_MARKERS.has(id)) {
      if (!charSentinelAdded) {
        entries.push({
          type: 'character', label: 'Character Card',
          content: null, enabled: true, role: 'system', injection_depth: 0,
        });
        charSentinelAdded = true;
      }
      continue;
    }

    if (WI_MARKERS.has(id)) {
      const p = promptsByIdentifier[id];
      if (p?.content) {
        entries.push({
          type: 'system', label: p.name ?? id, content: p.content,
          enabled: false, role: p.role || 'system', injection_depth: 0,
        });
      }
      continue;
    }

    const p = promptsByIdentifier[id];
    if (!p) continue;

    const injection_position = (p.injection_position === 1) ? 1 : 0;
    const injection_depth    = injection_position === 1 ? (p.injection_depth ?? 4) : 0;

    if (p.content || p.name) {
      entries.push({
        type:    'system',
        label:   p.name ?? id,
        content: p.content ?? '',
        enabled: !!(p.enable ?? enabled),
        role:    p.role || 'system',
        injection_position,
        injection_depth,
      });
    }
  }

  if (!charSentinelAdded) {
    entries.unshift({
      type: 'character', label: 'Character Card',
      content: null, enabled: true, role: 'system', injection_depth: 0,
    });
  }
  if (!chatHistorySentinelAdded) {
    entries.push({
      type: 'chatHistory', label: 'Chat History',
      content: null, enabled: true, role: null, injection_depth: 0,
    });
  }

  return entries;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function getEntryText(entry, State) {
  if (entry.type === 'character') {
    const c = State.sessionCharacter ?? {};
    return [c.name, c.description, c.personality, c.scenario, c.mes_example]
      .filter(Boolean).join('\n');
  }
  if (entry.type === 'persona') {
    return (State.sessionPersona ?? State.activePersona)?.description ?? '';
  }
  return entry.content ?? '';
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
