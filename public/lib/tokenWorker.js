// Classic Web Worker — loaded via new Worker('/lib/tokenWorker.js')
// importScripts paths are relative to THIS file's location (/lib/)
importScripts('./cl100k_base.js', './o200k_base.js');

self.onmessage = ({ data }) => {
  const { id, text, encoder } = data;
  try {
    const tok = encoder === 'o200k_base'
      ? GPTTokenizer_o200k_base
      : GPTTokenizer_cl100k_base;
    const count = tok.encode(text ?? '').length;
    self.postMessage({ id, count });
  } catch {
    // Fallback: rough 4-chars-per-token estimate
    self.postMessage({ id, count: Math.ceil((text ?? '').length / 4) });
  }
};
