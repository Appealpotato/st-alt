import { Router } from 'express';
import { readJSON, writeJSON, withLock, dataPath, safePath } from '../lib/fileStore.js';
import { requireString, requireEnum, requireArray } from '../lib/validate.js';
import { activeStreams } from '../lib/streamProxy.js';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import archiver from 'archiver';
import multer from 'multer';

const jsonlUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.originalname.toLowerCase().endsWith('.jsonl'));
  },
});

const router = Router();
const INDEX = dataPath('history', 'index.json');

function sessionFile(id) {
  return dataPath('history', `${safePath(id)}.json`);
}

function nowISO() {
  return new Date().toISOString();
}

function extractPreview(messages, maxLen = 120) {
  if (!messages || messages.length === 0) return null;
  const last = [...messages].reverse().find(m => m.role !== 'system');
  if (!last) return null;
  const text = (last.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLen ? text : text.slice(0, maxLen) + '…';
}

// GET /api/history — session list
router.get('/', async (_req, res) => {
  try {
    res.json(await readJSON(INDEX));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/history — create new session
router.post('/', async (req, res) => {
  try {
    requireString(req.body, 'title', { optional: true, maxLen: 500 });
    requireString(req.body, 'characterId', { optional: true, maxLen: 100 });
    requireString(req.body, 'characterName', { optional: true, maxLen: 200 });
    requireString(req.body, 'personaId', { optional: true, maxLen: 100 });

    const id = 'ses_' + Date.now() + '_' + randomUUID().slice(0, 4);
    const now = nowISO();
    const meta = {
      id,
      title:              req.body.title         ?? 'New Chat',
      characterId:        req.body.characterId   ?? null,
      characterName:      req.body.characterName ?? null,
      personaId:          req.body.personaId     ?? null,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessagePreview: null,
    };
    const session = { ...meta, messages: [] };
    await writeJSON(sessionFile(id), session);
    await withLock(INDEX, (index) => {
      index.sessions.unshift(meta);
      return index;
    });
    res.status(201).json(meta);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── JSONL export helpers ─────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const safeName = (s) => s.replace(/[\/\\:*?"<>|]/g, '_');

function formatDateStamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}@${pad2(d.getHours())}h${pad2(d.getMinutes())}m${pad2(d.getSeconds())}s`;
}

async function resolveNames(session) {
  let charName = session.characterName || 'Character';
  try {
    if (session.characterId) {
      const card = await readJSON(dataPath('characters', `${safePath(session.characterId)}.json`));
      charName = card.name || charName;
    }
  } catch { /* card deleted, use session name */ }

  let userName = 'User';
  try {
    if (session.personaId) {
      const persona = await readJSON(dataPath('characters', `${safePath(session.personaId)}.json`));
      userName = persona.name || userName;
    }
  } catch { /* persona deleted */ }

  return { charName, userName };
}

function sessionToJSONL(session, charName, userName) {
  const lines = [JSON.stringify({
    user_name: userName,
    character_name: charName,
    create_date: session.createdAt,
    chat_metadata: {},
  })];

  for (const msg of session.messages) {
    const stMsg = {
      name: msg.role === 'user' ? userName : msg.role === 'assistant' ? charName : 'System',
      is_user: msg.role === 'user',
      is_system: msg.role === 'system',
      is_name: true,
      send_date: msg.timestamp,
      mes: msg.content,
    };
    if (msg.swipes) {
      stMsg.swipes = msg.swipes;
      stMsg.swipe_id = msg.swipeIndex ?? 0;
      stMsg.swipe_info = msg.swipes.map(() => ({ send_date: msg.timestamp, extra: {} }));
    }
    if (msg.role === 'assistant' && msg.metadata?.model) {
      stMsg.extra = { model: msg.metadata.model };
    }
    lines.push(JSON.stringify(stMsg));
  }

  return lines.join('\n');
}

function jsonlFilename(charName, createdAt) {
  return `${safeName(charName)} - ${formatDateStamp(createdAt)}.jsonl`;
}

// GET /api/history/search?q=term — search messages across all sessions
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) return res.json({ results: [] });

  try {
    const index = await readJSON(INDEX);
    const results = [];

    for (const meta of index.sessions) {
      if (results.length >= 20) break;
      try {
        const session = await readJSON(sessionFile(meta.id));
        for (let i = 0; i < session.messages.length; i++) {
          if (results.length >= 20) break;
          const content = (session.messages[i].content || '').toLowerCase();
          const idx = content.indexOf(q);
          if (idx === -1) continue;
          const start = Math.max(0, idx - 40);
          const end = Math.min(content.length, idx + q.length + 60);
          results.push({
            sessionId: meta.id,
            sessionTitle: meta.title,
            characterName: meta.characterName,
            messageId: session.messages[i].id,
            role: session.messages[i].role,
            preview: (start > 0 ? '…' : '') +
              session.messages[i].content.slice(start, end) +
              (end < content.length ? '…' : ''),
            historyIndex: i,
          });
        }
      } catch { /* unreadable session, skip */ }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/history/import-jsonl — import a SillyTavern-compatible JSONL chat
const CHAR_INDEX = dataPath('characters', 'index.json');

router.post('/import-jsonl', jsonlUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No .jsonl file provided' });

    const lines = req.file.buffer.toString('utf-8').split('\n').filter(l => l.trim());
    if (lines.length < 1) return res.status(400).json({ error: 'Empty file' });

    const meta = JSON.parse(lines[0]);
    const charName = meta.character_name || 'Character';
    const userName = meta.user_name || 'User';

    // Try to match an existing character by name
    let matchedCharId = null;
    try {
      const charIndex = await readJSON(CHAR_INDEX);
      const match = charIndex.characters.find(c =>
        c.name?.toLowerCase() === charName.toLowerCase() && c.type !== 'persona');
      if (match) matchedCharId = match.id;
    } catch { /* no character index */ }

    const messages = [];
    for (let i = 1; i < lines.length; i++) {
      const st = JSON.parse(lines[i]);
      const msg = {
        id: 'msg_' + randomUUID().slice(0, 8),
        role: st.is_user ? 'user' : st.is_system ? 'system' : 'assistant',
        content: st.mes || '',
        timestamp: st.send_date || nowISO(),
      };
      if (st.swipes?.length > 0) {
        msg.swipes = st.swipes;
        msg.swipeIndex = st.swipe_id ?? 0;
        msg.content = msg.swipes[msg.swipeIndex] ?? msg.content;
      }
      if (!st.is_user && st.extra?.model) {
        msg.metadata = { model: st.extra.model, usage: {}, duration: 0, toolCalls: [] };
      }
      messages.push(msg);
    }

    const id = 'ses_' + Date.now() + '_' + randomUUID().slice(0, 4);
    const now = nowISO();
    const title = charName + ' - Imported';
    const session = {
      id, title,
      characterId: matchedCharId,
      characterName: charName,
      personaId: null,
      createdAt: meta.create_date || now,
      updatedAt: now,
      messages,
    };

    await writeJSON(sessionFile(id), session);
    await withLock(INDEX, (index) => {
      index.sessions.unshift({
        id, title,
        characterId: matchedCharId,
        characterName: charName,
        personaId: null,
        createdAt: session.createdAt,
        updatedAt: now,
        messageCount: messages.length,
        lastMessagePreview: extractPreview(messages),
      });
      return index;
    });

    res.status(201).json({ id, title, messageCount: messages.length, characterMatched: !!matchedCharId });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid JSONL' });
  }
});

// GET /api/history/export-character/:charId — zip of all JSONL chats for a character
router.get('/export-character/:charId', async (req, res) => {
  try {
    const index = await readJSON(INDEX);
    const charSessions = index.sessions.filter(s => s.characterId === req.params.charId);
    if (charSessions.length === 0) return res.status(404).json({ error: 'No chats found' });

    // Read all sessions in parallel
    const sessions = await Promise.all(
      charSessions.map(s => readJSON(sessionFile(s.id)).catch(() => null))
    );
    const valid = sessions.filter(Boolean);
    if (valid.length === 0) return res.status(404).json({ error: 'No chats found' });

    const { charName } = await resolveNames(valid[0]);
    const zipName = `${safeName(charName)} - all chats.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const session of valid) {
      const { charName: cn, userName } = await resolveNames(session);
      const filename = jsonlFilename(cn, session.createdAt);
      archive.append(sessionToJSONL(session, cn, userName), { name: filename });
    }

    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/history/:id/export-jsonl — SillyTavern-compatible JSONL download
router.get('/:id/export-jsonl', async (req, res) => {
  try {
    const session = await readJSON(sessionFile(req.params.id));
    const { charName, userName } = await resolveNames(session);
    const filename = jsonlFilename(charName, session.createdAt);

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(sessionToJSONL(session, charName, userName));
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// GET /api/history/:id — full session with messages
router.get('/:id', async (req, res) => {
  try {
    res.json(await readJSON(sessionFile(req.params.id)));
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// PATCH /api/history/:id — update title and/or personaId
router.patch('/:id', async (req, res) => {
  try {
    requireString(req.body, 'title', { optional: true, maxLen: 500 });
    if (req.body.personaId != null) requireString(req.body, 'personaId', { optional: true, maxLen: 100 });
    const session = await readJSON(sessionFile(req.params.id));
    const updates = { title: req.body.title ?? session.title, updatedAt: nowISO() };
    if ('personaId' in req.body) updates.personaId = req.body.personaId ?? null;
    Object.assign(session, updates);
    await writeJSON(sessionFile(req.params.id), session);
    await withLock(INDEX, (index) => {
      const meta = index.sessions.find(s => s.id === req.params.id);
      if (meta) Object.assign(meta, updates);
      return index;
    });
    res.json({ id: req.params.id, ...updates });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// DELETE /api/history/:id
router.delete('/:id', async (req, res) => {
  try {
    // Abort any active stream for this session
    const stream = activeStreams.get(req.params.id);
    if (stream) {
      stream.controller?.abort();
      activeStreams.delete(req.params.id);
    }

    await withLock(INDEX, (index) => {
      index.sessions = index.sessions.filter(s => s.id !== req.params.id);
      return index;
    });
    await fs.unlink(sessionFile(req.params.id)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/history/:id/messages — replace entire messages array (used by regen/truncate)
router.put('/:id/messages', async (req, res) => {
  try {
    requireArray(req.body, 'messages');

    const session = await readJSON(sessionFile(req.params.id));
    session.messages = req.body.messages;
    session.updatedAt = nowISO();
    await writeJSON(sessionFile(req.params.id), session);
    await withLock(INDEX, (index) => {
      const meta = index.sessions.find(s => s.id === req.params.id);
      if (meta) {
        meta.messageCount = session.messages.length;
        meta.updatedAt = session.updatedAt;
        meta.lastMessagePreview = extractPreview(session.messages);
      }
      return index;
    });
    res.json({ ok: true, messageCount: session.messages.length });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/history/:id/messages — append a message
router.post('/:id/messages', async (req, res) => {
  try {
    requireEnum(req.body, 'role', ['user', 'assistant', 'system']);
    requireString(req.body, 'content');

    const sFile = sessionFile(req.params.id);
    const session = await readJSON(sFile);
    const msg = {
      id: 'msg_' + randomUUID().slice(0, 8),
      role: req.body.role,
      content: req.body.content,
      timestamp: nowISO(),
      ...(req.body.role === 'assistant' ? {
        metadata: {
          model: req.body.model ?? '',
          usage: req.body.usage ?? {},
          duration: req.body.duration ?? 0,
          toolCalls: [],
        },
      } : {}),
    };
    session.messages.push(msg);
    session.updatedAt = nowISO();
    await writeJSON(sFile, session);

    await withLock(INDEX, (index) => {
      const meta = index.sessions.find(s => s.id === req.params.id);
      if (meta) {
        meta.messageCount = session.messages.length;
        meta.updatedAt = session.updatedAt;
        meta.lastMessagePreview = extractPreview(session.messages);
      }
      return index;
    });

    res.status(201).json(msg);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
