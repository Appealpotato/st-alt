import {
  getSessions, createSession, getSession,
  appendMessage, replaceMessages, getCharacter, getCharacters, getSettings,
  getActiveStreams, abortStream, updateSession,
} from '../lib/api.js';
import { assembleMessages } from '../lib/assembler.js';
import { streamCompletion } from '../lib/stream.js';
import { icon, Pencil, Trash2, GitBranch, RefreshCw,
         ChevronLeft, ChevronRight, LayoutGrid, AlignLeft, Plus, Check, X, Play } from '../lib/icons.js';
import { showToast } from '../lib/toast.js';
import DOMPurify from '../lib/purify.js';

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'b', 'i', 'em', 'strong', 'u', 's', 'del', 'small', 'sub', 'sup',
    'br', 'hr', 'p', 'div', 'span',
    'ul', 'ol', 'li', 'blockquote',
    'details', 'summary',
    'a', 'img',
  ],
  ALLOWED_ATTR: ['class', 'style', 'href', 'title', 'src', 'alt', 'open'],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|data:image\/)/i,
};

// ── Markdown / dialogue formatting ───────────────────────────────────────────

/**
 * Convert raw message text to safe HTML with markdown and dialogue coloring.
 * Processing order matters — bold-italic before bold before italic.
 *
 * Performance note: called on every streaming token (full accumulated string
 * each time). Fine in practice — simple regexes on short strings. If streaming
 * jank appears, switch onToken back to textContent and only call this on done.
 */
function applyMarkdown(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/gs, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/gs, '<del>$1</del>');
  return text;
}

// Dialogue coloring. Runs on raw text (before paragraph wrapping) so that a
// quoted span broken only by single \n still matches — preserves prior behavior
// for multi-line dialogue. The `"` → literal form is fine here because this
// runs before any HTML attribute values exist; DOMPurify cleans up in the
// unlikely case a user's raw-HTML attribute value gets mangled by the regex.
function applyDialogueColor(text) {
  text = text.replace(/"([^"\n]*(?:\n[^"\n]*)*)"/g, '<span class="dialogue">"$1"</span>');
  text = text.replace(/\u201C([^\u201D]*?)\u201D/g, '<span class="dialogue">\u201C$1\u201D</span>');
  return text;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Private-use-area placeholder markers for extracted code segments — opaque
// characters that survive DOMPurify and don't collide with normal content.
const CODE_PLACEHOLDER = (i) => `\uE000CODE${i}\uE001`;
const INLINE_PLACEHOLDER = (i) => `\uE002INLN${i}\uE003`;

function formatMessageContent(text) {
  // 1. Normalise line endings.
  let src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 2. Extract <think>/<thinking> from raw text.
  let thinkingContent = '';
  src = src.replace(
    /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/gi,
    (_, c) => { thinkingContent += c; return ''; }
  );

  // 3. Extract fenced code blocks — both closed and an unclosed trailing
  //    fence (streaming case), in that order.
  const codeBlocks = [];
  src = src.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.push({ lang, code }) - 1;
    return CODE_PLACEHOLDER(i);
  });
  const trailingFence = src.match(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*)$/);
  if (trailingFence) {
    const i = codeBlocks.push({ lang: trailingFence[1], code: trailingFence[2] }) - 1;
    src = src.slice(0, trailingFence.index) + CODE_PLACEHOLDER(i);
  }

  // 4. Extract inline code.
  const inlineCodes = [];
  src = src.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = inlineCodes.push(code) - 1;
    return INLINE_PLACEHOLDER(i);
  });

  // 5. Apply markdown + dialogue regexes on raw text (with placeholders in
  //    place of code segments, so code content is untouched). Placeholder
  //    chars contain no *, `, or " so regexes skip over them.
  src = applyDialogueColor(applyMarkdown(src));

  // 6. Paragraph split + \n → <br>, wrap each block in <p>.
  let html = src.trim().split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  // 7. Sanitize: DOMPurify enforces the tag/attr allowlist. Our markdown +
  //    dialogue tags survive; any malformed user HTML (e.g. an <a> whose title
  //    attr got clipped by the dialogue regex) is dropped. Critical for XSS.
  html = DOMPurify.sanitize(html, PURIFY_CONFIG);

  // 8. Reinsert code placeholders as styled code elements. Contents HTML-
  //    escaped here; they never touched sanitize or markdown regexes.
  html = html.replace(/\uE000CODE(\d+)\uE001/g, (_, i) => {
    const { lang, code } = codeBlocks[+i];
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    // Code blocks are block-level: close the surrounding <p> so the browser
    // doesn't auto-break around the <pre>.
    return `</p><pre><code${langAttr}>${escapeHtml(code)}</code></pre><p>`;
  });
  html = html.replace(/\uE002INLN(\d+)\uE003/g, (_, i) => `<code>${escapeHtml(inlineCodes[+i])}</code>`);
  html = html.replace(/<p>\s*<\/p>/g, ''); // empty <p>s from the unwrap above

  // 9. Prepend the reasoning block if <think> content was found. Same
  //    pipeline minus paragraph-splitting (think blocks are typically a
  //    single flow of prose with \n line breaks).
  let prefix = '';
  if (thinkingContent.trim()) {
    const inner = DOMPurify.sanitize(
      applyDialogueColor(applyMarkdown(thinkingContent.trim())).replace(/\n/g, '<br>'),
      PURIFY_CONFIG
    );
    prefix = `<details class="thinking-block"><summary class="thinking-summary">Reasoning</summary><div class="thinking-content">${inner}</div></details>`;
  }

  return prefix + html;
}

// ── Avatar helpers ────────────────────────────────────────────────────────────

function hashToHue(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return Math.abs(hash) % 360;
}

function renderAvatarEl(container, role, State) {
  const isAssistant = role === 'assistant';
  const avatarPath  = isAssistant ? (State?.sessionCharacter?.avatar ?? null)
                                  : (State?.sessionPersona?.avatar ?? null);
  const name        = isAssistant ? (State?.sessionCharacter?.name ?? 'A')
                                  : (State?.sessionPersona?.name ?? 'U');
  if (avatarPath) {
    const img = document.createElement('img');
    img.src = avatarPath;
    img.className = 'avatar-img avatar-img--sm';
    img.alt = name;
    container.appendChild(img);
  } else {
    const hue = hashToHue(name);
    const circle = document.createElement('div');
    circle.className = 'avatar-initials avatar-initials--sm';
    circle.style.background = `hsl(${hue}, 40%, 25%)`;
    circle.style.color = `hsl(${hue}, 60%, 70%)`;
    circle.textContent = name[0].toUpperCase();
    container.appendChild(circle);
  }
}

