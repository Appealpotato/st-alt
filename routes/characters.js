import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath, safePath, createCharacterCard, updateCharacterIndex } from '../lib/fileStore.js';
import { requireString, requireEnum, requireArray } from '../lib/validate.js';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import pngText from 'png-chunk-text';

const AVATAR_DIR = dataPath('avatars');
const ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const upload = multer({
  dest: AVATAR_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_EXTS.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, path.extname(file.originalname).toLowerCase() === '.png');
  },
});

const router = Router();
const INDEX = dataPath('characters', 'index.json');

function charFile(id) {
  return dataPath('characters', `${safePath(id)}.json`);
}

// GET /api/characters
router.get('/', async (_req, res) => {
  try {
    const index = await readJSON(INDEX);
    // Heal any index entries missing avatar/type/creatorNotes (created before the richer schema)
    let dirty = false;
    for (const entry of index.characters) {
      if (entry.avatar === undefined || entry.type === undefined || entry.creatorNotes === undefined) {
        try {
          const card = await readJSON(charFile(entry.id));
          entry.type         = card.type         ?? 'character';
          entry.avatar       = card.avatar       ?? null;
          entry.creatorNotes = (card.creatorNotes ?? '').slice(0, 120);
          delete entry.description;
          dirty = true;
        } catch { /* card file missing — leave as-is */ }
      }
    }
    if (dirty) await writeJSON(INDEX, index);
    res.json(index);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/characters
router.post('/', async (req, res) => {
  try {
    const b = req.body;
    requireEnum(b, 'type', ['character', 'persona'], { optional: true });
    requireString(b, 'name', { optional: true, maxLen: 200 });
    for (const f of ['description', 'personality', 'scenario', 'firstMessage', 'mesExample', 'creatorNotes']) {
      requireString(b, f, { optional: true, maxLen: 50000 });
    }
    if (b.tags !== undefined) requireArray(b, 'tags', { maxLen: 100 });

    const id = 'char_' + randomUUID().slice(0, 8);
    const char = {
      id,
      type:         b.type         ?? 'character',
      name:         b.name         ?? 'New Character',
      description:  b.description  ?? '',
      personality:  b.personality  ?? '',
      scenario:     b.scenario     ?? '',
      firstMessage: b.firstMessage ?? '',
      mesExample:   b.mesExample   ?? '',
      creatorNotes: b.creatorNotes ?? '',
      tags:         b.tags         ?? [],
      avatar:       b.avatar       ?? null,
    };
    await createCharacterCard(char);
    res.status(201).json(char);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/characters/import — must be before /:id routes
router.post('/import', importUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PNG file provided' });

  try {
    const buffer = req.file.buffer;

    // Extract tEXt chunks and find the 'chara' keyword
    let chunks;
    try { chunks = extractChunks(buffer); }
    catch { return res.status(400).json({ error: 'Malformed PNG file' }); }
    const textChunks = chunks
      .filter(c => c.name === 'tEXt')
      .map(c => { try { return pngText.decode(c.data); } catch { return null; } })
      .filter(Boolean);

    const charaChunk = textChunks.find(c => c.keyword === 'chara');
    if (!charaChunk) {
      return res.status(400).json({ error: 'No chara metadata found in this PNG' });
    }

    // Decode base64 → JSON
    const raw = JSON.parse(Buffer.from(charaChunk.text, 'base64').toString('utf-8'));

    // Support v1 (flat) and v2 (nested under .data)
    const data = (raw.spec === 'chara_card_v2' && raw.data) ? raw.data : raw;

    const id = 'char_' + randomUUID().slice(0, 8);

    // Save the original PNG as the avatar
    const avatarName = `${id}.png`;
    const avatarPath = path.join(AVATAR_DIR, avatarName);
    await fs.writeFile(avatarPath, buffer);

    const char = {
      id,
      type:         'character',
      name:         data.name          ?? 'Imported Character',
      description:  data.description   ?? '',
      personality:  data.personality   ?? '',
      scenario:     data.scenario      ?? '',
      firstMessage: data.first_mes     ?? '',
      mesExample:   data.mes_example   ?? '',
      creatorNotes: data.creator_notes ?? '',
      tags:         Array.isArray(data.tags) ? data.tags : [],
      avatar:       `/avatars/${avatarName}`,
    };

    await createCharacterCard(char);
    res.status(201).json(char);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Minimal 1×1 transparent PNG (RGBA) — used when character has no avatar
const BLANK_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
  '0000000b4944415478da636000020000050001e9fadcd80000000049454e44ae426082',
  'hex'
);

// GET /api/characters/:id/export-png
router.get('/:id/export-png', async (req, res) => {
  try {
    const char = await readJSON(charFile(req.params.id));

    // Build SillyTavern v2 card
    const cardData = {
      name:          char.name          ?? '',
      description:   char.description   ?? '',
      personality:   char.personality   ?? '',
      scenario:      char.scenario      ?? '',
      first_mes:     char.firstMessage  ?? '',
      mes_example:   char.mesExample    ?? '',
      creator_notes: char.creatorNotes  ?? '',
      tags:          Array.isArray(char.tags) ? char.tags : [],
    };
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: cardData };
    const charaB64 = Buffer.from(JSON.stringify(card), 'utf-8').toString('base64');

    // Load avatar PNG if available, otherwise use blank
    let pngBuffer = BLANK_PNG;
    if (char.avatar) {
      const avatarFile = path.join(AVATAR_DIR, path.basename(char.avatar));
      try { pngBuffer = await fs.readFile(avatarFile); } catch { /* fall back to blank */ }
    }

    // Inject chara tEXt chunk (replace any existing one)
    const chunks = extractChunks(pngBuffer);
    const filtered = chunks.filter(c => {
      if (c.name !== 'tEXt') return true;
      try { return pngText.decode(c.data).keyword !== 'chara'; } catch { return true; }
    });
    const charaChunk = pngText.encode('chara', charaB64);
    // Insert before IEND
    const iend = filtered.findIndex(c => c.name === 'IEND');
    filtered.splice(iend, 0, charaChunk);

    const outBuffer = Buffer.from(encodeChunks(filtered));
    const safeName = (char.name || char.id).replace(/[^a-z0-9_\-. ]/gi, '_');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.png"`);
    res.send(outBuffer);
  } catch (err) {
    res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: err.message });
  }
});

// GET /api/characters/:id
router.get('/:id', async (req, res) => {
  try {
    res.json(await readJSON(charFile(req.params.id)));
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// PUT /api/characters/:id
router.put('/:id', async (req, res) => {
  try {
    const existing = await readJSON(charFile(req.params.id));
    const updated = { ...existing, ...req.body, id: req.params.id };
    await writeJSON(charFile(req.params.id), updated);
    await updateCharacterIndex(updated);
    res.json(updated);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// DELETE /api/characters/:id
router.delete('/:id', async (req, res) => {
  try {
    await withLock(INDEX, (index) => {
      index.characters = index.characters.filter(c => c.id !== req.params.id);
      return index;
    });
    await fs.unlink(charFile(req.params.id)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/characters/:id/avatar
router.post('/:id/avatar', upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No valid image file' });
  const id  = req.params.id;
  const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
  const finalName = `${id}${ext}`;
  const finalPath = path.join(AVATAR_DIR, finalName);

  try {
    // Remove any previous avatar files for this character
    const existing = await fs.readdir(AVATAR_DIR);
    await Promise.all(
      existing
        .filter(f => f.startsWith(`${id}.`) && f !== finalName)
        .map(f => fs.unlink(path.join(AVATAR_DIR, f)).catch(() => {}))
    );
    // Rename multer's temp file to the final name
    await fs.rename(req.file.path, finalPath);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  try {
    const char = await readJSON(charFile(id));
    char.avatar = `/avatars/${finalName}`;
    await writeJSON(charFile(id), char);
    await updateCharacterIndex(char);
    res.json({ avatar: char.avatar });
  } catch {
    res.status(404).json({ error: 'Character not found' });
  }
});

export default router;
