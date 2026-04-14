import {
  getCharacters, createCharacter, getCharacter, saveCharacter, deleteCharacter,
  uploadCharacterAvatar, saveSettings, getSettings,
  getSessions, deleteSession, updateSession,
} from '../lib/api.js';
import { selectSession, newSession, renderMessages } from './chat.js';
import { createAccordion }    from '../lib/accordion.js';
import { createFloatingPanel } from '../lib/floatingPanel.js';
import { createSearch }        from '../lib/search.js';
import { icon, Pencil, Trash2, ChevronLeft, LayoutGrid, List, Maximize2, Minimize2, Download, X, MessageSquarePlus, Upload, Package, ListChecks, Plus } from '../lib/icons.js';
import { confirmInline } from '../lib/confirmInline.js';
import { countTokens, pickEncoder, setCachedTokens } from '../lib/tokenizer.js';
import { showToast } from '../lib/toast.js';
import { openCropModal } from '../lib/cropModal.js';
import { stripFormatting } from '../lib/textPreview.js';

// ── Shared helpers ────────────────────────────────────────────────────────────

function hashToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

function buildAvatarEl(avatarPath, name, size = 'sm', charId = null) {
  if (avatarPath) {
    const img = document.createElement('img');
    const v = charId != null && _avatarVersions[charId] ? `?v=${_avatarVersions[charId]}` : '';
    img.src = `${avatarPath}${v}`;
    img.className = `avatar-img avatar-img--${size}`;
    img.alt = name || '';
    return img;
  }
  const hue  = hashToHue(name || 'default');
  const div  = document.createElement('div');
  div.className = `avatar-initials avatar-initials--${size}`;
  div.style.background = `hsl(${hue}, 40%, 25%)`;
  div.style.color      = `hsl(${hue}, 60%, 70%)`;
  div.textContent      = (name || '?')[0].toUpperCase();
  return div;
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tokenCount(text) {
  return Math.ceil((text ?? '').length / 4);
}

async function importCharacterPNG(file) {
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/characters/import', { method: 'POST', body: fd });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || res.statusText || 'Import failed';
      console.error(`Import failed for "${file.name}":`, msg);
      showToast(`Failed to import ${file.name}: ${msg}`, 'error');
      return null;
    }
    const char = await res.json();
    showToast(`Imported "${char.name}"`, 'success');
    return char;
  } catch (err) {
    console.error(`Import failed for "${file.name}":`, err);
    showToast(`Failed to import ${file.name}: ${err.message}`, 'error');
    return null;
  }
}

// ── Module state ──────────────────────────────────────────────────────────────

let _container = null;
let _State     = null;
const _avatarVersions = {}; // charId → version counter, only bumped on upload
let _charTypeFilter  = localStorage.getItem('charTypeFilter') || 'character';
let _inlineChar      = null;
let _inlineCallbacks = {};
let _isNewChar    = false;  // true when editor was opened via "New Character"
let _inlineDirty  = false;  // true once any field is edited
let _activeSubtab = localStorage.getItem('charSubtab') || 'editor';

// ── init / onShow ─────────────────────────────────────────────────────────────