const el = id => document.getElementById(id);

let cancelStream = null;

export async function init(State, prefetchedSettings = null) {
  // Main chat area (always visible center column)
  document.getElementById('chat-area').innerHTML = `
    <div id="chat-messages"></div>
    <div id="chat-empty" class="chat-empty"></div>
    <div id="chat-input-area">
      <div id="chat-persona-bar">
        <button id="chat-persona-btn" class="chat-persona-btn" title="Switch persona for this chat"></button>
      </div>
      <div id="chat-input-row">
        <textarea id="chat-input" placeholder="Write something…" rows="3"></textarea>
        <button id="chat-send" class="btn-primary">Send</button>
      </div>
    </div>
  `;

  // Inject persistent controls into #main-nav (right side)
  if (!document.getElementById('chat-nav-controls')) {
    const navControls = document.createElement('div');
    navControls.id = 'chat-nav-controls';
    const newBtn = document.createElement('button');
    newBtn.id = 'chat-new';
    newBtn.title = 'New chat with current character';
    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'chat-display-toggle';
    toggleBtn.className = 'chat-display-toggle';
    toggleBtn.title = 'Toggle display mode';
    navControls.appendChild(newBtn);
    navControls.appendChild(toggleBtn);
    const nav = document.getElementById('main-nav');
    const panelButtons = document.getElementById('nav-panel-buttons');
    nav.insertBefore(navControls, panelButtons);
  }

  el('chat-new').appendChild(icon(Plus, 18));

  await loadSessions(State, prefetchedSettings);

  el('chat-new').addEventListener('click', () => newSession(State));
  el('chat-send').addEventListener('click', () => sendMessage(State));
  el('chat-persona-btn').addEventListener('click', (e) => openPersonaPicker(e, State));

  // On mobile, scroll to bottom when the keyboard opens so the input stays visible
  el('chat-input').addEventListener('keydown', (e) => {
    const isMobile = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault();
      sendMessage(State);
    }
  });

  // Mobile: tap a message row to show its action bar; tap again or elsewhere to dismiss
  el('chat-messages').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.message-row');
    const active = el('chat-messages').querySelectorAll('.message-row--active');
    if (row && !e.target.closest('button, .swipe-counter')) {
      const wasActive = row.classList.contains('message-row--active');
      active.forEach(r => r.classList.remove('message-row--active'));
      if (!wasActive) row.classList.add('message-row--active');
    } else if (!e.target.closest('button')) {
      active.forEach(r => r.classList.remove('message-row--active'));
    }
  }, { passive: true });

  // ── Mobile swipe gestures (left/right on assistant messages) ───────────────
  let _swTouchX = 0, _swTouchY = 0, _swTarget = null;

  el('chat-messages').addEventListener('touchstart', (e) => {
    const row = e.target.closest('.message-row');
    if (!row || e.target.closest('button, .swipe-counter')) { _swTarget = null; return; }
    const msgEl = row.querySelector('.message--assistant[data-history-index]');
    if (!msgEl) { _swTarget = null; return; }
    _swTouchX = e.touches[0].clientX;
    _swTouchY = e.touches[0].clientY;
    _swTarget = { row, msgEl, histIdx: parseInt(msgEl.dataset.historyIndex, 10) };
  }, { passive: true });

  el('chat-messages').addEventListener('touchend', (e) => {
    if (!_swTarget) return;
    const dx = e.changedTouches[0].clientX - _swTouchX;
    const dy = Math.abs(e.changedTouches[0].clientY - _swTouchY);
    const { msgEl, histIdx } = _swTarget;
    _swTarget = null;

    if (Math.abs(dx) < 50 || dy > 30) return;

    const msg = State.chatHistory[histIdx];
    if (!msg) return;

    if (dx < 0) {
      // Swipe left → next swipe
      if (msg.swipes?.length > 1) swipeMessage(histIdx, 1, State);
    } else {
      // Swipe right → previous swipe, or regen if at first and is last message
      if (msg.swipes && msg.swipeIndex > 0) {
        swipeMessage(histIdx, -1, State);
      } else if (histIdx === State.chatHistory.length - 1) {
        regenAsSwipe(histIdx, msgEl, State);
      }
    }
  }, { passive: true });

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  const isInputFocused = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  };

  document.addEventListener('keydown', (e) => {
    // Escape → stop streaming
    if (e.key === 'Escape' && State.isStreaming && cancelStream) {
      cancelStream();
      if (State.activeSessionId) abortStream(State.activeSessionId).catch(() => {});
      return;
    }

    if (isInputFocused()) return;

    // Left/Right → swipe navigation on last assistant message
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const lastIdx = State.chatHistory.length - 1;
      const lastMsg = State.chatHistory[lastIdx];
      if (lastMsg?.role === 'assistant' && lastMsg?.swipes?.length > 1) {
        e.preventDefault();
        swipeMessage(lastIdx, e.key === 'ArrowLeft' ? -1 : 1, State);
      }
      return;
    }

    // Up → edit last user message (when chat input is empty)
    if (e.key === 'ArrowUp') {
      const input = el('chat-input');
      if (input?.value.trim()) return;
      for (let i = State.chatHistory.length - 1; i >= 0; i--) {
        if (State.chatHistory[i].role === 'user') {
          const msgEl = document.querySelector(`[data-history-index="${i}"]`);
          if (msgEl) { e.preventDefault(); enterEditMode(msgEl, i, State); }
          break;
        }
      }
    }
  });

  el('chat-display-toggle').addEventListener('click', () => {
    const next = State.settings?.chatDisplayMode === 'manuscript' ? 'bubble' : 'manuscript';
    if (!State.settings) State.settings = {};
    State.settings.chatDisplayMode = next;
    applyDisplayMode(next);
    import('../lib/api.js').then(({ saveSettings }) =>
      saveSettings({ ...State.settings, chatDisplayMode: next }).catch(() => {})
    );
  });
}

