/**
 * assembler.js — Prompt assembly
 *
 * Pure function: takes state, returns a messages array. No network calls.
 *
 * Stack anatomy (mirrors SillyTavern's context assembly):
 *
 *   [type:system]      — regular system/user/assistant prompt entries
 *   [type:character]   — expands to formatted character card fields
 *   [type:chatHistory] — sentinel: chat messages are inserted here
 *   [type:system]      — entries after this go POST chat history (jailbreak, nudge, etc.)
 *
 * injection_depth > 0:
 *   Entry is NOT placed at its stack position. Instead it is inserted within
 *   the chat history block, N messages from the bottom (depth=1 → before the
 *   last message, depth=2 → before second-to-last, etc.). Used for Authors Note.
 *   These entries are skipped during the main pass and woven in during chat insertion.
 */

/**
 * Assemble the final messages array to POST to the model.
 *
 * @param {Array}  promptEntries  ordered entries from prompts.json
 * @param {Object} character      character card fields
 * @param {Array}  chatHistory    [{role, content}] for the active session
 * @returns {Array}               [{role, content}] ready to send
 */
export function assembleMessages(promptEntries, character, chatHistory, personaName = 'User', persona = null, { contextSize = 0, maxTokens = 0 } = {}) {
  const charName = character?.name || 'Character';
  const enabled = promptEntries.filter(e => e.enabled);

  // Context capping — trim oldest chat messages to fit within budget
  if (contextSize > 0) {
    let systemTokens = 0;
    for (const e of enabled) {
      if (e.type === 'chatHistory') continue;
      if (e.type === 'character') systemTokens += estimateTokens(formatCharacterCard(character));
      else if (e.type === 'persona') systemTokens += estimateTokens(persona?.description ?? '');
      else systemTokens += estimateTokens(e.content ?? '');
    }
    const budget = Math.max(0, contextSize - maxTokens - systemTokens);
    let used = 0;
    let keepFrom = 0;
    for (let i = chatHistory.length - 1; i >= 0; i--) {
      const t = estimateTokens(chatHistory[i].content ?? '');
      if (used + t > budget) { keepFrom = i + 1; break; }
      used += t;
    }
    if (keepFrom > 0) chatHistory = chatHistory.slice(keepFrom);
  }

  // Split into depth-injected vs normal entries.
  // Depth-injected entries are woven INTO the chat history block; they are
  // skipped during the main pass.
  const isDepthEntry = e => e.type !== 'chatHistory' &&
    (e.injection_position === 1 || (!e.injection_position && (e.injection_depth ?? 0) > 0));
  const depthEntries = enabled.filter(isDepthEntry);
  const mainEntries  = enabled.filter(e => !isDepthEntry(e));

  // If there is no chatHistory sentinel in the enabled entries, fall back to
  // appending chat history at the end (graceful degradation for old data).
  const hasSentinel = mainEntries.some(e => e.type === 'chatHistory');

  const messages = [];

  for (const entry of mainEntries) {
    if (entry.type === 'chatHistory') {
      // Weave depth-injected entries and chat messages together
      insertChatHistory(messages, chatHistory, depthEntries, charName, personaName);
    } else if (entry.type === 'character') {
      const content = formatCharacterCard(character);
      if (content) messages.push({ role: entry.role || 'system', content });
    } else if (entry.type === 'persona') {
      const desc = persona?.description?.trim();
      if (desc) messages.push({ role: entry.role || 'system', content: substitutePlaceholders(desc, charName, personaName) });
    } else {
      if (entry.content) {
        const content = substitutePlaceholders(entry.content, charName, personaName);
        messages.push({ role: entry.role || 'system', content });
      }
    }
  }

  // Fallback: no sentinel found
  if (!hasSentinel) {
    insertChatHistory(messages, chatHistory, depthEntries, charName, personaName);
  }

  // Phase 2 stub: prepend persistent tool-result injections from prior turns
  // Final pass: run substitution over every message so character card content,
  // depth-injected entries, and any other path that skipped substitution are covered.
  return applyPersistentInjections(messages).map(msg => ({
    ...msg,
    content: substitutePlaceholders(msg.content ?? '', charName, personaName),
  }));
}

/**
 * Insert chat history messages into the messages array, weaving in any
 * depth-injected entries at the appropriate positions.
 *
 * depth=1 → inserted before the last chat message
 * depth=2 → inserted before the second-to-last, etc.
 * If depth exceeds chat length, the entry is prepended before all chat messages.
 */
function insertChatHistory(messages, chatHistory, depthEntries, charName = 'Character', personaName = 'User') {
  const len = chatHistory.length;

  for (let i = 0; i < len; i++) {
    // Insert depth entries whose target index is this position
    for (const dep of depthEntries) {
      if (!dep.content) continue;
      // targetIdx: position in chatHistory where this entry should appear before
      const targetIdx = Math.max(0, len - dep.injection_depth);
      if (i === targetIdx) {
        messages.push({ role: dep.role || 'system', content: substitutePlaceholders(dep.content, charName, personaName) });
      }
    }
    messages.push({ role: chatHistory[i].role, content: chatHistory[i].content });
  }

  // Depth entries whose depth exceeds chat length → prepend before all chat
  // (they were already missed in the loop above since targetIdx would be 0;
  //  but if chat is empty they'd never fire — insert them now if chat was empty)
  if (len === 0) {
    for (const dep of depthEntries) {
      if (dep.content) messages.push({ role: dep.role || 'system', content: dep.content });
    }
  }
}

/**
 * Replace {{char}} and {{user}} placeholders — SillyTavern convention.
 * {{char}} → character's name, {{user}} → "User"
 */
function substitutePlaceholders(text, charName, personaName = 'User') {
  return text
    .replaceAll('{{char}}', charName)
    .replaceAll('{{Char}}', charName)
    .replaceAll('{{user}}', personaName)
    .replaceAll('{{User}}', personaName);
}

function formatCharacterCard(c) {
  if (!c) return '';
  const parts = [];
  if (c.name)        parts.push(`Name: ${c.name}`);
  if (c.description) parts.push(`Description: ${c.description}`);
  if (c.personality) parts.push(`Personality: ${c.personality}`);
  if (c.scenario)    parts.push(`Scenario: ${c.scenario}`);
  return parts.join('\n');
}

/** Rough token estimate (~3.5 chars per token). Synchronous, no worker needed. */
function estimateTokens(text) {
  return Math.ceil((text ?? '').length / 3.5);
}

/**
 * Phase 2 stub — no-op in Phase 1.
 * Phase 2: prepend persistently stored tool results (scene state, positions, etc.)
 * that should always be visible to the model.
 */
function applyPersistentInjections(messages) {
  return messages;
}