export async function init(State, container) {
  _container = container;
  _State     = State;

  // Refresh the chats subtab list when a new session is created elsewhere
  // (e.g. branchFrom in chat.js). Only refresh if it's the inline character we're viewing.
  document.addEventListener('sessionscreated', (e) => {
    if (_activeSubtab !== 'chats' || !_inlineChar) return;
    const sess = e.detail?.session;
    if (!sess || sess.characterId !== _inlineChar.id) return;
    const content = document.getElementById('char-inline-content');
    if (content) renderCharacterChats(content, _inlineChar, _State);
  });

  container.innerHTML = '';

  // Header row
  const header = document.createElement('div');
  header.id = 'char-browser-header';
  header.innerHTML = `
    <button id="char-new" class="btn-ghost char-view-btn" title="New character"></button>
    <button id="char-import" class="btn-ghost char-view-btn" title="Import character"></button>
    <input id="char-import-input" type="file" accept=".png" multiple hidden>
    <span style="flex:1"></span>
    <button id="char-view-grid" class="char-view-btn btn-ghost" title="Grid view"></button>
    <button id="char-view-list" class="char-view-btn btn-ghost" title="List view"></button>
    <button id="char-gallery-open" class="char-view-btn btn-ghost" title="Expand gallery"></button>
  `;
  header.querySelector('#char-new').appendChild(icon(Plus, 16));
  header.querySelector('#char-import').appendChild(icon(Upload, 16));
  header.querySelector('#char-view-grid').appendChild(icon(LayoutGrid, 16));
  header.querySelector('#char-view-list').appendChild(icon(List, 16));
  header.querySelector('#char-gallery-open').appendChild(icon(Maximize2, 16));
  container.appendChild(header);

  // Type filter toggle (🎭 Characters | 👤 Personas)
  const typeFilter = document.createElement('div');
  typeFilter.id = 'char-type-filter';
  typeFilter.innerHTML = `
    <button class="char-type-btn${_charTypeFilter === 'character' ? ' active' : ''}" data-type="character">Characters</button>
    <button class="char-type-btn${_charTypeFilter === 'persona' ? ' active' : ''}" data-type="persona">Personas</button>
  `;
  container.appendChild(typeFilter);

  // Browser area
  const browser = document.createElement('div');
  browser.id = 'char-browser';
  container.appendChild(browser);

  // Inline editor wrap (hidden until edit is triggered)
  const inlineWrap = document.createElement('div');
  inlineWrap.id = 'char-inline-editor-wrap';
  inlineWrap.style.display = 'none';

  const inlineHdr = document.createElement('div');
  inlineHdr.id = 'char-inline-header';

  const backBtn = document.createElement('button');
  backBtn.id = 'char-inline-back';
  backBtn.className = 'btn-ghost';
  backBtn.title = 'Back to browser';
  backBtn.appendChild(icon(ChevronLeft, 16));

  const inlineTitle = document.createElement('span');
  inlineTitle.id = 'char-inline-title';
  inlineTitle.className = 'char-inline-title';

  const popoutBtn = document.createElement('button');
  popoutBtn.id = 'char-inline-popout';
  popoutBtn.className = 'btn-ghost char-view-btn';
  popoutBtn.title = 'Pop out to panel';
  popoutBtn.appendChild(icon(Maximize2, 16));

  inlineHdr.appendChild(backBtn);
  inlineHdr.appendChild(inlineTitle);
  inlineHdr.appendChild(popoutBtn);

  // Subtab bar (Editor | Chats)
  const inlineSubtabs = document.createElement('div');
  inlineSubtabs.id = 'char-inline-subtabs';
  const editorTabBtn = document.createElement('button');
  editorTabBtn.className = 'char-subtab char-subtab--active';
  editorTabBtn.dataset.tab = 'editor';
  editorTabBtn.textContent = 'Editor';
  const chatsTabBtn = document.createElement('button');
  chatsTabBtn.className = 'char-subtab';
  chatsTabBtn.dataset.tab = 'chats';
  chatsTabBtn.textContent = 'Chats';
  inlineSubtabs.appendChild(editorTabBtn);
  inlineSubtabs.appendChild(chatsTabBtn);
  inlineSubtabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.char-subtab');
    if (!btn || !_inlineChar) return;
    switchSubtab(btn.dataset.tab);
  });

  const inlineContent = document.createElement('div');
  inlineContent.id = 'char-inline-content';

  inlineWrap.appendChild(inlineHdr);
  inlineWrap.appendChild(inlineSubtabs);
  inlineWrap.appendChild(inlineContent);
  container.appendChild(inlineWrap);

  // Wire header buttons
  document.getElementById('char-new').addEventListener('click', async () => {
    const type = _charTypeFilter;
    const char = await createCharacter({ name: type === 'persona' ? 'My Persona' : 'New Character', type });
    _State.characters = [...(_State.characters ?? []), { id: char.id, name: char.name, type }];
    openCharacterEditor(char.id, _State, {
      onSave:   () => reloadBrowser(),
      onDelete: () => { showBrowser(); reloadBrowser(); },
      isNew:    true,
    });
  });

  document.getElementById('char-import').addEventListener('click', () => {
    document.getElementById('char-import-input').click();
  });

  document.getElementById('char-import-input').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    for (const f of files) await importCharacterPNG(f);
    await reloadBrowser();
  });

  document.getElementById('char-view-grid').addEventListener('click', () => setView('grid'));
  document.getElementById('char-view-list').addEventListener('click', () => setView('list'));
  document.getElementById('char-gallery-open').addEventListener('click', () => openGallery(_State));

  typeFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('.char-type-btn');
    if (!btn) return;
    _charTypeFilter = btn.dataset.type;
    localStorage.setItem('charTypeFilter', _charTypeFilter);
    typeFilter.querySelectorAll('.char-type-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.type === _charTypeFilter));
    renderBrowser();
  });

  document.getElementById('char-inline-back').addEventListener('click', async () => {
    if (_isNewChar && !_inlineDirty && _inlineChar) {
      await deleteCharacter(_inlineChar.id);
      _State.characters = (_State.characters ?? []).filter(c => c.id !== _inlineChar.id);
    }
    showBrowser();
  });

  document.getElementById('char-inline-popout').addEventListener('click', () => {
    if (!_inlineChar) return;
    const char = _inlineChar;
    if (_activeSubtab === 'chats') {
      showBrowser();
      popOutChats(char, _State);
    } else {
      const { onSave, onDelete } = _inlineCallbacks;
      showBrowser();
      popOutEditor(char, _State, { onSave, onDelete });
    }
  });

  await loadAll();
  restoreInlineState();
}

