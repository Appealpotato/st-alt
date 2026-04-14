/**
 * Thin main-thread wrapper around tokenWorker.js.
 * Worker is created lazily on first countTokens() call.
 */

let _worker = null;
const _pending = new Map(); // id → resolve
let _nextId = 0;

function getWorker() {
  if (!_worker) {
    _worker = new Worker('/lib/tokenWorker.js');
    _worker.onmessage = ({ data }) => {
      const resolve = _pending.get(data.id);
      if (resolve) { resolve(data.count ?? 0); _pending.delete(data.id); }
    };
    _worker.onerror = e => console.error('[tokenizer] worker error:', e.message);
  }
  return _worker;
}

/**
 * Count tokens in text. Returns Promise<number>.
 * encoder: 'cl100k_base' | 'o200k_base'
 */
export function countTokens(text, encoder = 'cl100k_base') {
  return new Promise(resolve => {
    const id = ++_nextId;
    _pending.set(id, resolve);
    getWorker().postMessage({ id, text: text ?? '', encoder });
  });
}

const _CACHE_PFX = 'char_tok:';

/** Persist a token count for a character/persona by ID. */
export function setCachedTokens(id, count) {
  try { localStorage.setItem(_CACHE_PFX + id, String(count)); } catch {}
}

/** Read a cached token count. Returns number or null if not cached. */
export function getCachedTokens(id) {
  const v = localStorage.getItem(_CACHE_PFX + id);
  return v !== null ? parseInt(v, 10) : null;
}

/**
 * Pick the best encoder for the active connection preset.
 * GPT-4o / o1 / o3 / DeepSeek → o200k_base
 * Everything else              → cl100k_base
 */
export function pickEncoder(State) {
  const presets  = State?.settings?.connectionPresets ?? [];
  const activeId = State?.settings?.activeConnectionPresetId;
  const preset   = presets.find(p => p.id === activeId);
  const sig = ((preset?.model ?? '') + ' ' + (preset?.provider ?? '')).toLowerCase();
  return /gpt-4o|gpt-4\.1|o1[-_\s]|o3[-_\s]|deepseek/.test(sig) ? 'o200k_base' : 'cl100k_base';
}
