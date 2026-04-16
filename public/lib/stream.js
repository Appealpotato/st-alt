/**
 * stream.js — fetch()-based SSE client for streaming completions.
 * EventSource is GET-only, so we use fetch() with a ReadableStream response.
 */

// Abort the reader if no bytes arrive for this long. iOS Safari can silently
// pause the stream when the tab is backgrounded; this turns that into an
// explicit error the caller can recover from (stalled flag → reconnect).
const STALL_MS = 30000;

/**
 * @param {Array} messages       - assembled messages array
 * @param {string} sessionId     - active session ID
 * @param {Function} onToken     - called with each string token
 * @param {Function} onDone      - called with { usage } when stream ends
 * @param {Function} onError     - called with { message, stalled? } on failure
 * @param {boolean}  reconnect   - if true, GET /api/chat/stream/:sessionId
 * @param {Function} [onWarning] - optional; called with server-emitted warning events
 * @returns {Function}           - abort() function to cancel the stream
 */
export function streamCompletion(messages, sessionId, onToken, onDone, onError, reconnect = false, onWarning = null) {
  const controller = new AbortController();
  let watchdog = null;
  let stalled = false;

  function resetWatchdog() {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      try { controller.abort(); } catch { /* already aborted */ }
    }, STALL_MS);
  }

  function clearWatchdog() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
  }

  (async () => {
    let res;
    try {
      resetWatchdog();
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
      clearWatchdog();
      if (stalled) { onError({ message: 'stream stalled', stalled: true }); return; }
      if (err.name === 'AbortError') { onDone({ aborted: true }); }
      else { onError({ message: err.message }); }
      return;
    }

    if (!res.ok) {
      clearWatchdog();
      const data = await res.json().catch(() => ({}));
      onError({ message: data.error ?? res.statusText });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetWatchdog();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          if (event.type === 'token')   onToken(event.content);
          if (event.type === 'warning') { if (onWarning) onWarning(event); else console.warn('[stream] warning:', event.message); }
          if (event.type === 'done')    { clearWatchdog(); onDone(event); return; }
          if (event.type === 'error')   { clearWatchdog(); onError({ message: event.message }); return; }
        }
      }
      clearWatchdog();
    } catch (err) {
      clearWatchdog();
      if (stalled) { onError({ message: 'stream stalled', stalled: true }); return; }
      if (err.name === 'AbortError') { onDone({ aborted: true }); }
      else { onError({ message: err.message }); }
    }
  })();

  return () => { clearWatchdog(); controller.abort(); };
}