export async function onShow(State, container) {
  _State     = State;
  _container = container;
  await loadAll();
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadAll() {
  const [{ characters }, settings] = await Promise.all([
    getCharacters(),
    getSettings(),
  ]);
  _State.characters = characters;
  _State.activeCharacterId  = settings.activeCharacterId  ?? null;
  _State.activePersonaId    = settings.activePersonaId    ?? null;
  _State.charBrowserView    = settings.charBrowserView    ?? 'grid';
  _State.settings = { ...(_State.settings ?? {}), ...settings };
  renderBrowser();
}

async function reloadBrowser() {
  await loadAll();
}

// ── View mode ─────────────────────────────────────────────────────────────────

function setView(mode) {
  _State.charBrowserView = mode;
  saveSettings({ charBrowserView: mode }).catch(() => {});
  if (_State.settings) _State.settings.charBrowserView = mode;
  renderBrowser();
}

// ── Browser show/hide ─────────────────────────────────────────────────────────

function restoreInlineState() {
  const charId = localStorage.getItem('charInlineId');
  if (!charId) return;
  const char = (_State.characters ?? []).find(c => c.id === charId);
  if (!char) { localStorage.removeItem('charInlineId'); return; }
  const savedSubtab = localStorage.getItem('charSubtab') || 'editor';
  showInlineEditor(char, {
    onSave:   () => reloadBrowser(),
    onDelete: () => reloadBrowser(),
    subtab:   savedSubtab,
  });
}

function showBrowser() {
  document.getElementById('char-browser-header').style.display = '';
  document.getElementById('char-type-filter').style.display    = '';
  document.getElementById('char-browser').style.display        = '';
  document.getElementById('char-inline-editor-wrap').style.display = 'none';
  _inlineChar = null;
  localStorage.removeItem('charInlineId');
}

function showInlineEditor(char, { onSave, onDelete, isNew = false, subtab } = {}) {
  _inlineChar      = char;
  _inlineCallbacks = { onSave, onDelete };
  _isNewChar   = isNew;
  _inlineDirty = false;
  _activeSubtab = subtab || 'editor';
  localStorage.setItem('charInlineId', char.id);
  localStorage.setItem('charSubtab', _activeSubtab);

  document.getElementById('char-browser-header').style.display = 'none';
  document.getElementById('char-type-filter').style.display    = 'none';
  document.getElementById('char-browser').style.display        = 'none';

  const titleEl = document.getElementById('char-inline-title');
  if (titleEl) titleEl.textContent = char.name;

  // Set subtab buttons to the active subtab
  document.querySelectorAll('.char-subtab').forEach(btn =>
    btn.classList.toggle('char-subtab--active', btn.dataset.tab === _activeSubtab));

  const content = document.getElementById('char-inline-content');
  content.innerHTML = '';
  if (_activeSubtab === 'chats') {
    renderCharacterChats(content, char, _State);
  } else {
    renderEditor(content, char, _State, {
      onSave:   () => { onSave?.(); },
      onDelete: () => { showBrowser(); onDelete?.(); },
    });
  }

  document.getElementById('char-inline-editor-wrap').style.display = 'flex';
}

// ── Click-to-chat ─────────────────────────────────────────────────────────────

export async function clickToChat(meta, State) {
  await saveSettings({ activeCharacterId: meta.id });
  State.activeCharacterId = meta.id;
  if (State.settings) State.settings.activeCharacterId = meta.id;

  // Find the most recently updated session for this character
  const sessions = State.sessions ?? [];
  const existing = sessions
    .filter(s => s.characterId === meta.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];

  if (existing) {
    await selectSession(existing.id, State);
  } else {
    await newSession(State);
  }

  renderBrowser();
}

async function setActivePersona(meta, State) {
  await saveSettings({ activePersonaId: meta.id });
  State.activePersonaId = meta.id;
  if (State.settings) State.settings.activePersonaId = meta.id;
  const full = await getCharacter(meta.id).catch(() => null);
  State.activePersona = full ?? meta;
  renderBrowser();
}

// ── Render browser ────────────────────────────────────────────────────────────

function renderBrowser() {
  const browser = document.getElementById('char-browser');
  if (!browser) return;

  const view = _State.charBrowserView ?? 'grid';

  document.getElementById('char-view-grid')?.classList.toggle('active', view === 'grid');
  document.getElementById('char-view-list')?.classList.toggle('active', view === 'list');

  browser.innerHTML = '';
  browser.className = view === 'grid' ? 'char-browser-grid' : 'char-browser-list';

  const filtered = (_State.characters ?? []).filter(c =>
    _charTypeFilter === 'persona' ? c.type === 'persona' : c.type !== 'persona'
  );

  for (const meta of filtered) {
    if (view === 'grid') browser.appendChild(buildGridCard(meta));
    else                 browser.appendChild(buildListRow(meta));
  }
}

function isActiveChar(meta) {
  if (meta.type === 'persona') return meta.id === _State.activePersonaId;
  return meta.id === _State.activeCharacterId;
}

function buildGridCard(meta) {
  const card = document.createElement('div');
  card.className = 'char-card' + (isActiveChar(meta) ? ' char-card--active' : '');
  card.dataset.id = meta.id;

  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'char-card-avatar';
  avatarWrap.appendChild(buildAvatarEl(meta.avatar ?? null, meta.name, 'sm', meta.id));

  const nameEl = document.createElement('div');
  nameEl.className = 'char-card-name';
  nameEl.textContent = meta.name;

  const editBtn = document.createElement('button');
  editBtn.className = 'char-card-edit btn-ghost';
  editBtn.title = 'Edit';
  editBtn.appendChild(icon(Pencil, 16));
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCharacterEditor(meta.id, _State, {
      onSave:   () => reloadBrowser(),
      onDelete: () => { showBrowser(); reloadBrowser(); },
    });
  });

  card.appendChild(avatarWrap);
  card.appendChild(nameEl);
  card.appendChild(editBtn);

  card.addEventListener('click', () => {
    if (meta.type === 'persona') {
      setActivePersona(meta, _State);
    } else {
      clickToChat(meta, _State);
    }
  });

  return card;
}

