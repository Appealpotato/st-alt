import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath, createCharacterCard } from '../lib/fileStore.js';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';

const router = Router();
const FILE = dataPath('settings.json');
const AVATAR_DIR = dataPath('avatars');
const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const upload = multer({
  dest: AVATAR_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_EXTS.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const MASKED = '••••••••';

function maskSettings(s) {
  return {
    ...s,
    connectionPresets: (s.connectionPresets || []).map(p => ({
      ...p,
      apiKey: p.apiKey ? MASKED : '',
    })),
  };
}

// Fields allowed through the scalar PUT — preset arrays are managed by their own routes
const SCALAR_FIELDS = [
  'activeConnectionPresetId', 'activePromptPresetId', 'activeCharacterId',
  'activePersonaId', 'avatarShape', 'charBrowserView',
  'chatDisplayMode', 'dialogueColor', 'chatMaxWidth', 'chatAlign',
  'showMsgModel', 'showMsgTokens', 'showMsgDuration', 'showMsgDividers',
  'chatFont', 'uiFont', 'chatFontSize', 'uiFontSize', 'chatLineHeight',
  'deleteMode',
];

const SETTING_DEFAULTS = {
  activePersonaId: null,
  avatarShape: 'circle',
  charBrowserView: 'grid',
  chatDisplayMode: 'bubble',
  dialogueColor: '#ef6b6b',
  chatMaxWidth: 100,
  showMsgModel: false,
  showMsgTokens: false,
  showMsgDuration: false,
  showMsgDividers: false,
  chatFont: 'system',
  uiFont: 'system',
  chatFontSize: 14,
  uiFontSize: 13,
  chatLineHeight: 1.6,
  deleteMode: 'single',
  connectionPresets: [],
  promptPresets: [],
  activeConnectionPresetId: null,
  activePromptPresetId: null,
};

// Migrate persona fields → character card with type:'persona'
async function migratePersonaIfNeeded(settings) {
  if (!settings.persona?.name || settings.activePersonaId) return settings;
  const id = 'char_' + randomUUID().replace(/-/g, '').slice(0, 8);
  await createCharacterCard({
    id,
    type:         'persona',
    name:         settings.persona.name,
    description:  settings.persona.description ?? '',
    personality:  '',
    scenario:     '',
    firstMessage: '',
    avatar:       settings.personaAvatar ?? null,
  });
  settings.activePersonaId = id;
  delete settings.persona;
  delete settings.personaAvatar;
  await writeJSON(FILE, settings);
  return settings;
}

// One-time migration: if settings still has old flat fields, move them into presets
// Exported so server.js can call it at startup before any routes are hit
export async function migrateIfNeeded(settings) {
  if (!settings.connectionPresets) {
    // Read old prompt stack from prompts.json
    let stack = [];
    try {
      const promptsData = await readJSON(dataPath('prompts.json'));
      stack = promptsData.entries || [];
    } catch { /* use empty stack */ }

    const connId   = 'conn_'   + randomUUID().slice(0, 8);
    const promptId = 'prompt_' + randomUUID().slice(0, 8);

    // Map old provider enum: 'custom' → 'openai'
    const oldProvider = settings.provider === 'custom' ? 'openai' : (settings.provider || 'openai');

    const connPreset = {
      id: connId,
      name: 'Migrated Connection',
      provider: oldProvider,
      baseURL: settings.baseURL || 'https://openrouter.ai/api/v1',
      apiKey: settings.apiKey || '',
      selectedModel: settings.selectedModel || '',
      reasoning: { enabled: false, effort: 'medium' },
    };

    const promptPreset = {
      id: promptId,
      name: 'Migrated Prompts',
      stack,
      generationSettings: settings.generationSettings || {
        temperature: 0.85,
        top_p: 0.95,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        max_tokens: 1000,
      },
    };

    settings = {
      activeConnectionPresetId: connId,
      activePromptPresetId: promptId,
      activeCharacterId: settings.activeCharacterId ?? null,
      persona: settings.persona ?? { name: 'User', description: '' },
      personaAvatar: settings.personaAvatar ?? null,
      chatDisplayMode: settings.chatDisplayMode || 'bubble',
      dialogueColor: '#ef6b6b',
      connectionPresets: [connPreset],
      promptPresets: [promptPreset],
    };

    await writeJSON(FILE, settings);
  }

  // Migrate persona object → character card with type:'persona'
  settings = await migratePersonaIfNeeded(settings);
  return settings;
}

// GET /api/settings — returns settings with API keys masked
router.get('/', async (_req, res) => {
  try {
    let settings = await readJSON(FILE);
    settings = await migrateIfNeeded(settings);
    res.json(maskSettings({ ...SETTING_DEFAULTS, ...settings }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/settings — scalar fields only; ignores connectionPresets / promptPresets
router.put('/', async (req, res) => {
  try {
    const incoming = req.body;
    const result = await withLock(FILE, async (existing) => {
      existing = await migrateIfNeeded(existing);
      const updated = { ...existing };
      for (const f of SCALAR_FIELDS) {
        if (f in incoming) updated[f] = incoming[f];
      }
      return updated;
    });
    res.json(maskSettings(result));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/settings/active-connection — switch active connection preset
router.put('/active-connection', async (req, res) => {
  try {
    const { id } = req.body;
    await withLock(FILE, async (settings) => {
      settings = await migrateIfNeeded(settings);
      if (!settings.connectionPresets.find(p => p.id === id)) {
        const e = new Error('Connection preset not found'); e.status = 404; throw e;
      }
      settings.activeConnectionPresetId = id;
      return settings;
    });
    res.json({ activeId: id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/settings/active-prompt — switch active prompt preset
router.put('/active-prompt', async (req, res) => {
  try {
    const { id } = req.body;
    await withLock(FILE, async (settings) => {
      settings = await migrateIfNeeded(settings);
      if (!settings.promptPresets.find(p => p.id === id)) {
        const e = new Error('Prompt preset not found'); e.status = 404; throw e;
      }
      settings.activePromptPresetId = id;
      return settings;
    });
    res.json({ activeId: id });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/settings/avatar — upload persona avatar
router.post('/avatar', upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid image file' });
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const finalName = `persona${ext}`;
  const finalPath = path.join(AVATAR_DIR, finalName);

  try {
    const existing = await fs.readdir(AVATAR_DIR);
    await Promise.all(
      existing
        .filter(f => f.startsWith('persona.') && f !== finalName)
        .map(f => fs.unlink(path.join(AVATAR_DIR, f)).catch(() => {}))
    );
    await fs.rename(req.file.path, finalPath);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    let settings = await readJSON(FILE);
    settings.personaAvatar = `/avatars/${finalName}`;
    await writeJSON(FILE, settings);
    res.json({ avatar: settings.personaAvatar });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
