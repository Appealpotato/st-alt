import { randomUUID } from 'crypto';
import toolHooks from './toolHooks.js';
import { readJSON, writeJSON, dataPath } from './fileStore.js';

/**
 * Proxy a streaming chat completion from the provider to the Express response.
 * Normalizes provider SSE format into: {"type":"token","content":"..."}
 * and {"type":"done","usage":{...}}
 *
 * Handles reasoning content from OpenRouter (delta.reasoning_content / delta.reasoning)
 * by wrapping it in <think> tags so the existing frontend parser handles it uniformly.
 *
 * The full assistant message is saved server-side when [DONE] arrives, so the response
 * is persisted even if the client disconnects mid-stream.
 */

// Active streams: sessionId → { buffer: string[], listeners: Set<res>, controller: AbortController }
export const activeStreams = new Map();

// Write to client without throwing if the socket is already closed
function safeWrite(res, data) {
  if (res.writableEnded) return;
  try { res.write(data); } catch { /* EPIPE — client disconnected, carry on */ }
}

// Broadcast to all attached listeners and append to buffer
function broadcast(entry, data) {
  entry.buffer.push(data);
  for (const r of entry.listeners) {
    if (r.writableEnded) { entry.listeners.delete(r); continue; }
    safeWrite(r, data);
  }
}

async function persistAssistantMessage(sessionId, content, model, usage, duration) {
  const sessionPath = dataPath('history', `${sessionId}.json`);
  const session     = await readJSON(sessionPath);
  const msg = {
    id:        'msg_' + randomUUID().slice(0, 8),
    role:      'assistant',
    content,
    timestamp: new Date().toISOString(),
    metadata: {
      model,
      usage:     usage    ?? {},
      duration:  duration ?? 0,
      toolCalls: [],
    },
  };
  session.messages.push(msg);
  session.updatedAt = new Date().toISOString();
  await writeJSON(sessionPath, session);

  const { withLock } = await import('./fileStore.js');
  const indexPath = dataPath('history', 'index.json');
  await withLock(indexPath, (index) => {
    const meta = index.sessions.find(s => s.id === sessionId);
    if (meta) {
      meta.messageCount = session.messages.length;
      meta.updatedAt    = session.updatedAt;
    }
    return index;
  });
}