function buildListRow(meta) {
  const row = document.createElement('div');
  row.className = 'char-row' + (isActiveChar(meta) ? ' char-row--active' : '');
  row.dataset.id = meta.id;

  const avatarEl = buildAvatarEl(meta.avatar ?? null, meta.name, 'sm', meta.id);
  avatarEl.style.flexShrink = '0';

  const info = document.createElement('div');
  info.className = 'char-row-info';
  info.innerHTML = `
    <div class="char-row-name">${esc(meta.name)}</div>
    <div class="char-row-desc">${esc(stripFormatting(meta.creatorNotes, 80))}</div>
  `;

  const editBtn = document.createElement('button');
  editBtn.className = 'char-row-edit btn-ghost';
  editBtn.title = 'Edit';
  editBtn.appendChild(icon(Pencil, 16));
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCharacterEditor(meta.id, _State, {
      onSave:   () => reloadBrowser(),
      onDelete: () => { showBrowser(); reloadBrowser(); },
    });
  });

  row.appendChild(avatarEl);
  row.appendChild(info);
  row.appendChild(editBtn);

  row.addEventListener('click', () => {
    if (meta.type === 'persona') {
      setActivePersona(meta, _State);
    } else {
      clickToChat(meta, _State);
    }
  });

  return row;
}

// ── Character Editor ──────────────────────────────────────────────────────────

let _editorPanel = null;

export function openCharacterEditor(charId, State, { onSave, onDelete, isNew = false } = {}) {
  getCharacter(charId).then(char => {
    if (!char) return;
    showInlineEditor(char, { onSave, onDelete, isNew });
  });
}

function popOutEditor(char, State, { onSave, onDelete } = {}) {
  if (!_editorPanel) {
    _editorPanel = createFloatingPanel({ width: '640px', title: '' });
  }
  _editorPanel.setTitle(char.name, null);
  _editorPanel.setContent(container => renderEditor(container, char, State, {
    onSave:   () => { reloadBrowser(); onSave?.(); },
    onDelete: () => { reloadBrowser(); _editorPanel.close(); onDelete?.(); },
  }));
  _editorPanel.open();
}