export async function onShow(State) {
  await loadSessions(State);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

async function loadSessions(State, prefetchedSettings = null) {
  const [{ sessions }, settings] = await Promise.all([
    getSessions(),
    prefetchedSettings ? Promise.resolve(prefetchedSettings) : getSettings(),
  ]);
  State.sessions = sessions;
  State.activeCharacterId = settings.activeCharacterId ?? null;
  State.settings = { ...(State.settings ?? {}), ...settings };
  applyDisplayMode(State.settings.chatDisplayMode ?? 'bubble');

  if (!State.activeSessionId && sessions.length > 0) {
    const lastId = localStorage.getItem('lastSessionId');
    const target = (lastId && sessions.find(s => s.id === lastId)) ? lastId : sessions[0].id;
    await selectSession(target, State);
  } else if (State.activeSessionId) {
    await selectSession(State.activeSessionId, State);
  }
}


function generateSessionTitle(characterName) {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  const day = now.getDate();
  const mon = now.toLocaleString('en', { month: 'short' });
  const yr  = now.getFullYear();
  return `${characterName || 'Chat'} - ${hh}:${mm} - ${day} - ${mon} - ${yr}`;
}

async function newSession(State) {
  let characterId   = State.activeCharacterId ?? null;
  let characterName = null;
  let char          = null;
  if (characterId) {
    try {
      char = await getCharacter(characterId);
      characterName = char.name || null;
      State.sessionCharacter = char;
    } catch { characterId = null; }
  }

  const title = generateSessionTitle(characterName);
  const personaId = State.activePersonaId ?? null;
  const meta = await createSession({ title, characterId, characterName, personaId });

  // Persist firstMessage before loading so selectSession picks it up naturally
  if (char?.firstMessage?.trim()) {
    await appendMessage(meta.id, { role: 'assistant', content: char.firstMessage });
  }

  State.sessions.unshift(meta);
  await selectSession(meta.id, State);
  document.dispatchEvent(new CustomEvent('sessionscreated', { detail: { session: meta } }));
}

async function selectSession(id, State) {
  State.activeSessionId = id;
  localStorage.setItem('lastSessionId', id);
  const session = await getSession(id);
  State.chatHistory = session.messages;

  const charId = session.characterId ?? State.activeCharacterId;
  if (charId) {
    try {
      State.sessionCharacter = await getCharacter(charId);
    } catch {
      State.sessionCharacter = null;
    }
  } else {
    State.sessionCharacter = null;
  }

  // Load session-bound persona (falls back to global active persona for old sessions)
  const pId = session.personaId;
  if (pId) {
    try {
      State.sessionPersona = await getCharacter(pId);
    } catch {
      State.sessionPersona = State.activePersona;
    }
  } else {
    State.sessionPersona = State.activePersona;
  }

  renderMessages(State);
  updateChatHeader(State);
  updatePersonaBtn(State);

  // Reconnect if this session is still streaming on the server (e.g. after page reload)
  try {
    const { sessions } = await getActiveStreams();
    if (sessions.includes(id)) reconnectToStream(id, State);
  } catch { /* non-fatal */ }
}

async function reconnectToStream(sessionId, State) {
  if (State.isStreaming) return;
  State.isStreaming = true;
  setSendState(true, State);

  const charName = State.sessionCharacter?.name || 'Character';

  // Remove the last assistant message from rendered history if present —
  // the reconnect buffer replays everything from scratch, so we avoid duplication.
  const lastMsg = State.chatHistory[State.chatHistory.length - 1];
  const container = el('chat-messages');
  if (lastMsg?.role === 'assistant' && container) {
    const lastRow = container.querySelector('.message-row:last-child');
    if (lastRow) lastRow.remove();
  }

  const assistantEl = appendMessageEl('assistant', '', charName, true, null, State);
  const bodyEl = assistantEl.querySelector('.message-body');
  const typingIndicator = addTypingIndicator(bodyEl);
  scrollToBottom();
  let dotsGone = false;
  let accumulated = '';

  const dotTimer = setTimeout(() => {
    typingIndicator.remove();
    dotsGone = true;
    if (accumulated) bodyEl.innerHTML = formatMessageContent(accumulated);
  }, 400);

  cancelStream = streamCompletion(
    null, // messages not needed — we pass null to signal reconnect mode
    sessionId,
    (token) => {
      accumulated += token;
      if (!dotsGone) return;
      bodyEl.innerHTML = formatMessageContent(accumulated);
    },
    async (event) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      assistantEl.classList.remove('message--streaming');
      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;
      // Always reload from server and re-render — handles both normal completion
      // and race conditions where the message was already persisted
      try {
        const session = await getSession(sessionId);
        State.chatHistory = session.messages;
      } catch { /* keep existing chatHistory */ }
      renderMessages(State);
    },
    (errMsg) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      assistantEl.classList.remove('message--streaming');
      assistantEl.classList.add('message--error');
      bodyEl.textContent = 'Error: ' + errMsg;
      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;
    },
    true, // reconnect flag
  );
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function applyDisplayMode(mode) {
  const msgs = el('chat-messages');
  const btn  = el('chat-display-toggle');
  if (!msgs) return;
  const isManuscript = mode === 'manuscript';
  msgs.classList.toggle('manuscript', isManuscript);
  if (btn) {
    btn.innerHTML = '';
    btn.appendChild(icon(isManuscript ? LayoutGrid : AlignLeft, 16));
    btn.title = isManuscript ? 'Switch to bubble mode' : 'Switch to manuscript mode';
  }
  document.dispatchEvent(new CustomEvent('displaymodechange', { detail: { mode } }));
}

function syncEmptyState(State) {
  const emptyEl = el('chat-empty');
  if (!emptyEl) return;
  const hasMessages = State.chatHistory && State.chatHistory.length > 0;
  const charName = State.sessionCharacter?.name || null;
  emptyEl.classList.toggle('visible', !hasMessages && !!charName);
  if (!hasMessages && charName) emptyEl.textContent = charName;
}

function updateChatHeader(State) {
  syncEmptyState(State);
}

function updatePersonaBtn(State) {
  const btn = el('chat-persona-btn');
  if (!btn) return;
  const persona = State.sessionPersona;
  btn.textContent = persona?.name ? `${persona.name} ▾` : 'No persona ▾';
  btn.classList.toggle('chat-persona-btn--set', !!persona?.name);
}

let _personaPickerEl = null;

