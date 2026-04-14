import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath } from '../lib/fileStore.js';
import { requireString, requireEnum, requireArray } from '../lib/validate.js';
import { randomUUID } from 'crypto';

const router = Router();
const SETTINGS_FILE = dataPath('settings.json');

// Locked read-modify-write: fn(stack, settings) → newStack
async function withActiveStack(fn) {
  let result;
  await withLock(SETTINGS_FILE, (settings) => {
    const preset = settings.promptPresets?.find(p => p.id === settings.activePromptPresetId);
    const stack = preset?.stack || [];
    const { newStack, value } = fn(stack, settings);
    result = value;
    const idx = settings.promptPresets?.findIndex(p => p.id === settings.activePromptPresetId);
    if (idx >= 0) settings.promptPresets[idx].stack = newStack;
    return settings;
  });
  return result;
}

// GET /api/prompts — return active preset's stack; auto-add chatHistory sentinel if missing
router.get('/', async (_req, res) => {
  try {
    const stack = await withActiveStack((stack) => {
      if (!stack.some(e => e.type === 'chatHistory')) {
        stack.push({
          id: 'entry_chathistory',
          type: 'chatHistory',
          label: 'Chat History',
          content: null,
          enabled: true,
          role: null,
          injection_depth: 0,
        });
      }
      return { newStack: stack, value: stack };
    });
    res.json({ entries: stack });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/prompts — full replace of active preset's stack
router.put('/', async (req, res) => {
  try {
    const entries = req.body.entries;
    await withActiveStack((stack) => ({ newStack: entries, value: null }));
    res.json({ entries });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/prompts — add one entry to active preset's stack
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    requireEnum(b, 'type', ['system', 'character', 'chatHistory', 'persona', 'user', 'assistant'], { optional: true });
    requireEnum(b, 'role', ['system', 'user', 'assistant', null], { optional: true });
    requireString(b, 'label', { optional: true, maxLen: 200 });
    requireString(b, 'content', { optional: true, maxLen: 100000 });

    const entry = {
      id: 'entry_' + randomUUID().slice(0, 8),
      type: 'system',
      label: 'New Entry',
      content: '',
      enabled: true,
      role: 'system',
      injection_depth: 0,
      ...b,
    };
    await withActiveStack((stack) => {
      stack.push(entry);
      return { newStack: stack, value: null };
    });
    res.status(201).json(entry);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/prompts/:id — partial update of one entry
router.patch('/:id', async (req, res) => {
  try {
    const updated = await withActiveStack((stack) => {
      const idx = stack.findIndex(e => e.id === req.params.id);
      if (idx === -1) { const e = new Error('Not found'); e.status = 404; throw e; }
      stack[idx] = { ...stack[idx], ...req.body, id: req.params.id };
      return { newStack: stack, value: stack[idx] };
    });
    res.json(updated);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/prompts/:id
router.delete('/:id', async (req, res) => {
  try {
    await withActiveStack((stack) => {
      const newStack = stack.filter(e => e.id !== req.params.id);
      if (newStack.length === stack.length) { const e = new Error('Not found'); e.status = 404; throw e; }
      return { newStack, value: null };
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/prompts/reorder — body: { ids: string[] }
router.put('/reorder', async (req, res) => {
  try {
    requireArray(req.body, 'ids');
    const { ids } = req.body;
    if (!ids.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: 'ids must be an array of strings' });
    }
    const result = await withActiveStack((stack) => {
      const map = Object.fromEntries(stack.map(e => [e.id, e]));
      const reordered = ids.map(id => map[id]).filter(Boolean);
      const extra = stack.filter(e => !ids.includes(e.id));
      const newStack = [...reordered, ...extra];
      return { newStack, value: newStack };
    });
    res.json({ entries: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