function renderEditor(container, char, State, { onSave, onDelete } = {}) {
  // ── Top row: avatar + name + type ───────────────────────────────────────────
  const topRow = document.createElement('div');
  topRow.className = 'char-editor-top';

  const avatarCol = document.createElement('div');
  avatarCol.className = 'char-editor-avatar-col';

  const avatarPreview = document.createElement('div');
  avatarPreview.className = 'avatar-preview';
  avatarPreview.appendChild(buildAvatarEl(char.avatar ?? null, char.name, 'lg', char.id));

  const avatarInput = document.createElement('input');
  avatarInput.type = 'file';
  avatarInput.accept = 'image/*';
  avatarInput.hidden = true;

  const avatarBtn = document.createElement('button');
  avatarBtn.className = 'btn-secondary';
  avatarBtn.style.fontSize = '0.75rem';
  avatarBtn.textContent = 'Upload Avatar';
  avatarBtn.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    avatarInput.value = '';
    const cropped = await openCropModal(file);
    if (!cropped) return;
    const { avatar } = await uploadCharacterAvatar(char.id, cropped);
    char.avatar = avatar;
    _avatarVersions[char.id] = Date.now();
    avatarPreview.innerHTML = '';
    avatarPreview.appendChild(buildAvatarEl(avatar, char.name, 'lg', char.id));
    const meta = State.characters?.find(c => c.id === char.id);
    if (meta) meta.avatar = avatar;
    renderBrowser();
  });

  avatarCol.appendChild(avatarPreview);
  avatarCol.appendChild(avatarInput);
  avatarCol.appendChild(avatarBtn);

  const metaCol = document.createElement('div');
  metaCol.className = 'char-editor-meta-col';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = char.name ?? '';
  nameInput.placeholder = 'Character name';
  nameInput.className = 'char-editor-name-input';

  const typeSelect = document.createElement('select');
  typeSelect.className = 'char-editor-type-select';
  typeSelect.innerHTML = `
    <option value="character" ${char.type !== 'persona' ? 'selected' : ''}>Character</option>
    <option value="persona"   ${char.type === 'persona'  ? 'selected' : ''}>Persona</option>
  `;

  metaCol.appendChild(nameInput);
  metaCol.appendChild(typeSelect);
  topRow.appendChild(avatarCol);
  topRow.appendChild(metaCol);
  container.appendChild(topRow);

  // ── Fields ─────────────────────────────────────────────────────────────────
  const fields = [
    { key: 'description',  label: 'Description',     rows: 8, value: char.description  ?? '', open: true  },
    { key: 'personality',  label: 'Personality',     rows: 5, value: char.personality  ?? '', open: false },
    { key: 'scenario',     label: 'Scenario',        rows: 4, value: char.scenario     ?? '', open: false },
    { key: 'firstMessage', label: 'First Message',   rows: 5, value: char.firstMessage ?? '', open: false },
    { key: 'mesExample',   label: 'Example Messages',rows: 6, value: char.mesExample   ?? '', open: false },
    { key: 'creatorNotes', label: 'Creator Notes',   rows: 4, value: char.creatorNotes ?? '', open: false },
  ];

  const textareas = {};

  // Total token counter (updated after each field is wired)
  const totalTokenEl = document.createElement('div');
  totalTokenEl.className = 'char-total-tokens';

  function updateTotalTokens() {
    const total = Object.values(textareas).reduce((sum, ta) => sum + tokenCount(ta.value), 0);
    totalTokenEl.textContent = `Total: ${total} tokens`;
  }

  for (const f of fields) {
    const { section, body } = createAccordion(f.label, f.open);

    const fieldWrap = document.createElement('div');
    fieldWrap.className = 'char-field-wrap';

    const ta = document.createElement('textarea');
    ta.rows = f.rows;
    ta.value = f.value;
    ta.className = 'char-field-textarea';
    textareas[f.key] = ta;

    const fieldFooter = document.createElement('div');
    fieldFooter.className = 'char-field-footer';

    const tokenEl = document.createElement('span');
    tokenEl.className = 'field-tokens';
    tokenEl.textContent = `Tokens: ${tokenCount(f.value)}`;

    const expandBtn = document.createElement('button');
    expandBtn.className = 'char-field-expand btn-ghost';
    expandBtn.appendChild(icon(Maximize2, 16));
    expandBtn.title = 'Expand';

    fieldFooter.appendChild(tokenEl);
    fieldFooter.appendChild(expandBtn);

    ta.addEventListener('input', () => {
      tokenEl.textContent = `Tokens: ${tokenCount(ta.value)}`;
      updateTotalTokens();
    });

    expandBtn.addEventListener('click', () => {
      const fpContent = container.closest('.fp-content') ?? container;
      const isExpanded = fpContent.classList.contains('fp-expanded');
      if (isExpanded) {
        fpContent.classList.remove('fp-expanded');
        expandBtn.innerHTML = '';
        expandBtn.appendChild(icon(Maximize2, 16));
        expandBtn.title = 'Expand';
      } else {
        fpContent.classList.add('fp-expanded');
        fpContent.dataset.expandedKey = f.key;
        expandBtn.innerHTML = '';
        expandBtn.appendChild(icon(Minimize2, 16));
        expandBtn.title = 'Collapse';
        ta.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      container.querySelectorAll('.accordion-section').forEach(sec => {
        const secKey = sec.dataset.fieldKey;
        sec.style.display = (!isExpanded && secKey && secKey !== f.key) ? 'none' : '';
      });
    });

    section.dataset.fieldKey = f.key;
    fieldWrap.appendChild(ta);
    fieldWrap.appendChild(fieldFooter);
    body.appendChild(fieldWrap);
    container.appendChild(section);
  }

  // ── Action row ─────────────────────────────────────────────────────────────
  const actionRow = document.createElement('div');
  actionRow.className = 'char-editor-actions action-row';

  const statusEl = document.createElement('span');
  statusEl.className = 'hint char-editor-status';

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-ghost';
  exportBtn.title = 'Export as PNG';
  exportBtn.appendChild(icon(Download, 16));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn-ghost btn-danger';
  deleteBtn.title = 'Delete character';
  deleteBtn.appendChild(icon(Trash2, 16));

  updateTotalTokens();
  actionRow.appendChild(totalTokenEl);
  actionRow.appendChild(statusEl);
  actionRow.appendChild(exportBtn);
  actionRow.appendChild(deleteBtn);
  container.appendChild(actionRow);

  // ── Auto-save ───────────────────────────────────────────────────────────────
  let _saveTimer = null;
  let _statusTimer = null;

  async function doSave() {
    try {
      const updated = await saveCharacter(char.id, {
        type:         typeSelect.value,
        name:         nameInput.value,
        description:  textareas.description.value,
        personality:  textareas.personality.value,
        scenario:     textareas.scenario.value,
        firstMessage: textareas.firstMessage.value,
        mesExample:   textareas.mesExample.value,
        creatorNotes: textareas.creatorNotes.value,
      });
      Object.assign(char, updated);
      const meta = State.characters?.find(c => c.id === char.id);
      if (meta) { meta.name = updated.name; meta.type = updated.type; meta.creatorNotes = updated.creatorNotes ?? ''; }
      const inlineTitleEl = document.getElementById('char-inline-title');
      if (inlineTitleEl && _inlineChar?.id === char.id) inlineTitleEl.textContent = char.name;
      statusEl.textContent = 'Saved';
      clearTimeout(_statusTimer);
      _statusTimer = setTimeout(() => { statusEl.textContent = ''; }, 2000);
      onSave?.();
      // Cache token count for prompt stack
      const allText = [updated.name, updated.description, updated.personality, updated.scenario, updated.mesExample]
        .filter(Boolean).join('\n');
      countTokens(allText, pickEncoder(State)).then(n => setCachedTokens(char.id, n)).catch(() => {});
    } catch (err) {
      statusEl.textContent = 'Error saving';
    }
  }

  function scheduleAutoSave() {
    _inlineDirty = true;
    clearTimeout(_saveTimer);
    statusEl.textContent = '…';
    _saveTimer = setTimeout(doSave, 600);
  }

  nameInput.addEventListener('input', scheduleAutoSave);
  typeSelect.addEventListener('change', scheduleAutoSave);
  for (const ta of Object.values(textareas)) {
    ta.addEventListener('input', scheduleAutoSave);
  }

  // Cache tokens immediately on open (background)
  {
    const allText = [char.name, char.description, char.personality, char.scenario, char.mesExample]
      .filter(Boolean).join('\n');
    countTokens(allText, pickEncoder(State)).then(n => setCachedTokens(char.id, n)).catch(() => {});
  }

  // ── Export as PNG ───────────────────────────────────────────────────────────
  exportBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/characters/${char.id}/export-png`;
    a.download = `${char.name || char.id}.png`;
    a.click();
  });

  // ── Delete ──────────────────────────────────────────────────────────────────
  deleteBtn.addEventListener('click', () => {
    confirmInline(deleteBtn, async () => {
      await deleteCharacter(char.id);
      State.characters = (State.characters ?? []).filter(c => c.id !== char.id);
      if (State.activeCharacterId === char.id) {
        State.activeCharacterId = null;
        await saveSettings({ activeCharacterId: null });
      }
      if (State.activePersonaId === char.id) {
        State.activePersonaId = null;
        State.activePersona   = null;
        await saveSettings({ activePersonaId: null });
      }
      _editorPanel?.close();
      onDelete?.();
    });
  });
}

// ── Subtab switching ──────────────────────────────────────────────────────────

function switchSubtab(tab) {
  _activeSubtab = tab;
  localStorage.setItem('charSubtab', tab);
  document.querySelectorAll('.char-subtab').forEach(btn =>
    btn.classList.toggle('char-subtab--active', btn.dataset.tab === tab));
  const content = document.getElementById('char-inline-content');
  if (!content) return;
  content.innerHTML = '';
  if (tab === 'editor') {
    renderEditor(content, _inlineChar, _State, {
      onSave:   () => { _inlineCallbacks.onSave?.(); },
      onDelete: () => { showBrowser(); _inlineCallbacks.onDelete?.(); },
    });
  } else if (tab === 'chats') {
    renderCharacterChats(content, _inlineChar, _State);
  }
}

// ── Character chats subtab ────────────────────────────────────────────────────

function relativeTime(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  const min  = Math.floor(diff / 60000);
  const hr   = Math.floor(diff / 3600000);
  const day  = Math.floor(diff / 86400000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  if (hr  < 24)  return `${hr}h ago`;
  if (day === 1) return 'yesterday';
  if (day < 7)   return `${day}d ago`;
  return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function renderCharacterChats(container, char, State) {
  container.innerHTML = '';

  // ── Shared select-mode state (captured by buildCharChatItem via closure) ──
  const selectCtx = {
    mode: false,
    selectedIds: new Set(),
    listEl: null,
    selectBtn: null,
    bulkBar: null,
    bulkCount: null,
  };

  function applySelectModeClass() {
    if (selectCtx.listEl) selectCtx.listEl.classList.toggle('char-chat-list--selecting', selectCtx.mode);
    if (selectCtx.selectBtn) selectCtx.selectBtn.classList.toggle('btn-ghost--active', selectCtx.mode);
    if (selectCtx.bulkBar) selectCtx.bulkBar.style.display = selectCtx.mode ? 'flex' : 'none';
  }

  function updateBulkCount() {
    if (selectCtx.bulkCount) selectCtx.bulkCount.textContent =
      `${selectCtx.selectedIds.size} selected`;
  }

  // ── Toolbar: icon-only buttons ──────────────────────────────────────────
  const newBtn = document.createElement('button');
  newBtn.className = 'btn-ghost char-chat-tool-btn';
  newBtn.title = 'New chat';
  newBtn.appendChild(icon(MessageSquarePlus, 16));
  newBtn.addEventListener('click', async () => {
    if (State.activeCharacterId !== char.id) {
      await saveSettings({ activeCharacterId: char.id });
      State.activeCharacterId = char.id;
      if (State.settings) State.settings.activeCharacterId = char.id;
    }
    await newSession(State);
    renderCharacterChats(container, char, State);
  });

  const importBtn = document.createElement('button');
  importBtn.className = 'btn-ghost char-chat-tool-btn';
  importBtn.title = 'Import chat (JSONL)';
  importBtn.appendChild(icon(Upload, 16));
  importBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jsonl';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      try {
        const res = await fetch('/api/history/import-jsonl', { method: 'POST', body: fd });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Import failed');
        showToast(`Imported "${result.title}" (${result.messageCount} messages)`, 'success');
        renderCharacterChats(container, char, State);
      } catch (err) {
        showToast('Import failed: ' + err.message, 'error');
      }
    });
    input.click();
  });

  const exportAllBtn = document.createElement('button');
  exportAllBtn.className = 'btn-ghost char-chat-tool-btn';
  exportAllBtn.title = 'Export all chats as zip';
  exportAllBtn.appendChild(icon(Package, 16));
  exportAllBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/history/export-character/${char.id}`;
    a.download = '';
    a.click();
  });

  const selectBtn = document.createElement('button');
  selectBtn.className = 'btn-ghost char-chat-tool-btn';
  selectBtn.title = 'Select mode';
  selectBtn.appendChild(icon(ListChecks, 16));
  selectBtn.addEventListener('click', () => {
    selectCtx.mode = !selectCtx.mode;
    selectBtn.title = selectCtx.mode ? 'Exit select mode' : 'Select mode';
    if (!selectCtx.mode) {
      selectCtx.selectedIds.clear();
      container.querySelectorAll('.char-chat-item--selected').forEach(el =>
        el.classList.remove('char-chat-item--selected'));
    }
    applySelectModeClass();
    updateBulkCount();
  });
  selectCtx.selectBtn = selectBtn;

  const btnRow = document.createElement('div');
  btnRow.className = 'char-chat-btn-row';
  btnRow.appendChild(newBtn);
  btnRow.appendChild(importBtn);
  btnRow.appendChild(exportAllBtn);
  btnRow.appendChild(selectBtn);
  container.appendChild(btnRow);

  // ── Bulk bar (trash icon, shown only in select mode) ─────────────────────
  const bulkBar = document.createElement('div');
  bulkBar.className = 'char-chat-bulk-bar';
  bulkBar.style.display = 'none';
  const bulkCount = document.createElement('span');
  bulkCount.className = 'hint';
  const bulkDeleteBtn = document.createElement('button');
  bulkDeleteBtn.className = 'btn-ghost char-chat-bulk-del';
  bulkDeleteBtn.title = 'Delete selected';
  bulkDeleteBtn.appendChild(icon(Trash2, 16));
  bulkDeleteBtn.addEventListener('click', () => {
    if (selectCtx.selectedIds.size === 0) return;
    confirmInline(bulkDeleteBtn, async () => {
      const ids = [...selectCtx.selectedIds];
      await Promise.all(ids.map(id => deleteSession(id)));
      for (const id of ids) {
        if (State.activeSessionId === id) {
          State.activeSessionId = null;
          State.chatHistory = [];
          State.sessionCharacter = null;
          localStorage.removeItem('lastSessionId');
          renderMessages(State);
        }
      }
      selectCtx.mode = false;
      showToast(`Deleted ${ids.length} chat${ids.length > 1 ? 's' : ''}`, 'success');
      renderCharacterChats(container, char, State);
    });
  });
  bulkBar.appendChild(bulkCount);
  bulkBar.appendChild(bulkDeleteBtn);
  selectCtx.bulkBar = bulkBar;
  selectCtx.bulkCount = bulkCount;
  updateBulkCount();

  // ── Fetch + render list ──────────────────────────────────────────────────
  const { sessions } = await getSessions();
  State.sessions = sessions;

  const charSessions = sessions
    .filter(s => s.characterId === char.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (charSessions.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '0.5rem 0';
    hint.textContent = 'No chats yet.';
    container.appendChild(hint);
    return;
  }

  const listEl = document.createElement('div');
  listEl.className = 'char-chat-list';
  selectCtx.listEl = listEl;
  for (const s of charSessions) {
    listEl.appendChild(buildCharChatItem(s, char, State, container, selectCtx, updateBulkCount));
  }
  container.appendChild(listEl);
  container.appendChild(bulkBar);
}