async function openPersonaPicker(evt, State) {
  // Capture rect synchronously — currentTarget is nulled after any await
  const btnRect = evt.currentTarget.getBoundingClientRect();

  // Close if already open
  if (_personaPickerEl) {
    _personaPickerEl.remove();
    _personaPickerEl = null;
    return;
  }

  let allChars;
  try { allChars = await getCharacters(); } catch { return; }
  const personas = (allChars.characters ?? []).filter(c => c.type === 'persona');

  const picker = document.createElement('div');
  picker.className = 'persona-picker';
  _personaPickerEl = picker;

  const addOption = (label, id, isCurrent) => {
    const opt = document.createElement('button');
    opt.className = 'persona-picker__opt' + (isCurrent ? ' persona-picker__opt--active' : '');
    opt.textContent = label;
    opt.addEventListener('click', async () => {
      picker.remove();
      _personaPickerEl = null;
      const newPersona = id ? personas.find(p => p.id === id) ?? null : null;
      State.sessionPersona = newPersona ? await getCharacter(id).catch(() => newPersona) : null;
      if (State.activeSessionId) {
        updateSession(State.activeSessionId, { personaId: id ?? null }).catch(() => {});
        // Update the in-memory sessions list too
        const sm = State.sessions?.find(s => s.id === State.activeSessionId);
        if (sm) sm.personaId = id ?? null;
      }
      updatePersonaBtn(State);
      renderMessages(State);
    });
    picker.appendChild(opt);
  };

  const currentId = State.sessionPersona?.id ?? null;
  personas.forEach(p => addOption(p.name, p.id, p.id === currentId));
  if (personas.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'persona-picker__sep';
    picker.appendChild(sep);
  }
  addOption('No persona', null, currentId === null);

  document.body.appendChild(picker);

  // Position above the button using pre-captured fixed coords
  picker.style.left = btnRect.left + 'px';
  const pickerHeight = picker.offsetHeight;
  picker.style.top = (btnRect.top - pickerHeight - 4) + 'px';

  // Close on outside click
  const onOutside = (e) => {
    if (!picker.contains(e.target) && e.target !== evt.currentTarget) {
      picker.remove();
      _personaPickerEl = null;
      document.removeEventListener('click', onOutside, true);
    }
  };
  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

function renderMsgMeta(msgEl, msg, State) {
  msgEl.querySelector('.message-meta')?.remove();
  const s = State?.settings ?? {};
  if (!s.showMsgModel && !s.showMsgTokens && !s.showMsgDuration) return;
  const meta = msg.metadata ?? {};
  const parts = [];
  if (s.showMsgModel) {
    const model = meta.model || msg.model || '';
    if (model) parts.push(model.split('/').pop());
  }
  if (s.showMsgTokens) {
    const usage = meta.usage ?? msg.usage ?? {};
    const comp = usage.completion_tokens ?? 0;
    if (comp > 0) parts.push(`${comp} tok`);
  }
  if (s.showMsgDuration) {
    const dur = meta.duration ?? msg.duration ?? 0;
    if (dur > 0) {
      const secs = dur / 1000;
      parts.push(secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`);
    }
  }
  if (parts.length === 0) return;
  const metaEl = document.createElement('div');
  metaEl.className = 'message-meta';
  metaEl.textContent = parts.join(' · ');
  msgEl.appendChild(metaEl);
}

// Exposed so settings tab can re-render meta after toggling display options
window._rerenderMeta = (State) => {
  document.querySelectorAll('.message--assistant[data-history-index]').forEach(msgEl => {
    const idx = parseInt(msgEl.dataset.historyIndex, 10);
    const msg = State.chatHistory?.[idx];
    if (msg) renderMsgMeta(msgEl, msg, State);
  });
};

function renderMessages(State) {
  const container = el('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  State.chatHistory.forEach((msg, idx) => {
    const bubble = appendMessageEl(msg.role, msg.content, State.sessionCharacter?.name, false, idx, State);
    if (msg.role === 'assistant' && bubble) renderMsgMeta(bubble, msg, State);
  });
  scrollToBottom();
  syncEmptyState(State);
}

/**
 * Append a message to #chat-messages.
 *
 * Structure:
 *   .message-row.message-row--{role}          ← visual row (avatar + wrap)
 *     .message-avatar                          ← avatar circle/image
 *     .message-wrap                            ← name label + bubble
 *       .message-name  (assistant only)
 *       .message.message--{role}  [data-history-index]   ← THE BUBBLE — returned
 *         .message-body
 *         .message-actions  (absolute, built by buildActionsBar)
 *
 * Returns the .message bubble div so all callers (streaming, edit, regen,
 * buildActionsBar) keep working unchanged — data-history-index, streaming
 * classes, and action bar hooks all live on the bubble.
 *
 * @param {number|null} historyIndex - index in State.chatHistory; null while streaming
 */
function appendMessageEl(role, content, charName = null, streaming = false, historyIndex = null, State = null) {
  const container = el('chat-messages');
  if (!container) return null;
  el('chat-empty')?.classList.remove('visible');

  // ── Row wrapper ──────────────────────────────────────────────────────────
  const row = document.createElement('div');
  row.className = `message-row message-row--${role}`;

  // ── Avatar ───────────────────────────────────────────────────────────────
  const avatarEl = document.createElement('div');
  avatarEl.className = 'message-avatar';
  if (State) renderAvatarEl(avatarEl, role, State);

  // ── Wrap (header strip + bubble) ─────────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'message-wrap';

  // Header strip — contains name and (later) action bar side by side
  const header = document.createElement('div');
  header.className = 'message-header';

  if (role === 'assistant' && charName) {
    const nameTag = document.createElement('div');
    nameTag.className = 'message-name';
    nameTag.textContent = charName;
    header.appendChild(nameTag);
  }

  if (role === 'user') {
    const nameTag = document.createElement('div');
    nameTag.className = 'message-name message-name--user';
    nameTag.textContent = State?.sessionPersona?.name || 'You';
    header.appendChild(nameTag);
  }

  wrap.appendChild(header);

  // ── Bubble — this is what we return and what all existing hooks target ───
  const div = document.createElement('div');
  div.className = `message message--${role}${streaming ? ' message--streaming' : ''}`;
  if (historyIndex !== null) div.dataset.historyIndex = historyIndex;

  const body = document.createElement('div');
  body.className = 'message-body';
  const _charName    = charName || State?.sessionCharacter?.name || 'Character';
  const _personaName = State?.sessionPersona?.name || 'User';
  const displayContent = content
    .replaceAll('{{char}}', _charName).replaceAll('{{Char}}', _charName)
    .replaceAll('{{user}}', _personaName).replaceAll('{{User}}', _personaName);
  body.innerHTML = formatMessageContent(displayContent);
  div.appendChild(body);

  wrap.appendChild(div);
  row.appendChild(avatarEl);
  row.appendChild(wrap);
  container.appendChild(row);

  // Action bar — must be called after DOM assembly so .closest() traversal works
  if (!streaming && historyIndex !== null && State) {
    buildActionsBar(div, historyIndex, State, State.chatHistory[historyIndex]);
  }
  return div; // ← always return the bubble, not the row
}

function scrollToBottom() {
  const container = el('chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

/**
 * Scroll so the bottom of the message row aligns with the visible area bottom.
 * Only fires when the user is already near the bottom (mirrors ST behaviour).
 * Uses the .message-row for accurate full-row measurement.
 */
function scrollMessageIntoView(msgEl) {
  const container = el('chat-messages');
  if (!container) return;
  const nearBottom = container.scrollTop >= container.scrollHeight - container.clientHeight - 80;
  if (!nearBottom) return;
  const rowEl = msgEl.closest('.message-row') || msgEl;
  const containerRect = container.getBoundingClientRect();
  const rowRect = rowEl.getBoundingClientRect();
  const delta = rowRect.bottom - containerRect.bottom + 24;
  if (delta > 0) container.scrollBy({ top: delta, behavior: 'smooth' });
}

/**
 * Run fn() while keeping the message row visually stationary.
 * Uses the .message-row for accurate full-row measurement.
 */
function lockScroll(msgEl, fn) {
  const container = el('chat-messages');
  if (!container) { fn(); return; }
  const rowEl = msgEl.closest('.message-row') || msgEl;
  const before = rowEl.getBoundingClientRect().top;
  fn();
  const delta = rowEl.getBoundingClientRect().top - before;
  if (delta !== 0) container.scrollTop += delta;
}

// ── Action bar (swipe controls + regen icon) ──────────────────────────────────

/**
 * Build (or rebuild) the hover action bar on an assistant message element.
 * Shows ← counter → only when the message has multiple swipes.
 * Always shows ↻ regen icon.
 */
function buildActionsBar(msgEl, histIdx, State, msg) {
  const rowEl = msgEl.closest('.message-row') ?? msgEl;
  const headerEl = msgEl.closest('.message-wrap')?.querySelector('.message-header') ?? rowEl;
  headerEl.querySelector('.message-actions')?.remove();
  rowEl.querySelector('.message-actions')?.remove(); // clean up legacy position

  const bar = document.createElement('div');
  bar.className = 'message-actions';

  // Pencil edit — always first
  const edit = document.createElement('button');
  edit.className = 'btn-action';
  edit.appendChild(icon(Pencil, 16));
  edit.title = 'Edit message';
  const onEditClick = (e) => { e.stopPropagation(); enterEditMode(msgEl, histIdx, State); };
  edit.addEventListener('click', onEditClick);
  bar.appendChild(edit);

  // Delete — always second
  const del = document.createElement('button');
  del.className = 'btn-action';
  del.appendChild(icon(Trash2, 16));
  del.title = 'Delete message';
  { let pending = false;
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pending) return;
    pending = true;
    const editSaved = edit.innerHTML;
    const delSaved  = del.innerHTML;
    let timer;
    function restore() {
      clearTimeout(timer);
      pending = false;
      edit.innerHTML = editSaved;
      edit.classList.remove('ci-confirm');
      edit.addEventListener('click', onEditClick);
      del.innerHTML = delSaved;
      del.classList.remove('ci-cancel');
      del.onclick = null;
    }
    edit.removeEventListener('click', onEditClick);
    edit.innerHTML = '';
    edit.appendChild(icon(Check, 14));
    edit.classList.add('ci-confirm');
    edit.onclick = (ev) => { ev.stopPropagation(); restore(); deleteMessage(histIdx, State); };
    del.innerHTML = '';
    del.appendChild(icon(X, 14));
    del.classList.add('ci-cancel');
    del.onclick = (ev) => { ev.stopPropagation(); restore(); };
    timer = setTimeout(() => restore(), 3000);
  }); }
  bar.appendChild(del);

  // Branch — always
  const branch = document.createElement('button');
  branch.className = 'btn-action';
  branch.appendChild(icon(GitBranch, 16));
  branch.title = 'Branch chat from here';
  branch.addEventListener('click', (e) => { e.stopPropagation(); branchFrom(histIdx, State); });
  bar.appendChild(branch);

  // Assistant-only: swipe controls + regen
  if (msg?.role === 'assistant') {
    const swipes = msg?.swipes;
    if (swipes && swipes.length > 1) {
      const sep = document.createElement('span');
      sep.className = 'swipe-counter';
      sep.textContent = '·';
      bar.appendChild(sep);

      const prev = document.createElement('button');
      prev.className = 'btn-action';
      prev.appendChild(icon(ChevronLeft, 16));
      prev.title = 'Previous version';
      prev.disabled = msg.swipeIndex === 0;
      prev.addEventListener('click', (e) => { e.stopPropagation(); swipeMessage(histIdx, -1, State); });

      const counter = document.createElement('span');
      counter.className = 'swipe-counter';
      counter.textContent = `${msg.swipeIndex + 1}/${swipes.length}`;

      const next = document.createElement('button');
      next.className = 'btn-action';
      next.appendChild(icon(ChevronRight, 16));
      next.title = 'Next version';
      next.disabled = msg.swipeIndex === swipes.length - 1;
      next.addEventListener('click', (e) => { e.stopPropagation(); swipeMessage(histIdx, 1, State); });

      bar.append(prev, counter, next);
    }

    const regen = document.createElement('button');
    regen.className = 'btn-action';
    regen.appendChild(icon(RefreshCw, 16));
    regen.title = 'Regenerate';
    regen.addEventListener('click', (e) => { e.stopPropagation(); regenerateFrom(histIdx, State); });
    bar.appendChild(regen);
  }

  // User message is the last message → offer to generate a response
  if (msg?.role === 'user' && histIdx === State.chatHistory.length - 1) {
    const gen = document.createElement('button');
    gen.className = 'btn-action';
    gen.appendChild(icon(Play, 16));
    gen.title = 'Generate response';
    gen.addEventListener('click', (e) => { e.stopPropagation(); streamResponse(State); });
    bar.appendChild(gen);
  }

  headerEl.appendChild(bar);
}

function enterEditMode(msgEl, histIdx, State) {
  if (State.isStreaming) return;
  const msg = State.chatHistory[histIdx];
  const bodyEl = msgEl.querySelector('.message-body');

  // Measure before any DOM changes
  const currentHeight = bodyEl.offsetHeight;
  const maxH = Math.floor(window.innerHeight * 0.5);

  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-input';
  textarea.value = msg.content;
  textarea.style.height = Math.max(Math.min(currentHeight, maxH), 80) + 'px';
  textarea.style.maxHeight = maxH + 'px';
  textarea.style.overflowY = 'auto';
  textarea.style.resize = 'vertical';

  const editBar = document.createElement('div');
  editBar.className = 'message-edit-bar';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-action';
  saveBtn.title = 'Save';
  saveBtn.appendChild(icon(Check, 16));
  saveBtn.addEventListener('click', async () => {
    const newContent = textarea.value;
    if (newContent !== msg.content) {
      msg.content = newContent;
      if (msg.swipes) msg.swipes[msg.swipeIndex] = newContent;
      await replaceMessages(State.activeSessionId, State.chatHistory);
    }
    exitEditMode(msgEl, histIdx, State, msg);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-action';
  cancelBtn.title = 'Cancel';
  cancelBtn.appendChild(icon(X, 16));
  cancelBtn.addEventListener('click', () => exitEditMode(msgEl, histIdx, State, msg));

  editBar.append(saveBtn, cancelBtn);

  lockScroll(msgEl, () => {
    msgEl.style.minWidth = msgEl.offsetWidth + 'px';
    msgEl.closest('.message-row')?.querySelector('.message-actions')?.remove();
    bodyEl.replaceWith(textarea);
    msgEl.appendChild(editBar);
  });

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

function exitEditMode(msgEl, histIdx, State, msg) {
  lockScroll(msgEl, () => {
    const textarea = msgEl.querySelector('.message-edit-input');
    if (textarea) {
      const body = document.createElement('div');
      body.className = 'message-body';
      body.innerHTML = formatMessageContent(msg.content);
      textarea.replaceWith(body);
    }
    msgEl.querySelector('.message-edit-bar')?.remove();
    msgEl.style.minWidth = '';
    buildActionsBar(msgEl, histIdx, State, msg);
  });
}

async function deleteMessage(histIdx, State) {
  if (State.isStreaming) return;
  const chain = State.settings?.deleteMode === 'chain';
  if (chain) {
    State.chatHistory.splice(histIdx);
  } else {
    State.chatHistory.splice(histIdx, 1);
  }
  await replaceMessages(State.activeSessionId, State.chatHistory);
  renderMessages(State);
}

let _branching = false;
async function branchFrom(histIdx, State) {
  if (State.isStreaming || _branching) return;
  _branching = true;
  try {
    const slice = State.chatHistory.slice(0, histIdx + 1);
    const char  = State.sessionCharacter;
    const title = `Branch: ${slice.find(m => m.role === 'user')?.content?.slice(0, 40) ?? 'chat'}…`;
    const meta  = await createSession({
      title,
      characterId:   char?.id   ?? null,
      characterName: char?.name ?? null,
      personaId:     State.sessionPersona?.id ?? null,
    });
    await replaceMessages(meta.id, slice);
    // Keep in sync with newSession(): meta must be in State.sessions so the
    // Characters panel's chats list shows it and the active highlight moves.
    meta.messageCount       = slice.length;
    meta.lastMessagePreview = slice[slice.length - 1]?.content?.slice(0, 120) ?? null;
    State.sessions.unshift(meta);
    await selectSession(meta.id, State);
    document.dispatchEvent(new CustomEvent('sessionscreated', { detail: { session: meta } }));
  } catch (err) {
    console.error('[branchFrom]', err);
  } finally {
    _branching = false;
  }
}

async function swipeMessage(histIdx, direction, State) {
  if (State.isStreaming) return;
  const msg = State.chatHistory[histIdx];
  if (!msg?.swipes) return;

  const newIdx = Math.max(0, Math.min(msg.swipes.length - 1, msg.swipeIndex + direction));
  if (newIdx === msg.swipeIndex) return;

  msg.swipeIndex = newIdx;
  msg.content = msg.swipes[newIdx];

  const msgEl = document.querySelector(`[data-history-index="${histIdx}"]`);
  if (msgEl) {
    scrollMessageIntoView(msgEl);
    msgEl.querySelector('.message-body').innerHTML = formatMessageContent(msg.content);
    buildActionsBar(msgEl, histIdx, State, msg);
  }

  await replaceMessages(State.activeSessionId, State.chatHistory);
}

// ── Regenerate ────────────────────────────────────────────────────────────────

async function regenerateFrom(msgIndex, State) {
  if (State.isStreaming) return;

  // Last assistant message → swipe-mode regen (keeps history, adds alternate)
  if (msgIndex === State.chatHistory.length - 1) {
    const msgEl = document.querySelector(`[data-history-index="${msgIndex}"]`);
    if (!msgEl) { console.error('[regenerateFrom] msgEl not found for index', msgIndex); return; }
    try {
      await regenAsSwipe(msgIndex, msgEl, State);
    } catch (err) {
      console.error('[regenerateFrom] unexpected throw:', err);
      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;
    }
    return;
  }

  // Earlier message → truncate everything from this point and re-stream
  State.chatHistory = State.chatHistory.slice(0, msgIndex);
  await replaceMessages(State.activeSessionId, State.chatHistory);
  renderMessages(State);
  await streamResponse(State);
}

/**
 * Regenerate the last assistant message in-place, storing the new content as
 * an additional swipe. Does NOT truncate history — the preceding context stays.
 */
async function regenAsSwipe(histIdx, msgEl, State) {
  const msg = State.chatHistory[histIdx];
  msgEl.classList.remove('message--error');
  if (!msg.swipes) { msg.swipes = [msg.content]; msg.swipeIndex = 0; }

  const _streamSessionId = State.activeSessionId;
  const _streamTitle = State.sessions?.find(s => s.id === _streamSessionId)?.title || 'Chat';
  scrollMessageIntoView(msgEl);
  State.isStreaming = true;
  setSendState(true, State);

  const personaName = State.sessionPersona?.name || 'User';
  const _gs = State.settings?.promptPresets?.find(p => p.id === State.settings?.activePromptPresetId)?.generationSettings ?? {};
  // Assemble without the target message so the model doesn't see its own prior response
  const historySlice = State.chatHistory.slice(0, histIdx);
  const messages = assembleMessages(State.prompts, State.sessionCharacter ?? {}, historySlice, personaName, State.sessionPersona, { contextSize: _gs.context_size || 0, maxTokens: _gs.max_tokens || 0 });
  console.log('[regenAsSwipe] char:', State.sessionCharacter?.name ?? '(none)',
    '| persona:', personaName, '| prompts:', State.prompts?.length ?? 0,
    '| out:', messages.length, 'msgs');

  const bodyEl = msgEl.querySelector('.message-body');
  msgEl.classList.add('message--streaming');
  msgEl.closest('.message-row')?.querySelector('.message-actions')?.remove();
  bodyEl.textContent = '';
  const typingIndicator = addTypingIndicator(bodyEl);

  // Force paint so dots are visible before stream starts
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  let dotsGone = false;
  let accumulated = '';
  let inThinkBlock    = false;
  let thinkDone       = false;
  let hadContent      = false;
  let thinkStartTime  = null;
  let thinkTimerId    = null;
  let thinkDetailsEl  = null;
  let thinkSummaryEl  = null;
  let thinkContentEl  = null;

  const dotTimer = setTimeout(() => {
    typingIndicator.remove();
    dotsGone = true;
    handleSwipeToken('');
  }, 400);

  function handleSwipeToken(token) {
    accumulated += token;
    if (!dotsGone) return;

    if (!inThinkBlock && !thinkDone && /<think/i.test(accumulated)) {
      inThinkBlock = true;
      thinkStartTime = Date.now();
      bodyEl.innerHTML = '';
      thinkDetailsEl = document.createElement('details');
      thinkDetailsEl.open = true;
      thinkDetailsEl.className = 'thinking-block';
      thinkSummaryEl = document.createElement('summary');
      thinkSummaryEl.className = 'thinking-summary';
      thinkSummaryEl.textContent = 'Reasoning · 0s…';
      thinkContentEl = document.createElement('div');
      thinkContentEl.className = 'thinking-content';
      thinkDetailsEl.appendChild(thinkSummaryEl);
      thinkDetailsEl.appendChild(thinkContentEl);
      bodyEl.appendChild(thinkDetailsEl);
      thinkTimerId = setInterval(() => {
        const s = Math.round((Date.now() - thinkStartTime) / 1000);
        thinkSummaryEl.textContent = `Reasoning · ${s}s…`;
      }, 1000);
    }

    if (inThinkBlock && /<\/(?:think|thinking)>/i.test(accumulated)) {
      inThinkBlock = false;
      thinkDone = true;
      clearInterval(thinkTimerId); thinkTimerId = null;
      const elapsed = Math.round((Date.now() - thinkStartTime) / 1000);
      thinkSummaryEl.textContent = `Reasoning · ${elapsed}s`;
      return;
    }

    if (inThinkBlock) {
      const m = accumulated.match(/<think>([\s\S]*)/i);
      if (m) thinkContentEl.textContent = m[1];
      return;
    }

    if (thinkDone && !hadContent) {
      hadContent = true;
      if (thinkDetailsEl) thinkDetailsEl.removeAttribute('open');
    }
    bodyEl.innerHTML = formatMessageContent(accumulated);
  }

  cancelStream = streamCompletion(
    messages,
    State.activeSessionId,
    handleSwipeToken,
    async (event) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      clearInterval(thinkTimerId);
      msgEl.classList.remove('message--streaming');
      bodyEl.innerHTML = formatMessageContent(accumulated);

      if (State.activeSessionId !== _streamSessionId) {
        showToast(`Response completed in "${_streamTitle}"`, 'info', {
          action: { label: 'View', onClick: () => selectSession(_streamSessionId, State) },
        });
      }

      if (accumulated.trim()) {
        msg.swipes.push(accumulated);
        msg.swipeIndex = msg.swipes.length - 1;
        msg.content = accumulated;
        msg.metadata = { ...(msg.metadata ?? {}), usage: event.usage ?? {}, duration: event.duration ?? 0 };
      } else {
        // Aborted or empty — restore the previously active swipe
        msg.content = msg.swipes[msg.swipeIndex];
        bodyEl.innerHTML = formatMessageContent(msg.content);
      }

      // Rebuild UI synchronously before any async work or state reset —
      // ensures action bar is always restored even if the save below fails.
      buildActionsBar(msgEl, histIdx, State, msg);
      renderMsgMeta(msgEl, msg, State);

      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;

      if (accumulated.trim()) {
        try {
          await replaceMessages(_streamSessionId, State.chatHistory);
        } catch (err) {
          console.error('[regenAsSwipe] save failed:', err);
        }
      }
    },
    (errMsg) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      msgEl.classList.remove('message--streaming');
      msgEl.classList.add('message--error');
      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;
      msg.content = msg.swipes[msg.swipeIndex];
      bodyEl.textContent = 'Error: ' + errMsg;
      console.error('[regenAsSwipe]', errMsg);
      setTimeout(() => {
        msgEl.classList.remove('message--error');
        bodyEl.innerHTML = formatMessageContent(msg.content);
        buildActionsBar(msgEl, histIdx, State, msg);
      }, 3000);
    },
  );
}

// ── Send / Stream ─────────────────────────────────────────────────────────────

async function sendMessage(State) {
  const input = el('chat-input');
  const text = input.value.trim();
  if (!text || State.isStreaming) return;

  if (!State.activeSessionId) {
    await newSession(State);
  }

  input.value = '';

  // Persist + show user message
  const userMsg = { role: 'user', content: text };
  const msgIdx = State.chatHistory.length;
  appendMessageEl('user', text, null, false, null, State);
  State.chatHistory.push(userMsg);
  await appendMessage(State.activeSessionId, userMsg);

  await streamResponse(State);
}

function addTypingIndicator(bodyEl) {
  const wrap = document.createElement('span');
  wrap.className = 'typing-indicator';
  wrap.innerHTML = '<span></span><span></span><span></span>';
  bodyEl.appendChild(wrap);
  return wrap;
}

async function streamResponse(State) {
  if (State.isStreaming) return;

  const _streamSessionId = State.activeSessionId;
  const _streamTitle = State.sessions?.find(s => s.id === _streamSessionId)?.title || 'Chat';
  State.isStreaming = true;
  setSendState(true, State);

  const personaName = State.sessionPersona?.name || 'User';
  const _gs = State.settings?.promptPresets?.find(p => p.id === State.settings?.activePromptPresetId)?.generationSettings ?? {};

  const messages = assembleMessages(
    State.prompts,
    State.sessionCharacter ?? {},
    State.chatHistory,
    personaName,
    State.sessionPersona,
    { contextSize: _gs.context_size || 0, maxTokens: _gs.max_tokens || 0 },
  );
  console.log('[assembly] char:', State.sessionCharacter?.name ?? '(none)',
    '| persona:', personaName,
    '| prompts:', State.prompts.length,
    '| out:', messages.length, 'msgs');
  console.log('[assembly] full payload:', JSON.stringify(messages, null, 2));
  console.log('[assembly] message roles:\n' + messages.map((m, i) => i + ': ' + m.role + ' — ' + m.content.substring(0, 60)).join('\n'));

  const charName = State.sessionCharacter?.name ?? null;
  const assistantEl = appendMessageEl('assistant', '', charName, true, null, State);
  const bodyEl = assistantEl.querySelector('.message-body');
  const typingIndicator = addTypingIndicator(bodyEl);
  scrollToBottom();

  // Force a browser paint so the typing dots are visible before the stream starts
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  let dotsGone = false;
  let accumulated = '';
  let inThinkBlock    = false;
  let thinkDone       = false;
  let hadContent      = false;
  let thinkStartTime  = null;
  let thinkTimerId    = null;
  let thinkDetailsEl  = null;
  let thinkSummaryEl  = null;
  let thinkContentEl  = null;

  const dotTimer = setTimeout(() => {
    typingIndicator.remove();
    dotsGone = true;
    handleToken(''); // catch-up render with whatever accumulated so far
  }, 400);

  function handleToken(token) {
      accumulated += token;
      if (!dotsGone) return;

      if (!inThinkBlock && !thinkDone && /<think/i.test(accumulated)) {
        inThinkBlock = true;
        thinkStartTime = Date.now();
        bodyEl.innerHTML = '';
        thinkDetailsEl = document.createElement('details');
        thinkDetailsEl.open = true;
        thinkDetailsEl.className = 'thinking-block';
        thinkSummaryEl = document.createElement('summary');
        thinkSummaryEl.className = 'thinking-summary';
        thinkSummaryEl.textContent = 'Reasoning · 0s…';
        thinkContentEl = document.createElement('div');
        thinkContentEl.className = 'thinking-content';
        thinkDetailsEl.appendChild(thinkSummaryEl);
        thinkDetailsEl.appendChild(thinkContentEl);
        bodyEl.appendChild(thinkDetailsEl);
        thinkTimerId = setInterval(() => {
          const s = Math.round((Date.now() - thinkStartTime) / 1000);
          thinkSummaryEl.textContent = `Reasoning · ${s}s…`;
        }, 1000);
      }

      if (inThinkBlock && /<\/(?:think|thinking)>/i.test(accumulated)) {
        inThinkBlock = false;
        thinkDone = true;
        clearInterval(thinkTimerId); thinkTimerId = null;
        const elapsed = Math.round((Date.now() - thinkStartTime) / 1000);
        thinkSummaryEl.textContent = `Reasoning · ${elapsed}s`;
        return;
      }

      if (inThinkBlock) {
        const m = accumulated.match(/<think>([\s\S]*)/i);
        if (m) thinkContentEl.textContent = m[1];
        return;
      }

      if (thinkDone && !hadContent) {
        hadContent = true;
        if (thinkDetailsEl) thinkDetailsEl.removeAttribute('open');
      }
      bodyEl.innerHTML = formatMessageContent(accumulated);
  }

  cancelStream = streamCompletion(
    messages,
    State.activeSessionId,
    handleToken,
    // onDone — fires on clean finish OR user-cancelled (event.aborted === true)
    async (event) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      clearInterval(thinkTimerId);
      assistantEl.classList.remove('message--streaming');
      bodyEl.innerHTML = formatMessageContent(accumulated); // final render with collapsed think block

      if (State.activeSessionId !== _streamSessionId) {
        showToast(`Response completed in "${_streamTitle}"`, 'info', {
          action: { label: 'View', onClick: () => selectSession(_streamSessionId, State) },
        });
      }

      if (accumulated.trim()) {
        const metadata = {
          model: event.model ?? '',
          usage: event.usage ?? {},
          duration: event.duration ?? 0,
        };
        const histIdx = State.chatHistory.length;
        const histMsg = { role: 'assistant', content: accumulated, metadata };
        State.chatHistory.push(histMsg);

        // Build UI synchronously before any async work
        assistantEl.dataset.historyIndex = histIdx;
        buildActionsBar(assistantEl, histIdx, State, histMsg);
        renderMsgMeta(assistantEl, histMsg, State);

        State.isStreaming = false;
        setSendState(false, State);
        cancelStream = null;

        // On normal completion the server persists via streamProxy [DONE].
        // On abort, the server never got [DONE], so persist client-side.
        if (event.aborted) {
          await appendMessage(State.activeSessionId, histMsg).catch(() => {});
        }
      } else if (event.aborted) {
        // No content arrived — remove the empty bubble
        (assistantEl.closest('.message-row') || assistantEl).remove();
        State.isStreaming = false;
        setSendState(false, State);
        cancelStream = null;
      } else {
        State.isStreaming = false;
        setSendState(false, State);
        cancelStream = null;
      }
    },
    // onError
    (errMsg) => {
      clearTimeout(dotTimer);
      typingIndicator.remove();
      assistantEl.classList.remove('message--streaming');
      assistantEl.classList.add('message--error');
      bodyEl.textContent = 'Error: ' + errMsg; // plain text for errors
      State.isStreaming = false;
      setSendState(false, State);
      cancelStream = null;
      // Push a placeholder so the action bar (regen/delete) works on the error bubble
      const histIdx = State.chatHistory.length;
      const histMsg = { role: 'assistant', content: '' };
      State.chatHistory.push(histMsg);
      assistantEl.dataset.historyIndex = histIdx;
      buildActionsBar(assistantEl, histIdx, State, histMsg);
    },
  );
}

function setSendState(streaming, State) {
  const btn = el('chat-send');
  if (!btn) return;
  const fresh = btn.cloneNode(true);
  btn.parentNode.replaceChild(fresh, btn);
  const newBtn = el('chat-send');
  newBtn.textContent = streaming ? 'Stop' : 'Send';
  if (streaming) {
    newBtn.addEventListener('click', () => {
      if (cancelStream) cancelStream();
      if (State.activeSessionId) abortStream(State.activeSessionId).catch(() => {});
    });
  } else {
    newBtn.addEventListener('click', () => sendMessage(State));
  }
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { selectSession, newSession, renderMessages };
