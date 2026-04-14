import { Router } from 'express';
import { readJSON, dataPath } from '../lib/fileStore.js';

const router = Router();

// GET /api/models — fetches available models from the configured provider
router.get('/', async (_req, res) => {
  try {
    const settings = await readJSON(dataPath('settings.json'));
    const conn = settings.connectionPresets?.find(p => p.id === settings.activeConnectionPresetId);
    if (!conn?.apiKey) return res.status(400).json({ error: 'No API key in active connection preset' });

    const isAnthropic = conn.provider === 'anthropic';
    const url = conn.baseURL.replace(/\/$/, '') + '/models';
    const response = await fetch(url, {
      headers: isAnthropic
        ? { 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Authorization': `Bearer ${conn.apiKey}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();

    // Normalize: all providers return { data: [ { id, ... } ] }
    const models = (data.data ?? [])
      .map(m => ({ id: m.id, name: m.display_name ?? m.name ?? m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));

    res.json({ models });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