function buildCharChatItem(s, char, State, container, selectCtx, updateBulkCount) {
  const item = document.createElement('div');
  item.className = 'char-chat-item' + (s.id === State.activeSessionId ? ' char-chat-item--active' : '');
  item.dataset.sessionId = s.id;

  const top = document.createElement('div');
  top.className = 'char-chat-item-top';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'char-chat-item-title';
  titleSpan.textContent = s.title || 'New Chat';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'char-chat-item-time';
  timeSpan.textContent = relativeTime(s.updatedAt);

  const actionsEl = document.createElement('div');
  actionsEl.className = 'char-chat-item-actions';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'btn-ghost';
  renameBtn.title = 'Rename';
  renameBtn.appendChild(icon(Pencil, 14));

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn-ghost';
  exportBtn.title = 'Export';
  exportBtn.appendChild(icon(Download, 14));
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const a = document.createElement('a');
    a.href = `/api/history/${s.id}/export-jsonl`;
    a.download = '';
    a.click();
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-ghost';
  delBtn.title = 'Delete';
  delBtn.appendChild(icon(Trash2, 14));

  actionsEl.appendChild(renameBtn);
  actionsEl.appendChild(exportBtn);
  actionsEl.appendChild(delBtn);

  top.appendChild(titleSpan);
  top.appendChild(timeSpan);
  top.appendChild(actionsEl);
  item.appendChild(top);

  if (s.lastMessagePreview) {
    const preview = document.createElement('div');
    preview.className = 'char-chat-item-preview';
    preview.textContent = stripFormatting(s.lastMessagePreview, 140);
    item.appendChild(preview);
  }

  // Click: select-mode toggle, else open chat
  item.addEventListener('click', async (e) => {
    if (e.target.closest('.char-chat-item-actions')) return;
    if (selectCtx.mode) {
      const has = selectCtx.selectedIds.has(s.id);
      if (has) { selectCtx.selectedIds.delete(s.id); item.classList.remove('char-chat-item--selected'); }
      else     { selectCtx.selectedIds.add(s.id);    item.classList.add('char-chat-item--selected'); }
      updateBulkCount();
      return;
    }
    await selectSession(s.id, State);
    container.querySelectorAll('.char-chat-item--active').forEach(el =>
      el.classList.remove('char-chat-item--active'));
    item.classList.add('char-chat-item--active');
  });

  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const current = titleSpan.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'char-chat-rename-input';
    titleSpan.replaceWith(input);
    input.focus();
    input.select();
    const commit = async () => {
      const newTitle = input.value.trim() || current;
      if (newTitle !== current) {
        await updateSession(s.id, { title: newTitle });
        s.title = newTitle;
      }
      titleSpan.textContent = s.title;
      input.replaceWith(titleSpan);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.value = current; input.blur(); }
    });
  });

  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Hide siblings (display:none) so delBtn's ✓/✗ can occupy their reserved slot
    // without shifting the title column. `.char-chat-item-actions` has a fixed
    // min-width so no outer layout shift occurs.
    renameBtn.style.display = 'none';
    exportBtn.style.display = 'none';
    const restore = () => {
      renameBtn.style.display = '';
      exportBtn.style.display = '';
    };
    confirmInline(delBtn, async () => {
      restore();
      await deleteSession(s.id);
      if (State.activeSessionId === s.id) {
        State.activeSessionId = null;
        State.chatHistory = [];
        State.sessionCharacter = null;
        localStorage.removeItem('lastSessionId');
        renderMessages(State);
      }
      renderCharacterChats(container, char, State);
    }, restore);
  });

  return item;
}

