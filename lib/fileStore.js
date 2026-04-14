import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

// Default file contents written on first run
const DEFAULTS = {
  'settings.json': {
    activeConnectionPresetId: 'conn_default',
    activePromptPresetId: 'prompt_default',
    activeCharacterId: null,
    activePersonaId: null,
    avatarShape: 'circle',
    charBrowserView: 'grid',
    chatDisplayMode: 'bubble',
    dialogueColor: '#ef6b6b',
    connectionPresets: [
      {
        id: 'conn_default',
        name: 'Default Connection',
        provider: 'openai',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: '',
        selectedModel: '',
        reasoning: { enabled: false, effort: 'medium' },
      },
    ],
    promptPresets: [
      {
        id: 'prompt_default',
        name: 'Default Prompts',
        stack: [
          {
            id: 'entry_system',
            type: 'system',
            label: 'Main System Prompt',
            content: 'You are a creative writing assistant for collaborative fiction.',
            enabled: true,
            role: 'system',
            injection_depth: 0,
          },
          {
            id: 'entry_character',
            type: 'character',
            label: 'Character Card',
            content: null,
            enabled: true,
            role: 'system',
            injection_depth: 0,
          },
          {
            id: 'entry_chathistory',
            type: 'chatHistory',
            label: 'Chat History',
            content: null,
            enabled: true,
            role: null,
            injection_depth: 0,
          },
        ],
        generationSettings: {
          temperature: 0.85,
          top_p: 0.95,
          frequency_penalty: 0.0,
          presence_penalty: 0.0,
          max_tokens: 1000,
        },
      },
    ],
  },
  'prompts.json': {
    entries: [
      {
        id: 'entry_system',
        type: 'system',
        label: 'Main System Prompt',
        content: 'You are a creative writing assistant for collaborative fiction.',
        enabled: true,
        role: 'system',
        injection_depth: 0,
      },
      {
        id: 'entry_character',
        type: 'character',
        label: 'Character Card',
        content: null,
        enabled: true,
        role: 'system',
        injection_depth: 0,
      },
      {
        id: 'entry_chathistory',
        type: 'chatHistory',
        label: 'Chat History',
        content: null,
        enabled: true,
        role: null,
        injection_depth: 0,
      },
    ],
  },
  'characters/index.json': {
    characters: [],
  },
  'history/index.json': {
    sessions: [],
  },
};

export async function ensureDataFiles() {
  await fs.mkdir(path.join(DATA_DIR, 'history'),     { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'characters'),  { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'avatars'),     { recursive: true });
  for (const [file, defaultContent] of Object.entries(DEFAULTS)) {
    const filePath = path.join(DATA_DIR, file);
    try {
      await fs.access(filePath);
    } catch {
      await writeJSON(filePath, defaultContent);
    }
  }
}

export function dataPath(...segments) {
  return path.join(DATA_DIR, ...segments);
}

// Validate that an ID is safe to use in a file path (no traversal, no special chars)
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
export function safePath(id) {
  if (!id || typeof id !== 'string' || !SAFE_ID.test(id)) {
    const err = new Error('Invalid ID');
    err.status = 400;
    throw err;
  }
  return id;
}

export async function readJSON(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

// Per-file write queue — prevents concurrent read-modify-write corruption
const _writeQueues = new Map();
function enqueue(filePath, fn) {
  const prev = _writeQueues.get(filePath) ?? Promise.resolve();
  // Run fn after prev settles regardless of outcome; propagate fn's result to caller
  const next = prev.then(() => fn(), () => fn());
  _writeQueues.set(filePath, next.catch(() => {})); // keep queue advancing even if fn throws
  return next;
}

// Atomic write: write to a temp file then rename, serialised per file path
export function writeJSON(filePath, data) {
  return enqueue(filePath, async () => {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, filePath);
  });
}

// Serialize an entire read-modify-write cycle on a file.
// `fn` receives the parsed JSON and must return the updated object to write back.
// Multiple files can be locked together by passing an array of paths.
export function withLock(filePaths, fn) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  // Chain through all file queues so we hold all locks simultaneously
  const run = async () => {
    const data = await Promise.all(paths.map(p => readJSON(p)));
    const result = await fn(...data);
    // fn returns [updated1, updated2, ...] for multi-file, or a single object
    const updates = Array.isArray(filePaths) ? result : [result];
    await Promise.all(paths.map((p, i) => {
      if (updates[i] !== undefined) {
        const tmp = p + '.tmp';
        return fs.writeFile(tmp, JSON.stringify(updates[i], null, 2), 'utf8')
          .then(() => fs.rename(tmp, p));
      }
    }));
    return result;
  };
  // Enqueue through all file paths so we hold each file's lock
  let chained = run;
  for (const p of paths) {
    const inner = chained;
    chained = () => enqueue(p, inner);
  }
  return chained();
}

// Summary stored in the index per character (for browser display without full fetches)
function charIndexEntry(card) {
  return {
    id:           card.id,
    name:         card.name,
    type:         card.type   ?? 'character',
    avatar:       card.avatar ?? null,
    creatorNotes: (card.creatorNotes ?? '').slice(0, 120),
  };
}

// Create a new character card file and append it to characters/index.json
export async function createCharacterCard(card) {
  const cardPath  = dataPath('characters', `${card.id}.json`);
  const indexPath = dataPath('characters', 'index.json');
  // Write card file outside the index lock (it's a new file, no contention)
  await writeJSON(cardPath, card);
  // Lock the index for the read-modify-write
  return withLock(indexPath, (index) => {
    index.characters.push(charIndexEntry(card));
    return index;
  });
}

// Update the index entry for a character (called after PUT saves full card)
export async function updateCharacterIndex(card) {
  const indexPath = dataPath('characters', 'index.json');
  return withLock(indexPath, (index) => {
    const i = index.characters.findIndex(c => c.id === card.id);
    if (i >= 0) index.characters[i] = charIndexEntry(card);
    return index;
  });
}
