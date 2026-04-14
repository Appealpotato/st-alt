/**
 * stream.js — fetch()-based SSE client for streaming completions.
 * EventSource is GET-only, so we use fetch() with a ReadableStream response.
 */

/**
 * @param {Array} messages       - assembled messages array
 * @param {string} sessionId     - active session ID
 * @param {Function} onToken     - called with each string token
 * @param {Function} onDone      - called with { usage } when stream ends
 * @param {Function} onError     - called with error message string
 * @returns {Function}           - abort() function to cancel the stream
 */
export function streamCompletion(messages, sessionId, onToken, onDone, onError, reconnect = false) {
  const controller = new AbortController();

  (async () => {
    let res;
    try {
      if (reconnect) {
        res = await fetch(`/api/chat/stream/${sessionId}`, { signal: controller.signal });
      } else {
        res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, sessionId }),
          signal: controller.signal,
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') { onDone({ aborted: true }); }
      else { onError(err.message); }
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      onError(data.error ?? res.statusText);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === 'token') onToken(event.content);
          if (event.type === 'done')  { onDone(event); return; }
          if (event.type === 'error') { onError(event.message); return; }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') { onDone({ aborted: true }); }
      else { onError(err.message); }
    }
  })();

  return () => controller.abort();
}