let _chatsPanel = null;

function popOutChats(char, State) {
  if (!_chatsPanel) {
    _chatsPanel = createFloatingPanel({
      width: '480px',
      title: '',
      onClose: () => { _chatsPanel = null; },
    });
  }
  _chatsPanel.setTitle(`${char.name} — Chats`, null);
  _chatsPanel.setContent(c => renderCharacterChats(c, char, State));
  _chatsPanel.open();
}

// ── Pop-out Gallery ───────────────────────────────────────────────────────────

let _galleryPanel = null;

export function setTypeFilter(type) {
  _charTypeFilter = type;
  localStorage.setItem('charTypeFilter', type);
  document.querySelectorAll('.char-type-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === type));
  showBrowser();
  renderBrowser();
}

export function openGallery(State) {
  if (_galleryPanel) return;
  const search = createSearch();
  const panel  = createFloatingPanel({ width: '700px', title: 'Characters', onClose: () => { _galleryPanel = null; } });
  _galleryPanel = panel;

  function buildGalleryCard(meta) {
    const card = document.createElement('div');
    card.className = 'char-gallery-card' + (
      (meta.type === 'persona' ? meta.id === State.activePersonaId : meta.id === State.activeCharacterId)
        ? ' char-card--active' : '');

    const av = buildAvatarEl(meta.avatar ?? null, meta.name, 'lg', meta.id);
    av.classList.add('char-gallery-avatar');
    const nameEl = document.createElement('div');
    nameEl.className = 'char-card-name';
    nameEl.textContent = meta.name;

    card.appendChild(av);
    card.appendChild(nameEl);
    if (meta.type === 'persona') {
      const badge = document.createElement('span');
      badge.className = 'char-persona-badge-icon';
      badge.textContent = '👤';
      card.appendChild(badge);
    }

    card.addEventListener('click', () => {
      const goBack = () => {
        panel.setTitle('Characters', null);
        panel.setContent(c => buildGalleryContent(c));
      };
      panel.setTitle(meta.name, goBack);
      panel.setContent(c => {
        getCharacter(meta.id).then(char => {
          if (char) renderEditor(c, char, State, {
            onSave:   () => reloadBrowser(),
            onDelete: () => { reloadBrowser(); panel.close(); },
          });
        });
      });
    });
    return card;
  }

  function renderGalleryGrid(container, chars) {
    container.innerHTML = '';

    const characters = chars.filter(c => c.type !== 'persona');
    const personas   = chars.filter(c => c.type === 'persona');

    function appendSection(label, items) {
      if (!items.length) return;
      const sep = document.createElement('div');
      sep.className = 'char-gallery-sep';
      sep.textContent = label;
      container.appendChild(sep);
      const grid = document.createElement('div');
      grid.className = 'char-gallery-grid';
      items.forEach(meta => grid.appendChild(buildGalleryCard(meta)));
      container.appendChild(grid);
    }

    appendSection('Characters', characters);
    appendSection('Personas', personas);
  }

  function buildGalleryContent(container) {
    const toolbar = document.createElement('div');
    toolbar.className = 'char-gallery-toolbar';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search…';
    searchInput.className = 'char-gallery-search';

    toolbar.appendChild(searchInput);

    // Pill filter
    const pills = document.createElement('div');
    pills.className = 'char-gallery-pills';
    let _galleryTypeFilter = 'all';
    for (const { type, label } of [{ type: 'all', label: 'All' }, { type: 'character', label: 'Characters' }, { type: 'persona', label: 'Personas' }]) {
      const btn = document.createElement('button');
      btn.className = 'char-gallery-pill' + (type === 'all' ? ' active' : '');
      btn.dataset.type = type;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        _galleryTypeFilter = type;
        pills.querySelectorAll('.char-gallery-pill').forEach(b =>
          b.classList.toggle('active', b.dataset.type === type));
        refresh(searchInput.value);
      });
      pills.appendChild(btn);
    }
    toolbar.appendChild(pills);

    container.appendChild(toolbar);

    search.register('characters', () => (State.characters ?? []).map(c => ({
      id: c.id, label: c.name, sublabel: stripFormatting(c.creatorNotes, 80),
    })));

    const gridWrap = document.createElement('div');
    container.appendChild(gridWrap);

    function refresh(term) {
      const results = search.query(term);
      const matched = results.flatMap(g => g.items);
      let chars = term
        ? (State.characters ?? []).filter(c => matched.some(m => m.id === c.id))
        : (State.characters ?? []);
      if (_galleryTypeFilter !== 'all') {
        chars = chars.filter(c =>
          _galleryTypeFilter === 'persona' ? c.type === 'persona' : c.type !== 'persona');
      }
      renderGalleryGrid(gridWrap, chars);
    }

    searchInput.addEventListener('input', () => refresh(searchInput.value));
    refresh('');
  }

  panel.setContent(c => buildGalleryContent(c));
  panel.open();
}