export async function proxyStream(providerRes, clientRes, context = {}) {
  clientRes.setHeader('Content-Type', 'text/event-stream');
  clientRes.setHeader('Cache-Control', 'no-cache');
  clientRes.setHeader('Connection', 'keep-alive');
  clientRes.flushHeaders();

  const sessionId = context.sessionId;
  const entry = sessionId
    ? { buffer: [], listeners: new Set([clientRes]), controller: context.controller ?? null }
    : null;
  if (sessionId) activeStreams.set(sessionId, entry);

  // Phase 2 stub
  toolHooks.onStreamStart(context);

  const reader = providerRes.body;
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulated = '';
  let usage = null;
  let inReasoningBlock = false;
  let hadReasoningBlock = false;
  const startTime = Date.now();
  let responseModel = context.model ?? '';

  const provider = context.provider ?? 'openai';

  function emit(token) {
    accumulated += token;
    toolHooks.onToken(token, context);
    const data = `data: ${JSON.stringify({ type: 'token', content: token })}\n\n`;
    if (entry) broadcast(entry, data); else safeWrite(clientRes, data);
  }

  async function finalize() {
    if (inReasoningBlock) { emit('</think>'); inReasoningBlock = false; }
    await toolHooks.onStreamEnd(accumulated, context);
    const duration = Date.now() - startTime;

    if (context.sessionId && accumulated.trim()) {
      try {
        await persistAssistantMessage(context.sessionId, accumulated, responseModel, usage, duration);
      } catch (persistErr) {
        console.error('[streamProxy] PERSIST FAILED for session', context.sessionId, ':', persistErr.message);
        const warnData = `data: ${JSON.stringify({ type: 'warning', message: 'Message may not have been saved' })}\n\n`;
        if (entry) broadcast(entry, warnData); else safeWrite(clientRes, warnData);
      }
    }

    console.log('\n─── RESPONSE ──────────────────────────────────────────');
    if (usage) console.log(`Tokens:     ${usage.prompt_tokens ?? '?'} prompt / ${usage.completion_tokens ?? '?'} completion`);
    console.log(`Reasoning:  ${hadReasoningBlock ? 'yes (detected <think> block)' : 'no'}`);
    console.log(`Time:       ${(duration / 1000).toFixed(1)}s`);
    console.log('───────────────────────────────────────────────────────\n');

    const doneData = `data: ${JSON.stringify({ type: 'done', usage, duration, model: responseModel })}\n\n`;
    if (entry) {
      broadcast(entry, doneData);
      activeStreams.delete(sessionId);
      for (const r of entry.listeners) { if (!r.writableEnded) r.end(); }
    } else {
      safeWrite(clientRes, doneData);
      if (!clientRes.writableEnded) clientRes.end();
    }
  }

  try {
    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();

        // ── Anthropic Messages SSE format ──────────────────────────────────
        if (provider === 'anthropic') {
          let parsed;
          try { parsed = JSON.parse(raw); } catch { continue; }

          if (parsed.type === 'message_start') {
            if (parsed.message?.model) responseModel = parsed.message.model;
            if (parsed.message?.usage) usage = { prompt_tokens: parsed.message.usage.input_tokens };
          } else if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
            emit('<think>');
            inReasoningBlock = true;
            hadReasoningBlock = true;
          } else if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'thinking_delta') {
              emit(parsed.delta.thinking);
            } else if (parsed.delta?.type === 'text_delta') {
              emit(parsed.delta.text);
            }
          } else if (parsed.type === 'content_block_stop' && inReasoningBlock) {
            emit('</think>');
            inReasoningBlock = false;
          } else if (parsed.type === 'message_delta') {
            if (parsed.usage) usage = { ...usage, completion_tokens: parsed.usage.output_tokens };
          } else if (parsed.type === 'message_stop') {
            await finalize();
            return;
          }
          continue;
        }

        // ── OpenAI / OpenRouter SSE format ─────────────────────────────────
        if (raw === '[DONE]') { await finalize(); return; }

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (parsed.usage) usage = parsed.usage;
        if (parsed.model) responseModel = parsed.model;

        const delta = parsed.choices?.[0]?.delta ?? {};

        if (delta.reasoning_content || delta.reasoning) {
          if (!inReasoningBlock) {
            emit('<think>');
            inReasoningBlock = true;
            hadReasoningBlock = true;
          }
          emit(delta.reasoning_content || delta.reasoning);
        }

        if (delta.content) {
          if (inReasoningBlock) {
            emit('</think>');
            inReasoningBlock = false;
          }
          emit(delta.content);
        }
      }
    }
  } catch (err) {
    if (sessionId) activeStreams.delete(sessionId);
    if (err.name !== 'AbortError') {
      const errData = `data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`;
      if (entry) {
        broadcast(entry, errData);
        for (const r of entry.listeners) { if (!r.writableEnded) r.end(); }
      } else {
        safeWrite(clientRes, errData);
        if (!clientRes.writableEnded) clientRes.end();
      }
    } else {
      if (entry) for (const r of entry.listeners) { if (!r.writableEnded) r.end(); }
      else if (!clientRes.writableEnded) clientRes.end();
    }
  }
}

/**
 * Perform a non-streaming chat completion and return the full text.
 * Used internally (e.g. Phase 2 sidecar calls).
 */
export async function fetchCompletion(messages, settings) {
  const conn = settings.connectionPresets?.find(p => p.id === settings.activeConnectionPresetId);
  if (!conn) throw new Error('No active connection preset');

  if (conn.provider === 'anthropic') {
    // Extract system messages for Anthropic top-level system field
    const systemParts = [];
    const nonSystem = [];
    for (const m of messages) {
      if (m.role === 'system') systemParts.push(m.content);
      else nonSystem.push({ role: m.role, content: m.content });
    }
    const merged = [];
    for (const m of nonSystem) {
      if (merged.length && merged[merged.length - 1].role === m.role) {
        merged[merged.length - 1].content += '\n\n' + m.content;
      } else merged.push({ ...m });
    }
    if (merged.length && merged[0].role !== 'user') merged.unshift({ role: 'user', content: '[Start]' });

    const body = { model: conn.selectedModel, messages: merged, max_tokens: 1000, stream: false };
    if (systemParts.length) body.system = [{ type: 'text', text: systemParts.join('\n\n') }];

    const res = await fetch(conn.baseURL.replace(/\/$/, '') + '/messages', {
      method: 'POST',
      headers: { 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Provider error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.content?.find(b => b.type === 'text')?.text ?? '';
  }

  // OpenAI-compatible
  const url = conn.baseURL.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${conn.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: conn.selectedModel, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Provider error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}
