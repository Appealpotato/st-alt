import { createIcons, Users, Layers, Settings2, X }
  from './lib/lucide.js';
import * as ChatView        from './views/chat.js';
import * as PromptStackView from './views/promptStack.js';
import * as CharactersView  from './views/characters.js';
import * as SettingsView    from './views/settings.js';
import { getSettings, getPrompts, getCharacter, saveSettings, getCharacters, searchMessages } from './lib/api.js';
import { createSearch }          from './lib/search.js';
import { initCommandPalette }    from './lib/commandPalette.js';
import { initPanelResize, applyPanelWidth, getSavedPanelWidth } from './lib/panelResize.js';
import { stripFormatting } from './lib/textPreview.js';

const AVATAR_SHAPES = {
  circle:   { radius: '50%', ratio: '1 / 1' },
  rounded:  { radius: '8px', ratio: '1 / 1' },
  square:   { radius: '0',   ratio: '1 / 1' },
  portrait: { radius: '4px', ratio: '3 / 4' },
};

export function applyAvatarShape(shape) {
  const s = AVATAR_SHAPES[shape] ?? AVATAR_SHAPES.circle;
  document.documentElement.style.setProperty('--avatar-radius', s.radius);
  document.documentElement.style.setProperty('--avatar-ratio',  s.ratio);
}

// Global state — single source of truth for all views
const State = {
  settings: null,
  prompts: [],
  characters: [],
  activeCharacterId: null,
  activePersonaId:   null,
  activePersona:     null,
  sessionCharacter: null,
  sessionPersona:   null,
  sessions: [],
  activeSessionId: null,
  chatHistory: [],
  isStreaming: false,
};

// Expose for edge cases in views
window._State = State;
window._applyAvatarShape = applyAvatarShape;

// Tab views — each inits once into its own persistent container
const TabViews = {
  characters: { module: CharactersView,  initialized: false },
  prompts:    { module: PromptStackView, initialized: false },
  settings:   { module: SettingsView,    initialized: false },
};

let panelOpen = false;
let activeTab  = 'characters';  // default tab

// ── Panel open / close ────────────────────────────────────────────────────────

function openPanel() {
  const panel = document.getElementById('right-panel');
  panel.classList.add('open');
  applyPanelWidth(panel, true);
  const w = getSavedPanelWidth() || 400;
  document.documentElement.style.setProperty('--active-panel-width', w + 'px');
  document.querySelector('.panel-backdrop')?.classList.add('active');
  panelOpen = true;
  localStorage.setItem('panelOpen', '1');
}

function closePanel() {
  const panel = document.getElementById('right-panel');
  applyPanelWidth(panel, false);
  panel.classList.remove('open');
  document.documentElement.style.setProperty('--active-panel-width', '0px');
  document.querySelector('.panel-backdrop')?.classList.remove('active');
  panelOpen = false;
  localStorage.setItem('panelOpen', '0');
  document.querySelectorAll('#main-nav button[data-panel]').forEach(b =>
    b.classList.remove('nav-active'));
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tabName) {
  activeTab = tabName;
  localStorage.setItem('lastPanelTab', tabName);

  // Tab button active states
  document.querySelectorAll('.panel-tab[data-tab]').forEach(btn =>
    btn.classList.toggle('panel-tab--active', btn.dataset.tab === tabName));

  // Tab container visibility
  document.querySelectorAll('.tab-container').forEach(el =>
    el.classList.toggle('tab-container--active', el.id === `tab-${tabName}`));

  // Nav button active state
  document.querySelectorAll('#main-nav button[data-panel]').forEach(b =>
    b.classList.toggle('nav-active', b.dataset.panel === tabName));

  // Lazy-init on first visit; refresh data on subsequent visits
  const view = TabViews[tabName];
  if (!view) return;
  const container = document.getElementById(`tab-${tabName}`);
  if (!view.initialized) {
    view.module.init(State, container);
    view.initialized = true;
  } else if (view.module.onShow) {
    view.module.onShow(State, container);
  }
}

function showPanel(tabName) {
  if (!panelOpen) openPanel();
  switchTab(tabName);
}

function togglePanel(tabName) {
  if (panelOpen && activeTab === tabName) closePanel();
  else showPanel(tabName);
}

// ── Wire nav buttons ──────────────────────────────────────────────────────────

document.querySelectorAll('#main-nav button[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.panel === 'chat') closePanel();
    else togglePanel(btn.dataset.panel);
  });
});

