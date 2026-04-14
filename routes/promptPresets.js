import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath } from '../lib/fileStore.js';
import { randomUUID } from 'crypto';

const router = Router();
const FILE = dataPath('settings.json');

const DEFAULT_GEN_SETTINGS = {
  temperature: 0.85,
  top_p: 0.95,
  frequency_penalty: 0.0,
  presence_penalty: 0.0,
  max_tokens: 1000,
};

// GET /api/prompt-presets — list all prompt presets
router.get('/', async (_req, res) => {
  try {
    const settings = await readJSON(FILE);
    res.json({
      presets: settings.promptPresets || [],
      activeId: settings.activePromptPresetId,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/prompt-presets — create a new prompt preset
router.post('/', async (req, res) => {
  try {
    const preset = {
      name: 'New Prompts',
      stack: [],
      generationSettings: { ...DEFAULT_GEN_SETTINGS },
      ...req.body,
      id: 'prompt_' + randomUUID().slice(0, 8),
    };
    await withLock(FILE, (settings) => {
      settings.promptPresets.push(preset);
      return settings;
    });
    res.status(201).json({ preset });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/prompt-presets/:id — update a prompt preset (partial merge)
router.put('/:id', async (req, res) => {
  try {
    const incoming = req.body;
    let result;
    await withLock(FILE, (settings) => {
      const idx = settings.promptPresets.findIndex(p => p.id === req.params.id);
      if (idx === -1) { const e = new Error('Prompt preset not found'); e.status = 404; throw e; }

      const existing = settings.promptPresets[idx];
      const updated = { ...existing, ...incoming, id: req.params.id };

      if (incoming.generationSettings) {
        updated.generationSettings = { ...existing.generationSettings, ...incoming.generationSettings };
      }

      settings.promptPresets[idx] = updated;
      result = updated;
      return settings;
    });
    res.json({ preset: result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/prompt-presets/:id — delete a prompt preset
router.delete('/:id', async (req, res) => {
  try {
    let activeId;
    await withLock(FILE, (settings) => {
      if ((settings.promptPresets || []).length < 2) {
        const e = new Error('Cannot delete the last prompt preset'); e.status = 400; throw e;
      }
      const idx = settings.promptPresets.findIndex(p => p.id === req.params.id);
      if (idx === -1) { const e = new Error('Prompt preset not found'); e.status = 404; throw e; }

      settings.promptPresets.splice(idx, 1);
      if (settings.activePromptPresetId === req.params.id) {
        settings.activePromptPresetId = settings.promptPresets[0].id;
      }
      activeId = settings.activePromptPresetId;
      return settings;
    });
    res.json({ deleted: req.params.id, activeId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
