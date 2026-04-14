import {
  getSettings, saveSettings, fetchModels,
  getConnections, createConnection, updateConnection, deleteConnection,
  setActiveConnection,
  getPromptPresets, updatePromptPreset,
} from '../lib/api.js';
import { createColorPicker } from '../lib/colorPicker.js';
import { icon, Plus, Copy, Trash2, AlignLeft, AlignCenter, AlignRight, AlignJustify } from '../lib/icons.js';
import { confirmInline } from '../lib/confirmInline.js';
import { showToast } from '../lib/toast.js';
import { applyDisplayMode, applyAnimationsMode, applyAlwaysShowActions } from './chat.js';

const el = id => document.getElementById(id);

const CHAT_FONTS = [
  { label: 'System Default', value: 'system', stack: "system-ui, 'Segoe UI', sans-serif" },
  { label: 'Lora',            value: 'Lora',            stack: "'Lora', serif" },
  { label: 'Libre Baskerville', value: 'Libre Baskerville', stack: "'Libre Baskerville', serif" },
  { label: 'Crimson Text',    value: 'Crimson Text',    stack: "'Crimson Text', serif" },
  { label: 'EB Garamond',     value: 'EB Garamond',     stack: "'EB Garamond', serif" },
  { label: 'Source Serif 4',  value: 'Source Serif 4',  stack: "'Source Serif 4', serif" },
];

const UI_FONTS = [
  { label: 'System Default', value: 'system', stack: "system-ui, 'Segoe UI', sans-serif" },
  { label: 'Inter',           value: 'Inter',           stack: "'Inter', sans-serif" },
  { label: 'IBM Plex Sans',   value: 'IBM Plex Sans',   stack: "'IBM Plex Sans', sans-serif" },
  { label: 'Source Sans 3',   value: 'Source Sans 3',   stack: "'Source Sans 3', sans-serif" },
];


function hashToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

