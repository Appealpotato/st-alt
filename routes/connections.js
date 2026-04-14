import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath } from '../lib/fileStore.js';
import { requireString, requireEnum } from '../lib/validate.js';
import { randomUUID } from 'crypto';

const router = Router();
const FILE = dataPath('settings.json');
const MASKED = '••••••••';

function maskPreset(p) {
  return { ...p, apiKey: p.apiKey ? MASKED : '' };
}

// GET /api/connections — list all connection presets
router.get('/', async (_req, res) => {
  try {
    const settings = await readJSON(FILE);
    res.json({
      presets: (settings.connectionPresets || []).map(maskPreset),
      activeId: settings.activeConnectionPresetId,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/connections — create a new connection preset
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    requireString(b, 'name', { optional: true, maxLen: 200 });
    requireEnum(b, 'provider', ['openai', 'openrouter', 'anthropic'], { optional: true });
    requireString(b, 'baseURL', { optional: true, maxLen: 500 });
    requireString(b, 'apiKey', { optional: true, maxLen: 500 });
    requireString(b, 'selectedModel', { optional: true, maxLen: 200 });

    const preset = {
      name: 'New Connection',
      provider: 'openai',
      baseURL: '',
      apiKey: '',
      selectedModel: '',
      reasoning: { enabled: false, effort: 'medium' },
      ...b,
      id: 'conn_' + randomUUID().slice(0, 8),
    };
    await withLock(FILE, (settings) => {
      settings.connectionPresets.push(preset);
      return settings;
    });
    res.status(201).json({ preset: maskPreset(preset) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/connections/:id — update a connection preset (partial merge)
router.put('/:id', async (req, res) => {
  try {
    const incoming = req.body;
    let result;
    await withLock(FILE, (settings) => {
      const idx = settings.connectionPresets.findIndex(p => p.id === req.params.id);
      if (idx === -1) { const e = new Error('Connection preset not found'); e.status = 404; throw e; }

      const existing = settings.connectionPresets[idx];
      const apiKey = incoming.apiKey === MASKED ? existing.apiKey : (incoming.apiKey ?? existing.apiKey);

      settings.connectionPresets[idx] = {
        ...existing,
        ...incoming,
        id: req.params.id,
        apiKey,
      };
      result = settings.connectionPresets[idx];
      return settings;
    });
    res.json({ preset: maskPreset(result) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/connections/:id — delete a connection preset
router.delete('/:id', async (req, res) => {
  try {
    let activeId;
    await withLock(FILE, (settings) => {
      if ((settings.connectionPresets || []).length < 2) {
        const e = new Error('Cannot delete the last connection preset'); e.status = 400; throw e;
      }
      const idx = settings.connectionPresets.findIndex(p => p.id === req.params.id);
      if (idx === -1) { const e = new Error('Connection preset not found'); e.status = 404; throw e; }

      settings.connectionPresets.splice(idx, 1);
      if (settings.activeConnectionPresetId === req.params.id) {
        settings.activeConnectionPresetId = settings.connectionPresets[0].id;
      }
      activeId = settings.activeConnectionPresetId;
      return settings;
    });
    res.json({ deleted: req.params.id, activeId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