// Wire tab buttons inside the panel
document.querySelectorAll('.panel-tab[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Wire panel close button
document.getElementById('panel-close').addEventListener('click', closePanel);

// Tap outside the panel → close. We listen on #chat-area (which sits behind
// the panel) rather than the backdrop, so scroll events still pass through
// normally. Only fires when the click target is NOT inside the panel itself.
document.getElementById('chat-area')?.addEventListener('click', (e) => {
  if (!panelOpen) return;
  if (e.target.closest('#right-panel') || e.target.closest('#panel-wrapper')) return;
  closePanel();
});


// Replace data-lucide placeholders in static HTML
createIcons({ icons: { Users, Layers, Settings2, X } });

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    const [settings, { entries }] = await Promise.all([
      getSettings(),
      getPrompts(),
    ]);
    State.settings = settings;
    State.prompts  = entries;
    State.activeCharacterId = settings.activeCharacterId ?? null;
    State.activePersonaId   = settings.activePersonaId   ?? null;
    // Apply persisted CSS variables
    if (settings.dialogueColor) {
      document.documentElement.style.setProperty('--dialogue-color', settings.dialogueColor);
    }
    if (settings.chatMaxWidth != null) {
      document.documentElement.style.setProperty('--chat-max-width', settings.chatMaxWidth + '%');
    }
    if (settings.showMsgDividers) {
      document.body.classList.add('chat-dividers');
    }
    document.body.classList.add(`chat-align-${settings.chatAlign || 'left'}`);
    applyAvatarShape(settings.avatarShape ?? 'circle');
    // Apply persisted font selections
    {
      const fontStacks = {
        'Lora':               "'Lora', serif",
        'Libre Baskerville':  "'Libre Baskerville', serif",
        'Crimson Text':       "'Crimson Text', serif",
        'EB Garamond':        "'EB Garamond', serif",
        'Source Serif 4':     "'Source Serif 4', serif",
        'Inter':              "'Inter', sans-serif",
        'IBM Plex Sans':      "'IBM Plex Sans', sans-serif",
        'Source Sans 3':      "'Source Sans 3', sans-serif",
      };
      if (settings.chatFont && settings.chatFont !== 'system') {
        if (fontStacks[settings.chatFont]) document.documentElement.style.setProperty('--font-chat', fontStacks[settings.chatFont]);
      }
      if (settings.uiFont && settings.uiFont !== 'system') {
        if (fontStacks[settings.uiFont]) document.documentElement.style.setProperty('--font-ui', fontStacks[settings.uiFont]);
      }
      if (settings.chatFontSize)   document.documentElement.style.setProperty('--font-size-chat',    settings.chatFontSize + 'px');
      if (settings.uiFontSize)     document.documentElement.style.setProperty('--font-size-ui',      settings.uiFontSize   + 'px');
      if (settings.chatLineHeight) document.documentElement.style.setProperty('--line-height-chat',  settings.chatLineHeight);
      if (settings.chatMsgGap != null) document.documentElement.style.setProperty('--msg-gap', settings.chatMsgGap + 'rem');
      if (settings.chatParaGap != null) document.documentElement.style.setProperty('--para-gap', settings.chatParaGap + 'em');
    }
    // Load active persona character
    if (settings.activePersonaId) {
      try {
        const persona = await getCharacter(settings.activePersonaId);
        State.activePersona = persona ?? null;
      } catch {
        State.activePersona = null;
      }
      if (!State.activePersona) {
        // Dangling ref — clean up
        State.settings.activePersonaId = null;
        saveSettings({ activePersonaId: null }).catch(() => {});
      }
    } else {
      State.activePersona = null;
    }
  } catch (err) {
    console.error('Boot failed to load settings/prompts:', err);
  }
  await ChatView.init(State, State.settings);
  initPalette();
  initPanelResize();
  restorePanelState();
}

function restorePanelState() {
  const stored  = localStorage.getItem('lastPanelTab') ?? 'characters';
  const lastTab = stored === 'chats' ? 'characters' : stored;
  const wasOpen = localStorage.getItem('panelOpen') === '1';
  // Always set the correct tab button state without triggering init
  document.querySelectorAll('.panel-tab[data-tab]').forEach(btn =>
    btn.classList.toggle('panel-tab--active', btn.dataset.tab === lastTab));
  document.querySelectorAll('.tab-container').forEach(el =>
    el.classList.toggle('tab-container--active', el.id === `tab-${lastTab}`));
  activeTab = lastTab;
  if (wasOpen) showPanel(lastTab);
}