function renderAvatarPreview(container, avatarPath, name) {
  if (!container) return;
  container.innerHTML = '';
  if (avatarPath) {
    const img = document.createElement('img');
    img.src = `${avatarPath}?t=${Date.now()}`;
    img.className = 'avatar-img avatar-img--lg';
    img.alt = name || '';
    container.appendChild(img);
  } else {
    const hue = hashToHue(name || 'default');
    const circle = document.createElement('div');
    circle.className = 'avatar-initials avatar-initials--lg';
    circle.style.background = `hsl(${hue}, 40%, 25%)`;
    circle.style.color = `hsl(${hue}, 60%, 70%)`;
    circle.textContent = (name || '?')[0].toUpperCase();
    container.appendChild(circle);
  }
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Module-level state ────────────────────────────────────────────────────────

let _connections    = [];
let _activeConnId   = null;
let _promptPresets  = [];
let _activePromptId = null;
let _settings       = null;

// ── Sub-tab switching ─────────────────────────────────────────────────────────

export function switchSubTab(name) {
  document.querySelectorAll('.sub-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.subtab === name));
  document.querySelectorAll('.sub-tab-content').forEach(d =>
    d.classList.toggle('active', d.id === `settings-${name}`));
  localStorage.setItem('lastSettingsSubTab', name);
}

// ── Connection tab helpers ────────────────────────────────────────────────────

function populateConnSelect() {
  const sel = el('conn-preset-select');
  if (!sel) return;
  sel.innerHTML = _connections.map(p =>
    `<option value="${esc(p.id)}" ${p.id === _activeConnId ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
}

// ── Model select helpers ──────────────────────────────────────────────────────

// Read the effective model value (select or manual input)
function getModelValue() {
  const sel = el('conn-model-select');
  return sel?.value === '__manual__'
    ? (el('conn-model-manual')?.value.trim() ?? '')
    : (sel?.value ?? '');
}

// Populate the model select. Pass a models array after fetch; omit/null for init.
function setModelSelect(currentModel, models = null) {
  const sel    = el('conn-model-select');
  const manual = el('conn-model-manual');
  if (!sel || !manual) return;

  if (models !== null) {
    // Full list from fetch
    sel.innerHTML =
      models.map(m => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('') +
      `<option value="__manual__">── Type manually ──</option>`;
  } else {
    // Init: show current model (if any) as sole option until fetch
    sel.innerHTML = currentModel
      ? `<option value="${esc(currentModel)}">${esc(currentModel)}</option>
         <option value="__manual__">── Type manually ──</option>`
      : `<option value="">— fetch or type a model name —</option>
         <option value="__manual__">── Type manually ──</option>`;
  }

  // Select the current model; fall back to manual if it's not in the list
  if (currentModel && sel.querySelector(`option[value="${esc(currentModel)}"]`)) {
    sel.value = currentModel;
    manual.style.display = 'none';
  } else if (currentModel) {
    sel.value = '__manual__';
    manual.value = currentModel;
    manual.style.display = '';
  } else {
    sel.value = models !== null ? '' : '';
    manual.style.display = 'none';
  }
}

function cachedModels(presetId) {
  try { return JSON.parse(localStorage.getItem(`models:${presetId}`) ?? 'null'); } catch { return null; }
}

function populateConnForm(preset) {
  if (!preset) return;
  el('conn-name').value     = preset.name          ?? '';
  el('conn-provider').value = preset.provider       ?? 'openai';
  el('conn-baseurl').value  = preset.baseURL        ?? '';
  const urlDefaults = { openrouter: 'https://openrouter.ai/api/v1', anthropic: 'https://api.anthropic.com/v1' };
  el('conn-baseurl').placeholder = urlDefaults[preset.provider] ?? 'https://api.example.com/v1';
  el('conn-apikey').value   = preset.apiKey         ?? '';
  const cached = cachedModels(preset.id);
  setModelSelect(preset.selectedModel ?? '', cached);
  if (cached) el('conn-model-status').textContent = `${cached.length} models (cached)`;
  const enabled = preset.reasoning?.enabled ?? false;
  el('reasoning-toggle').checked = enabled;
  el('effort-pills').style.display = enabled ? 'flex' : 'none';
  const effort = preset.reasoning?.effort || 'medium';
  document.querySelectorAll('.effort-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.effort === effort));
}

function activeConnPreset() {
  return _connections.find(p => p.id === _activeConnId);
}

async function saveConnPreset(statusEl) {
  if (!_activeConnId) return;
  if (statusEl) statusEl.textContent = 'Saving…';
  try {
    const data = {
      name:          el('conn-name').value.trim() || 'Unnamed',
      provider:      el('conn-provider').value,
      baseURL:       el('conn-baseurl').value.trim(),
      apiKey:        el('conn-apikey').value,
      selectedModel: getModelValue(),
      reasoning: {
        enabled: el('reasoning-toggle').checked,
        effort:  document.querySelector('.effort-pill.active')?.dataset.effort || 'medium',
      },
    };
    const { preset: updated } = await updateConnection(_activeConnId, data);
    const idx = _connections.findIndex(p => p.id === _activeConnId);
    if (idx >= 0) _connections[idx] = updated;
    populateConnSelect();
    if (statusEl) {
      statusEl.textContent = 'Saved';
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }

  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  }
}

// ── Generation tab helpers ────────────────────────────────────────────────────

const GEN_KEYS = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty'];

function populateGenForm(gs) {
  const defaults = { temperature: 0.85, top_p: 0.95, frequency_penalty: 0, presence_penalty: 0, max_tokens: 1000, context_size: 0 };
  const vals = { ...defaults, ...gs };
  for (const key of GEN_KEYS) {
    const s = el(`gs-${key}`);
    const v = el(`gv-${key}`);
    if (s) s.value = vals[key];
    if (v) v.textContent = parseFloat(vals[key]).toFixed(2);
  }
  const mt = el('gs-max_tokens');
  if (mt) mt.value = vals.max_tokens;
  const cs = el('gs-context_size');
  if (cs) cs.value = vals.context_size;
}

function readGenForm() {
  return {
    temperature:       parseFloat(el('gs-temperature').value),
    top_p:             parseFloat(el('gs-top_p').value),
    frequency_penalty: parseFloat(el('gs-frequency_penalty').value),
    presence_penalty:  parseFloat(el('gs-presence_penalty').value),
    max_tokens:        parseInt(el('gs-max_tokens').value, 10) || 1000,
    context_size:      parseInt(el('gs-context_size').value, 10) || 0,
  };
}


function updateGenPresetLabel() {
  const label = el('gen-preset-label');
  if (!label) return;
  const preset = _promptPresets.find(p => p.id === _activePromptId);
  label.textContent = preset ? `Generation settings for: ${preset.name}` : '';
}

// ── Display tab helpers ───────────────────────────────────────────────────────

function updateDeleteButtons(mode) {
  const s = el('d-delete-single'); if (s) s.className = mode === 'single' ? 'btn-primary' : 'btn-secondary';
  const c = el('d-delete-chain');  if (c) c.className = mode === 'chain'  ? 'btn-primary' : 'btn-secondary';
}

function updateAnimationsButtons(mode) {
  const a = el('d-anim-animated'); if (a) a.className = mode === 'animated' ? 'btn-primary' : 'btn-secondary';
  const i = el('d-anim-instant');  if (i) i.className = mode === 'instant'  ? 'btn-primary' : 'btn-secondary';
}

function updateDisplayModeButtons(mode) {
  el('d-mode-bubble')?.classList.toggle('btn-primary', mode === 'bubble');
  el('d-mode-bubble')?.classList.toggle('btn-secondary', mode !== 'bubble');
  el('d-mode-manuscript')?.classList.toggle('btn-primary', mode === 'manuscript');
  el('d-mode-manuscript')?.classList.toggle('btn-secondary', mode !== 'manuscript');
}

function applyChatAlign(align) {
  document.body.classList.remove('chat-align-left', 'chat-align-center', 'chat-align-right', 'chat-align-justify');
  document.body.classList.add(`chat-align-${align}`);
}

function updateAlignButtons(align) {
  for (const v of ['left', 'center', 'right', 'justify']) {
    const b = el(`d-align-${v}`);
    if (b) b.className = v === align ? 'btn-primary' : 'btn-secondary';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function init(State, container) {
  container.innerHTML = `
    <div class="settings-sub-tabs">
      <button class="sub-tab-btn active" data-subtab="connection">Connection</button>
      <button class="sub-tab-btn" data-subtab="generation">Generation</button>
      <button class="sub-tab-btn" data-subtab="display">Display</button>
    </div>
    <div class="settings-sub-content">

      <!-- Connection -->
      <div id="settings-connection" class="sub-tab-content active">
        <div class="conn-preset-row">
          <select id="conn-preset-select"></select>
          <button id="conn-new" class="btn-ghost preset-icon-btn" title="New preset"></button>
          <button id="conn-dup" class="btn-ghost preset-icon-btn" title="Duplicate preset"></button>
          <button id="conn-del" class="btn-ghost preset-icon-btn" title="Delete preset"></button>
        </div>
        <div class="field-group">
          <label>Preset Name</label>
          <input id="conn-name" type="text" placeholder="My Connection" />
        </div>
        <div class="field-group">
          <label>Provider</label>
          <select id="conn-provider">
            <option value="openai">OpenAI-Compatible</option>
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
        <div class="field-group">
          <label>Base URL</label>
          <input id="conn-baseurl" type="text" placeholder="https://openrouter.ai/api/v1" />
        </div>
        <div class="field-group">
          <label>API Key</label>
          <div class="row-inline">
            <input id="conn-apikey" type="password" placeholder="Enter API key" autocomplete="off" />
            <button id="conn-apikey-show" class="btn-ghost">Show</button>
          </div>
          <span class="hint">Write-only — existing key shown as ••••</span>
        </div>
        <div class="field-group">
          <label>Model</label>
          <div class="row-inline">
            <select id="conn-model-select" style="flex:1;min-width:0">
              <option value="">— fetch or type a model name —</option>
              <option value="__manual__">── Type manually ──</option>
            </select>
            <button id="conn-fetch-models" class="btn-secondary">Fetch</button>
          </div>
          <input id="conn-model-manual" type="text" placeholder="model-id" style="display:none;margin-top:4px;width:100%;box-sizing:border-box" />
          <span id="conn-model-status" class="hint"></span>
        </div>
        <div class="reasoning-section">
          <label><input type="checkbox" id="reasoning-toggle" /> Enable Reasoning</label>
          <div id="effort-pills" class="effort-pills" style="display:none">
            <button class="effort-pill" data-effort="low">Low</button>
            <button class="effort-pill active" data-effort="medium">Med</button>
            <button class="effort-pill" data-effort="high">High</button>
          </div>
        </div>
      </div>

      <!-- Generation -->
      <div id="settings-generation" class="sub-tab-content">
        <p id="gen-preset-label" class="hint" style="margin:0 0 8px"></p>
        <div class="gen-row">
          <span class="gen-label">Temperature</span>
          <span class="gen-value" id="gv-temperature">0.85</span>
        </div>
        <input type="range" id="gs-temperature" min="0" max="2" step="0.05" value="0.85" />
        <div class="gen-row">
          <span class="gen-label">Top P</span>
          <span class="gen-value" id="gv-top_p">0.95</span>
        </div>
        <input type="range" id="gs-top_p" min="0" max="1" step="0.05" value="0.95" />
        <div class="gen-row">
          <span class="gen-label">Frequency Penalty</span>
          <span class="gen-value" id="gv-frequency_penalty">0.00</span>
        </div>
        <input type="range" id="gs-frequency_penalty" min="0" max="2" step="0.05" value="0" />
        <div class="gen-row">
          <span class="gen-label">Presence Penalty</span>
          <span class="gen-value" id="gv-presence_penalty">0.00</span>
        </div>
        <input type="range" id="gs-presence_penalty" min="0" max="2" step="0.05" value="0" />
        <div class="field-group" style="margin-top:0.25rem">
          <label>Max Tokens</label>
          <input id="gs-max_tokens" type="number" min="1" max="32000" value="1000" />
        </div>
        <div class="field-group" style="margin-top:0.25rem">
          <label>Context Size (tokens)</label>
          <input id="gs-context_size" type="number" min="0" max="1000000" value="0" />
          <span class="hint">Max prompt tokens to send. 0 = no limit.</span>
        </div>
      </div>

      <!-- Display -->
      <div id="settings-display" class="sub-tab-content">

        <div class="settings-section">
          <h4 class="settings-section-heading">Layout</h4>
          <div class="field-group">
            <label>Display Mode</label>
            <div class="row-inline">
              <button id="d-mode-bubble" class="btn-secondary">Bubble</button>
              <button id="d-mode-manuscript" class="btn-secondary">Manuscript</button>
              <label class="checkbox-label" style="margin-left:auto"><input type="checkbox" id="d-dividers" /> Dividers</label>
            </div>
          </div>
          <div class="compact-slider">
            <label>Chat Width <span class="gen-value" id="d-chat-width-value">100%</span></label>
            <input type="range" id="d-chat-width" min="50" max="100" step="5" value="100" />
          </div>
          <div class="field-group">
            <label>Chat Alignment</label>
            <div class="row-inline">
              <button id="d-align-left" class="btn-secondary" title="Left"></button>
              <button id="d-align-center" class="btn-secondary" title="Center"></button>
              <button id="d-align-right" class="btn-secondary" title="Right"></button>
              <button id="d-align-justify" class="btn-secondary" title="Justify"></button>
            </div>
          </div>
          <div class="field-group" style="margin-top:0.75rem">
            <label>Delete Behaviour</label>
            <div class="row-inline">
              <button id="d-delete-single" class="btn-secondary">Single message</button>
              <button id="d-delete-chain" class="btn-secondary">Message + following</button>
            </div>
          </div>
          <div class="field-group" style="margin-top:0.75rem">
            <label>Animations</label>
            <div class="row-inline">
              <button id="d-anim-animated" class="btn-secondary">Animated</button>
              <button id="d-anim-instant" class="btn-secondary">Instant</button>
              <label class="checkbox-label" style="margin-left:auto"><input type="checkbox" id="d-always-actions" /> Always show message actions</label>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h4 class="settings-section-heading">Appearance</h4>
          <div class="field-group color-field">
            <label>Dialogue Color</label>
            <div class="color-swatch-btn" id="d-dialogue-color-trigger">
              <div class="color-trigger-swatch" id="d-dialogue-color-swatch"></div>
            </div>
          </div>
          <div class="field-group">
            <label>Avatar Shape</label>
            <div class="avatar-shape-row" id="d-avatar-shape-row">
              <button class="avatar-shape-btn" data-shape="circle"   title="Circle"><span class="avatar-shape-preview avatar-shape-preview--circle"></span>Circle</button>
              <button class="avatar-shape-btn" data-shape="rounded"  title="Rounded"><span class="avatar-shape-preview avatar-shape-preview--rounded"></span>Rounded</button>
              <button class="avatar-shape-btn" data-shape="square"   title="Square"><span class="avatar-shape-preview avatar-shape-preview--square"></span>Square</button>
              <button class="avatar-shape-btn" data-shape="portrait" title="Portrait"><span class="avatar-shape-preview avatar-shape-preview--portrait"></span>Portrait</button>
            </div>
          </div>
        </div>

        <div class="settings-section">
          <h4 class="settings-section-heading">Typography</h4>
          <div class="field-group">
            <label>Chat Font</label>
            <div class="font-row">
              <select id="d-chat-font">
                <option value="system">System Default</option>
                <option value="Lora">Lora</option>
                <option value="Libre Baskerville">Libre Baskerville</option>
                <option value="Crimson Text">Crimson Text</option>
                <option value="EB Garamond">EB Garamond</option>
                <option value="Source Serif 4">Source Serif 4</option>
              </select>
              <input id="d-chat-font-size" type="number" min="10" max="32" step="1" title="Font size (px)" />
            </div>
          </div>
          <div class="field-group">
            <label>UI Font</label>
            <div class="font-row">
              <select id="d-ui-font">
                <option value="system">System Default</option>
                <option value="Inter">Inter</option>
                <option value="IBM Plex Sans">IBM Plex Sans</option>
                <option value="Source Sans 3">Source Sans 3</option>
              </select>
              <input id="d-ui-font-size" type="number" min="10" max="32" step="1" title="Font size (px)" />
            </div>
          </div>
          <div class="compact-slider">
            <label>Line Height <span class="gen-value" id="d-chat-line-height-value">1.6</span></label>
            <input type="range" id="d-chat-line-height" min="1" max="2.5" step="0.05" value="1.6" />
          </div>
          <div class="compact-slider">
            <label>Message Spacing <span class="gen-value" id="d-msg-gap-value">0.4</span></label>
            <input type="range" id="d-msg-gap" min="0" max="2" step="0.05" value="0.4" />
          </div>
          <div class="compact-slider">
            <label>Paragraph Spacing <span class="gen-value" id="d-para-gap-value">0.75</span></label>
            <input type="range" id="d-para-gap" min="0" max="2" step="0.05" value="0.75" />
          </div>
        </div>

        <div class="settings-section">
          <h4 class="settings-section-heading">Message Info</h4>
          <div class="checkbox-row">
            <label class="checkbox-label"><input type="checkbox" id="d-show-model" /> Show model</label>
            <label class="checkbox-label"><input type="checkbox" id="d-show-tokens" /> Show tokens</label>
            <label class="checkbox-label"><input type="checkbox" id="d-show-duration" /> Show generation time</label>
          </div>
        </div>

      </div>

    </div>
  `;

  // Sub-tab switching — restore last visited subtab
  container.querySelectorAll('.sub-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchSubTab(btn.dataset.subtab));
  });
  const lastSubTab = localStorage.getItem('lastSettingsSubTab');
  if (lastSubTab) switchSubTab(lastSubTab);

  // Load data
  try {
    const [connData, presetData, settings] = await Promise.all([
      getConnections(),
      getPromptPresets(),
      getSettings(),
    ]);
    _connections    = connData.presets;
    _activeConnId   = connData.activeId;
    _promptPresets  = presetData.presets;
    _activePromptId = presetData.activeId;
    _settings = settings;
    if (State) State.settings = settings;
  } catch (err) {
    console.error('Settings init failed to load data:', err);
    return;
  }

  // ── Connection tab ────────────────────────────────────────────────────────

  populateConnSelect();
  populateConnForm(activeConnPreset());

  el('conn-preset-select').addEventListener('change', async (e) => {
    try {
      await setActiveConnection(e.target.value);
      _activeConnId = e.target.value;
      populateConnForm(_connections.find(p => p.id === _activeConnId));
  
    } catch (err) {
      console.error('Failed to switch connection preset:', err);
    }
  });

  el('conn-new').appendChild(icon(Plus, 16));
  el('conn-dup').appendChild(icon(Copy, 16));
  el('conn-del').appendChild(icon(Trash2, 16));

  el('conn-new').addEventListener('click', async () => {
    try {
      const { preset } = await createConnection({
        name: 'New Connection',
        provider: 'openai',
        baseURL: '',
        apiKey: '',
        selectedModel: '',
        reasoning: { enabled: false, effort: 'medium' },
      });
      await setActiveConnection(preset.id);
      _connections.push(preset);
      _activeConnId = preset.id;
      populateConnSelect();
      populateConnForm(preset);
    } catch (err) {
      console.error('Failed to create connection preset:', err);
    }
  });

  el('conn-dup').addEventListener('click', async () => {
    const src = activeConnPreset();
    if (!src) return;
    try {
      const { preset } = await createConnection({
        ...src,
        name: (el('conn-name').value.trim() || src.name) + ' (copy)',
        apiKey: '', // don't copy masked key — user must re-enter
      });
      await setActiveConnection(preset.id);
      _connections.push(preset);
      _activeConnId = preset.id;
      populateConnSelect();
      populateConnForm(preset);
    } catch (err) {
      console.error('Failed to duplicate connection preset:', err);
    }
  });

  el('conn-del').addEventListener('click', () => {
    if (_connections.length < 2) { showToast('Cannot delete the last connection preset.', 'error'); return; }
    const src = activeConnPreset();
    if (!src) return;
    confirmInline(el('conn-del'), async () => {
      try {
        const { activeId } = await deleteConnection(_activeConnId);
        _connections = _connections.filter(p => p.id !== src.id);
        _activeConnId = activeId;
        populateConnSelect();
        populateConnForm(_connections.find(p => p.id === _activeConnId));
      } catch (err) {
        console.error('Failed to delete connection preset:', err);
      }
    });
  });

  el('conn-name').addEventListener('blur', () => saveConnPreset(null));
  el('conn-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveConnPreset(null); }
  });
  el('conn-provider').addEventListener('change', () => {
    const provider = el('conn-provider').value;
    const urlInput = el('conn-baseurl');
    const cur = urlInput.value.trim();
    // Auto-fill base URL when switching providers (if empty or a known default for another provider)
    const defaults = {
      openrouter: 'https://openrouter.ai/api/v1',
      anthropic:  'https://api.anthropic.com/v1',
    };
    const knownDefaults = new Set(Object.values(defaults));
    if (!cur || knownDefaults.has(cur)) {
      urlInput.value = defaults[provider] ?? '';
    }
    urlInput.placeholder = defaults[provider] ?? 'https://api.example.com/v1';
    saveConnPreset(null);
  });
  el('conn-baseurl').addEventListener('blur', () => saveConnPreset(null));
  el('conn-apikey').addEventListener('blur', () => saveConnPreset(null));

  el('conn-fetch-models').addEventListener('click', async () => {
    const statusEl = el('conn-model-status');
    statusEl.textContent = 'Saving…';
    await saveConnPreset(null);
    statusEl.textContent = 'Fetching…';
    try {
      const { models } = await fetchModels();
      setModelSelect(getModelValue(), models);
      const preset = activeConnPreset();
      if (preset) localStorage.setItem(`models:${preset.id}`, JSON.stringify(models));
      statusEl.textContent = `${models.length} models loaded`;
    } catch (err) {
      statusEl.textContent = 'Error: ' + err.message;
    }
  });

  el('conn-model-select').addEventListener('change', () => {
    const manual = el('conn-model-manual');
    const isManual = el('conn-model-select').value === '__manual__';
    manual.style.display = isManual ? '' : 'none';
    if (isManual) manual.focus();
    else saveConnPreset(null);
  });
  el('conn-model-manual').addEventListener('blur', () => saveConnPreset(null));

  el('conn-apikey-show').addEventListener('click', () => {
    const input = el('conn-apikey');
    input.type = input.type === 'password' ? 'text' : 'password';
    el('conn-apikey-show').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });

  el('reasoning-toggle').addEventListener('change', async () => {
    el('effort-pills').style.display = el('reasoning-toggle').checked ? 'flex' : 'none';
    await saveConnPreset(null);

  });

  document.querySelectorAll('.effort-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.effort-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await saveConnPreset(null);
    });
  });

  // ── Generation tab ────────────────────────────────────────────────────────

  const activePromptPreset = _promptPresets.find(p => p.id === _activePromptId);
  populateGenForm(activePromptPreset?.generationSettings ?? {});
  updateGenPresetLabel();

  let genSaveTimer = null;
  function scheduleGenSave() {
    clearTimeout(genSaveTimer);
    genSaveTimer = setTimeout(async () => {
      try {
        await updatePromptPreset(_activePromptId, { generationSettings: readGenForm() });
      } catch (err) {
        console.error('Failed to save generation settings:', err);
      }
    }, 300);
  }

  for (const key of GEN_KEYS) {
    const slider  = el(`gs-${key}`);
    const display = el(`gv-${key}`);
    if (slider) slider.addEventListener('input', () => {
      display.textContent = parseFloat(slider.value).toFixed(2);
      scheduleGenSave();
    });
  }
  const mt = el('gs-max_tokens');
  if (mt) mt.addEventListener('change', scheduleGenSave);
  const cs = el('gs-context_size');
  if (cs) cs.addEventListener('change', scheduleGenSave);

  // ── Display tab ───────────────────────────────────────────────────────────

  updateDisplayModeButtons(_settings?.chatDisplayMode || 'bubble');

  document.addEventListener('displaymodechange', (e) => updateDisplayModeButtons(e.detail.mode));

  function applyMode(mode) {
    applyDisplayMode(mode);
  }

  applyMode(_settings?.chatDisplayMode || 'bubble');

  el('d-mode-bubble').addEventListener('click', async () => {
    applyMode('bubble');
    updateDisplayModeButtons('bubble');
    await saveSettings({ chatDisplayMode: 'bubble' });
    if (_settings) _settings.chatDisplayMode = 'bubble';
    if (window._State?.settings) window._State.settings.chatDisplayMode = 'bubble';
  });

  el('d-mode-manuscript').addEventListener('click', async () => {
    applyMode('manuscript');
    updateDisplayModeButtons('manuscript');
    await saveSettings({ chatDisplayMode: 'manuscript' });
    if (_settings) _settings.chatDisplayMode = 'manuscript';
    if (window._State?.settings) window._State.settings.chatDisplayMode = 'manuscript';
  });

  // Delete behaviour toggle
  updateDeleteButtons(_settings?.deleteMode ?? 'single');
  el('d-delete-single').addEventListener('click', async () => {
    await saveSettings({ deleteMode: 'single' });
    if (_settings) _settings.deleteMode = 'single';
    if (window._State?.settings) window._State.settings.deleteMode = 'single';
    updateDeleteButtons('single');
  });
  el('d-delete-chain').addEventListener('click', async () => {
    await saveSettings({ deleteMode: 'chain' });
    if (_settings) _settings.deleteMode = 'chain';
    if (window._State?.settings) window._State.settings.deleteMode = 'chain';
    updateDeleteButtons('chain');
  });

  // Animations toggle
  const initialAnim = _settings?.animationsMode ?? 'animated';
  applyAnimationsMode(initialAnim);
  updateAnimationsButtons(initialAnim);
  el('d-anim-animated').addEventListener('click', async () => {
    applyAnimationsMode('animated');
    updateAnimationsButtons('animated');
    await saveSettings({ animationsMode: 'animated' });
    if (_settings) _settings.animationsMode = 'animated';
    if (window._State?.settings) window._State.settings.animationsMode = 'animated';
  });
  el('d-anim-instant').addEventListener('click', async () => {
    applyAnimationsMode('instant');
    updateAnimationsButtons('instant');
    await saveSettings({ animationsMode: 'instant' });
    if (_settings) _settings.animationsMode = 'instant';
    if (window._State?.settings) window._State.settings.animationsMode = 'instant';
  });

  // Always show message actions
  el('d-always-actions').checked = _settings?.alwaysShowMsgActions ?? false;
  applyAlwaysShowActions(el('d-always-actions').checked);
  el('d-always-actions').addEventListener('change', async () => {
    const on = el('d-always-actions').checked;
    applyAlwaysShowActions(on);
    await saveSettings({ alwaysShowMsgActions: on });
    if (_settings) _settings.alwaysShowMsgActions = on;
    if (window._State?.settings) window._State.settings.alwaysShowMsgActions = on;
  });

  el('d-dividers').checked = _settings?.showMsgDividers ?? false;
  el('d-dividers').addEventListener('change', async () => {
    const on = el('d-dividers').checked;
    document.body.classList.toggle('chat-dividers', on);
    const updated = await saveSettings({ showMsgDividers: on });
    if (_settings) _settings.showMsgDividers = on;
    if (window._State?.settings) window._State.settings.showMsgDividers = on;
  });

  // Message info checkboxes
  el('d-show-model').checked    = _settings?.showMsgModel    ?? false;
  el('d-show-tokens').checked   = _settings?.showMsgTokens   ?? false;
  el('d-show-duration').checked = _settings?.showMsgDuration ?? false;

  async function saveMsgInfoToggle() {
    const updated = await saveSettings({
      showMsgModel:    el('d-show-model').checked,
      showMsgTokens:   el('d-show-tokens').checked,
      showMsgDuration: el('d-show-duration').checked,
    });
    if (_settings) Object.assign(_settings, updated);
    if (window._State) {
      Object.assign(window._State.settings, updated);
      window._rerenderMeta?.(window._State);
    }
  }
  el('d-show-model').addEventListener('change', saveMsgInfoToggle);
  el('d-show-tokens').addEventListener('change', saveMsgInfoToggle);
  el('d-show-duration').addEventListener('change', saveMsgInfoToggle);

  const initialWidth = _settings?.chatMaxWidth ?? 100;
  el('d-chat-width').value = initialWidth;
  el('d-chat-width-value').textContent = initialWidth + '%';
  let widthSaveTimer = null;
  el('d-chat-width').addEventListener('input', () => {
    const v = el('d-chat-width').value;
    el('d-chat-width-value').textContent = v + '%';
    document.documentElement.style.setProperty('--chat-max-width', v + '%');
    clearTimeout(widthSaveTimer);
    widthSaveTimer = setTimeout(() => saveSettings({ chatMaxWidth: parseInt(v, 10) }), 300);
  });
  el('d-chat-width').addEventListener('change', () => {
    clearTimeout(widthSaveTimer);
    saveSettings({ chatMaxWidth: parseInt(el('d-chat-width').value, 10) });
  });

  // Chat alignment
  const alignIcons = { left: AlignLeft, center: AlignCenter, right: AlignRight, justify: AlignJustify };
  const initialAlign = _settings?.chatAlign ?? 'center';
  applyChatAlign(initialAlign);
  updateAlignButtons(initialAlign);
  for (const v of ['left', 'center', 'right', 'justify']) {
    el(`d-align-${v}`).appendChild(icon(alignIcons[v], 16));
    el(`d-align-${v}`).addEventListener('click', async () => {
      applyChatAlign(v);
      updateAlignButtons(v);
      await saveSettings({ chatAlign: v });
      if (_settings) _settings.chatAlign = v;
      if (window._State?.settings) window._State.settings.chatAlign = v;
    });
  }

  const initialColor = _settings?.dialogueColor || '#ef6b6b';
  el('d-dialogue-color-swatch').style.background = initialColor;

  const dialoguePicker = createColorPicker({
    anchor: el('d-dialogue-color-trigger'),
    initialColor,
    presets: ['#ef6b6b', '#e8a87c', '#d4e157', '#81c784', '#64b5f6', '#ba68c8', '#f48fb1', '#ffffff', '#b0b0b0'],
    onChange(hex) {
      document.documentElement.style.setProperty('--dialogue-color', hex);
      el('d-dialogue-color-swatch').style.background = hex;
    },
    onClose(hex) {
      saveSettings({ dialogueColor: hex });
    },
  });

  el('d-dialogue-color-trigger').addEventListener('click', () => dialoguePicker.open());

  // Avatar shape selector
  function updateShapeButtons(shape) {
    el('d-avatar-shape-row').querySelectorAll('.avatar-shape-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.shape === shape));
  }
  updateShapeButtons(_settings?.avatarShape ?? 'circle');
  el('d-avatar-shape-row').addEventListener('click', async (e) => {
    const btn = e.target.closest('.avatar-shape-btn');
    if (!btn) return;
    const shape = btn.dataset.shape;
    window._applyAvatarShape?.(shape);
    updateShapeButtons(shape);
    await saveSettings({ avatarShape: shape });
    if (_settings) _settings.avatarShape = shape;
    if (window._State?.settings) window._State.settings.avatarShape = shape;
  });

  // Font selectors
  function applyFont(cssVar, fontValue, fonts) {
    const font = fonts.find(f => f.value === fontValue);
    if (!font) return;
    document.documentElement.style.setProperty(cssVar, font.stack);
  }

  const initialChatFont = _settings?.chatFont ?? 'system';
  const initialUiFont   = _settings?.uiFont   ?? 'system';
  el('d-chat-font').value = initialChatFont;
  el('d-ui-font').value   = initialUiFont;

  el('d-chat-font').addEventListener('change', async () => {
    const v = el('d-chat-font').value;
    applyFont('--font-chat', v, CHAT_FONTS);
    await saveSettings({ chatFont: v });
    if (_settings) _settings.chatFont = v;
  });

  el('d-ui-font').addEventListener('change', async () => {
    const v = el('d-ui-font').value;
    applyFont('--font-ui', v, UI_FONTS);
    await saveSettings({ uiFont: v });
    if (_settings) _settings.uiFont = v;
  });

  // Font size inputs
  el('d-chat-font-size').value = _settings?.chatFontSize ?? 14;
  el('d-ui-font-size').value   = _settings?.uiFontSize   ?? 13;

  // Line height slider
  const lhVal = _settings?.chatLineHeight ?? 1.6;
  el('d-chat-line-height').value = lhVal;
  el('d-chat-line-height-value').textContent = lhVal;

  let chatFontSizeTimer = null;
  el('d-chat-font-size').addEventListener('input', () => {
    const v = Math.min(32, Math.max(10, parseInt(el('d-chat-font-size').value, 10) || 14));
    document.documentElement.style.setProperty('--font-size-chat', v + 'px');
    clearTimeout(chatFontSizeTimer);
    chatFontSizeTimer = setTimeout(async () => {
      await saveSettings({ chatFontSize: v });
      if (_settings) _settings.chatFontSize = v;
    }, 400);
  });

  let chatLineHeightTimer = null;
  el('d-chat-line-height').addEventListener('input', () => {
    const v = Math.min(2.5, Math.max(1, parseFloat(el('d-chat-line-height').value) || 1.6));
    el('d-chat-line-height-value').textContent = v;
    document.documentElement.style.setProperty('--line-height-chat', v);
    clearTimeout(chatLineHeightTimer);
    chatLineHeightTimer = setTimeout(async () => {
      await saveSettings({ chatLineHeight: v });
      if (_settings) _settings.chatLineHeight = v;
      if (window._State?.settings) window._State.settings.chatLineHeight = v;
    }, 400);
  });

  // Message spacing slider
  const msgGapVal = _settings?.chatMsgGap ?? 0.4;
  el('d-msg-gap').value = msgGapVal;
  el('d-msg-gap-value').textContent = msgGapVal;

  let msgGapTimer = null;
  el('d-msg-gap').addEventListener('input', () => {
    const v = parseFloat(el('d-msg-gap').value);
    el('d-msg-gap-value').textContent = v;
    document.documentElement.style.setProperty('--msg-gap', v + 'rem');
    clearTimeout(msgGapTimer);
    msgGapTimer = setTimeout(async () => {
      await saveSettings({ chatMsgGap: v });
      if (_settings) _settings.chatMsgGap = v;
      if (window._State?.settings) window._State.settings.chatMsgGap = v;
    }, 400);
  });

  // Paragraph spacing slider
  const paraGapVal = _settings?.chatParaGap ?? 0.75;
  el('d-para-gap').value = paraGapVal;
  el('d-para-gap-value').textContent = paraGapVal;

  let paraGapTimer = null;
  el('d-para-gap').addEventListener('input', () => {
    const v = parseFloat(el('d-para-gap').value);
    el('d-para-gap-value').textContent = v;
    document.documentElement.style.setProperty('--para-gap', v + 'em');
    clearTimeout(paraGapTimer);
    paraGapTimer = setTimeout(async () => {
      await saveSettings({ chatParaGap: v });
      if (_settings) _settings.chatParaGap = v;
      if (window._State?.settings) window._State.settings.chatParaGap = v;
    }, 400);
  });

  let uiFontSizeTimer = null;
  el('d-ui-font-size').addEventListener('input', () => {
    const v = Math.min(32, Math.max(10, parseInt(el('d-ui-font-size').value, 10) || 13));
    document.documentElement.style.setProperty('--font-size-ui', v + 'px');
    clearTimeout(uiFontSizeTimer);
    uiFontSizeTimer = setTimeout(async () => {
      await saveSettings({ uiFontSize: v });
      if (_settings) _settings.uiFontSize = v;
    }, 400);
  });
}

// ── onShow — refresh data when tab is revisited ───────────────────────────────

export async function onShow(State, _container) {
  try {
    const [connData, presetData, settings] = await Promise.all([
      getConnections(),
      getPromptPresets(),
      getSettings(),
    ]);
    _connections    = connData.presets;
    _activeConnId   = connData.activeId;
    _promptPresets  = presetData.presets;
    _activePromptId = presetData.activeId;
    _settings = settings;
    if (State) State.settings = settings;

    populateConnSelect();
    populateConnForm(activeConnPreset());

    const activePreset = _promptPresets.find(p => p.id === _activePromptId);
    populateGenForm(activePreset?.generationSettings ?? {});
    updateGenPresetLabel();

    updateDeleteButtons(settings.deleteMode ?? 'single');
    const lhv = settings.chatLineHeight ?? 1.6;
    const lh = el('d-chat-line-height'); if (lh) lh.value = lhv;
    const lhLabel = el('d-chat-line-height-value'); if (lhLabel) lhLabel.textContent = lhv;
    const mgv = settings.chatMsgGap ?? 0.4;
    const mg = el('d-msg-gap'); if (mg) mg.value = mgv;
    const mgLabel = el('d-msg-gap-value'); if (mgLabel) mgLabel.textContent = mgv;
    const pgv = settings.chatParaGap ?? 0.75;
    const pg = el('d-para-gap'); if (pg) pg.value = pgv;
    const pgLabel = el('d-para-gap-value'); if (pgLabel) pgLabel.textContent = pgv;
    const div = el('d-dividers'); if (div) div.checked = settings.showMsgDividers ?? false;
    const sm = el('d-show-model'); if (sm) sm.checked = settings.showMsgModel ?? false;
    const st = el('d-show-tokens'); if (st) st.checked = settings.showMsgTokens ?? false;
    const sd = el('d-show-duration'); if (sd) sd.checked = settings.showMsgDuration ?? false;

    const w = settings.chatMaxWidth ?? 100;
    const ws = el('d-chat-width'); const wv = el('d-chat-width-value');
    if (ws) ws.value = w;
    if (wv) wv.textContent = w + '%';

    updateAlignButtons(settings.chatAlign ?? 'center');
    applyChatAlign(settings.chatAlign ?? 'center');

    const dc = settings.dialogueColor || '#ef6b6b';
    const swatch = el('d-dialogue-color-swatch');
    if (swatch) swatch.style.background = dc;
    document.getElementById('chat-messages')?.classList.toggle('manuscript', settings.chatDisplayMode === 'manuscript');
    updateDisplayModeButtons(settings.chatDisplayMode || 'bubble');
    el('d-avatar-shape-row')?.querySelectorAll('.avatar-shape-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.shape === (settings.avatarShape ?? 'circle')));
  } catch (err) {
    console.error('Settings onShow failed:', err);
  }
}