function initPalette() {
  const search = createSearch();

  search.register('Characters', () =>
    (State.characters ?? [])
      .filter(c => c.type !== 'persona')
      .map(c => ({
        id: c.id,
        label: c.name,
        sublabel: stripFormatting(c.creatorNotes, 80),
        icon: c.avatar ?? null,
        category: 'Characters',
        action: () => CharactersView.clickToChat(c, State),
      }))
  );

  search.register('Personas', () =>
    (State.characters ?? [])
      .filter(c => c.type === 'persona')
      .map(c => ({
        id: c.id,
        label: c.name,
        sublabel: stripFormatting(c.creatorNotes, 80),
        category: 'Personas',
        action: () => {
          showPanel('characters');
          CharactersView.setTypeFilter('persona');
          CharactersView.openCharacterEditor(c.id, State, { onSave: () => {}, onDelete: () => {} });
        },
      }))
  );

  search.register('Chats', () =>
    (State.sessions ?? []).map(s => ({
      id: s.id,
      label: s.title || 'Untitled chat',
      sublabel: s.characterName ?? '',
      category: 'Chats',
      action: () => ChatView.selectSession(s.id, State),
    }))
  );

  function goToSettings(subtab) {
    showPanel('settings');
    setTimeout(() => SettingsView.switchSubTab(subtab), 0);
  }

  search.register('Actions', () => [
    {
      id: 'new-chat',      label: 'New Chat',       category: 'Actions',
      action: () => ChatView.newSession(State),
    },
    {
      id: 'new-char',      label: 'New Character',  category: 'Actions',
      keywords: 'create add character',
      action: () => { showPanel('characters'); CharactersView.setTypeFilter('character'); document.getElementById('char-new')?.click(); },
    },
    {
      id: 'new-persona',   label: 'New Persona',    category: 'Actions',
      keywords: 'create add persona player',
      action: () => { showPanel('characters'); CharactersView.setTypeFilter('persona'); document.getElementById('char-new')?.click(); },
    },
    {
      id: 'open-chars',    label: 'Characters',     category: 'Actions',
      action: () => { showPanel('characters'); CharactersView.setTypeFilter('character'); },
    },
    {
      id: 'open-personas', label: 'Personas',       category: 'Actions',
      keywords: 'persona player identity',
      action: () => { showPanel('characters'); CharactersView.setTypeFilter('persona'); },
    },
    {
      id: 'open-prompts',  label: 'Prompts',        category: 'Actions',
      action: () => showPanel('prompts'),
    },
    {
      id: 'open-settings', label: 'Settings',       category: 'Actions',
      action: () => showPanel('settings'),
    },
  ]);

  search.register('Settings', () => [
    // Connection
    { id: 's-api-key',        label: 'API Key',              sublabel: 'Connection', keywords: 'api key secret token auth bearer',          category: 'Settings', action: () => goToSettings('connection') },
    { id: 's-base-url',       label: 'Base URL',             sublabel: 'Connection', keywords: 'base url endpoint host provider openrouter', category: 'Settings', action: () => goToSettings('connection') },
    { id: 's-model',          label: 'Model',                sublabel: 'Connection', keywords: 'model provider select llm ai',               category: 'Settings', action: () => goToSettings('connection') },
    { id: 's-reasoning',      label: 'Reasoning',            sublabel: 'Connection', keywords: 'reasoning thinking effort chain thought cot', category: 'Settings', action: () => goToSettings('connection') },
    // Generation
    { id: 's-temperature',    label: 'Temperature',          sublabel: 'Generation', keywords: 'temperature creativity randomness sampling heat', category: 'Settings', action: () => goToSettings('generation') },
    { id: 's-top-p',          label: 'Top P',                sublabel: 'Generation', keywords: 'top p nucleus sampling probability',            category: 'Settings', action: () => goToSettings('generation') },
    { id: 's-max-tokens',     label: 'Max Tokens',           sublabel: 'Generation', keywords: 'max tokens length output limit context',        category: 'Settings', action: () => goToSettings('generation') },
    { id: 's-freq-penalty',   label: 'Frequency Penalty',    sublabel: 'Generation', keywords: 'frequency penalty repetition',                  category: 'Settings', action: () => goToSettings('generation') },
    { id: 's-pres-penalty',   label: 'Presence Penalty',     sublabel: 'Generation', keywords: 'presence penalty repetition',                   category: 'Settings', action: () => goToSettings('generation') },
    { id: 's-context-size',   label: 'Context Size',         sublabel: 'Generation', keywords: 'context size limit cap tokens budget window',   category: 'Settings', action: () => goToSettings('generation') },
    // Display
    { id: 's-display-mode',   label: 'Chat Display Mode',    sublabel: 'Display',    keywords: 'bubble manuscript layout theme appearance mode', category: 'Settings', action: () => goToSettings('display') },
    { id: 's-dividers',       label: 'Message Dividers',     sublabel: 'Display',    keywords: 'dividers lines separator border',                category: 'Settings', action: () => goToSettings('display') },
    { id: 's-msg-info',       label: 'Message Info',         sublabel: 'Display',    keywords: 'model tokens time generation info meta show',    category: 'Settings', action: () => goToSettings('display') },
    { id: 's-chat-width',     label: 'Chat Width',           sublabel: 'Display',    keywords: 'width layout size narrow wide',                  category: 'Settings', action: () => goToSettings('display') },
    { id: 's-chat-align',     label: 'Chat Alignment',       sublabel: 'Display',    keywords: 'align left center right position',               category: 'Settings', action: () => goToSettings('display') },
    { id: 's-dialogue-color', label: 'Dialogue Color',       sublabel: 'Display',    keywords: 'color colour dialogue theme accent quote',       category: 'Settings', action: () => goToSettings('display') },
    { id: 's-avatar-shape',   label: 'Avatar Shape',         sublabel: 'Display',    keywords: 'avatar shape circle square portrait rounded',    category: 'Settings', action: () => goToSettings('display') },
    { id: 's-chat-font',      label: 'Chat Font',            sublabel: 'Display',    keywords: 'chat font typeface lora garamond serif literary', category: 'Settings', action: () => goToSettings('display') },
    { id: 's-ui-font',        label: 'UI Font',              sublabel: 'Display',    keywords: 'ui font typeface inter sans interface',           category: 'Settings', action: () => goToSettings('display') },
    { id: 's-chat-font-size', label: 'Chat Font Size',       sublabel: 'Display',    keywords: 'chat font size text large small',                 category: 'Settings', action: () => goToSettings('display') },
    { id: 's-ui-font-size',   label: 'UI Font Size',         sublabel: 'Display',    keywords: 'ui font size interface text large small',         category: 'Settings', action: () => goToSettings('display') },
    { id: 's-line-height',    label: 'Line Height',          sublabel: 'Display',    keywords: 'line height spacing leading text density',        category: 'Settings', action: () => goToSettings('display') },
    { id: 's-msg-gap',        label: 'Message Spacing',      sublabel: 'Display',    keywords: 'message spacing gap between messages distance',   category: 'Settings', action: () => goToSettings('display') },
    { id: 's-para-gap',       label: 'Paragraph Spacing',    sublabel: 'Display',    keywords: 'paragraph spacing gap between paragraphs indent', category: 'Settings', action: () => goToSettings('display') },
    { id: 's-delete-mode',    label: 'Delete Behaviour',     sublabel: 'Display',    keywords: 'delete message chain single behaviour mode',      category: 'Settings', action: () => goToSettings('display') },
  ]);

  // Refresh characters list whenever palette is opened by loading from State
  // (State.characters is kept up to date by CharactersView)
  // Also pre-load characters for the palette
  getCharacters().then(({ characters }) => {
    State.characters = characters;
  }).catch(() => {});

  initCommandPalette(State, search, {
    asyncSearch: async (term) => {
      try {
        const { results } = await searchMessages(term);
        return results.map(r => ({
          id: `msg-${r.sessionId}-${r.messageId}`,
          label: stripFormatting(r.preview, 120),
          sublabel: r.sessionTitle + (r.characterName ? ` (${r.characterName})` : ''),
          role: r.role,
          category: 'Messages',
          action: () => {
            ChatView.selectSession(r.sessionId, State).then(() => {
              const msgEl = document.querySelector(`[data-history-index="${r.historyIndex}"]`);
              if (msgEl) {
                msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                msgEl.classList.add('message--highlight');
                setTimeout(() => msgEl.classList.remove('message--highlight'), 2000);
              }
            });
          },
        }));
      } catch { return []; }
    },
  });
}

boot();
