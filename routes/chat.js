import { Router } from 'express';
import { readJSON, dataPath, safePath } from '../lib/fileStore.js';
import { requireArray, requireString, requireEnum } from '../lib/validate.js';
import { proxyStream, activeStreams } from '../lib/streamProxy.js';
import toolHooks from '../lib/toolHooks.js';

const router = Router();

/** Convert OpenAI-style messages to Anthropic Messages API format. */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const nonSystem = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else nonSystem.push({ role: m.role, content: m.content });
  }
  // Merge consecutive same-role messages (Anthropic requires strict alternation)
  const merged = [];
  for (const m of nonSystem) {
    if (merged.length && merged[merged.length - 1].role === m.role) {
      merged[merged.length - 1].content += '\n\n' + m.content;
    } else {
      merged.push({ ...m });
    }
  }
  // First message must be user role
  if (merged.length && merged[0].role !== 'user') {
    merged.unshift({ role: 'user', content: '[Start]' });
  }
  return { system: systemParts.length ? systemParts.join('\n\n') : null, messages: merged };
}

// POST /api/chat — SSE streaming completion
// Body: { messages: [{role, content}], sessionId?: string }
// messages are assembled client-side; we only provide the connection + generation config
router.post('/', async (req, res) => {
  try {
    const settings = await readJSON(dataPath('settings.json'));

    const conn = settings.connectionPresets?.find(p => p.id === settings.activeConnectionPresetId);
    if (!conn?.apiKey) {
      return res.status(400).json({ error: 'No API key in active connection preset. Go to Settings → Connection.' });
    }
    if (!conn?.selectedModel) {
      return res.status(400).json({ error: 'No model in active connection preset. Go to Settings → Connection.' });
    }

    let { messages } = req.body;
    requireArray(req.body, 'messages');
    if (messages.length === 0) {
      return res.status(400).json({ error: 'messages array must not be empty' });
    }
    for (const m of messages) {
      requireEnum(m, 'role', ['user', 'assistant', 'system']);
      requireString(m, 'content');
    }

    // Phase 2 stub: may inject tool definitions or re-route via connection pool
    messages = await toolHooks.processRequest(messages, settings);

    const promptPreset = settings.promptPresets?.find(p => p.id === settings.activePromptPresetId);
    const genSettings = promptPreset?.generationSettings ?? {};

    // ── Request log ───────────────────────────────────────────────────────────
    const roleCounts = messages.reduce((acc, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {});
    const rolesSummary = Object.entries(roleCounts).map(([r, n]) => `${r}: ${n}`).join(', ');
    console.log('\n─── REQUEST ───────────────────────────────────────────');
    console.log(`Model:      ${conn.selectedModel}`);
    console.log(`Provider:   ${conn.provider} → ${conn.baseURL}`);
    const logUrl = conn.baseURL.replace(/\/$/, '') + (conn.provider === 'anthropic' ? '/messages' : '/chat/completions');
    console.log(`Endpoint:   POST ${logUrl}`);
    console.log(`Messages:   ${messages.length} (${rolesSummary})`);
    console.log(`Reasoning:  ${conn.reasoning?.enabled ? `enabled (${conn.reasoning.effort})` : 'off'}`);
    console.log(`Temp: ${genSettings.temperature ?? 0.85}  Top P: ${genSettings.top_p ?? 0.95}  MaxTokens: ${genSettings.max_tokens ?? 1000}  FreqPen: ${genSettings.frequency_penalty ?? 0}  PresPen: ${genSettings.presence_penalty ?? 0}`);
    console.log('── Prompt stack ────────────────────────────────────────');
    for (const m of messages) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      const preview = content.slice(0, 200).replace(/\n/g, '↵') + (content.length > 200 ? '…' : '');
      console.log(`  [${m.role.padEnd(9)}] ${preview}`);
    }
    console.log('───────────────────────────────────────────────────────\n');

    let url, headers, body;

    if (conn.provider === 'anthropic') {
      const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
      const maxTokens = genSettings.max_tokens || 1000;

      body = { model: conn.selectedModel, messages: anthropicMsgs, max_tokens: maxTokens, stream: true };
      if (genSettings.temperature != null) body.temperature = Math.min(genSettings.temperature, 1);
      if (genSettings.top_p != null) body.top_p = genSettings.top_p;
      // Some Claude models reject having both temperature and top_p set
      if (body.temperature != null && body.top_p != null) {
        if (body.top_p < 1) delete body.temperature; else delete body.top_p;
      }
      if (system) body.system = [{ type: 'text', text: system }];

      if (conn.reasoning?.enabled) {
        const budgets = { low: 1024, medium: 8192, high: 32768 };
        const budget = budgets[conn.reasoning.effort] || budgets.medium;
        body.thinking = { type: 'enabled', budget_tokens: budget };
        body.max_tokens = budget + maxTokens;
        // Anthropic disallows temperature/top_p with extended thinking
        delete body.temperature;
        delete body.top_p;
      }

      url = conn.baseURL.replace(/\/$/, '') + '/messages';
      headers = { 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    } else {
      // OpenAI-compatible / OpenRouter
      const { context_size: _ctxDrop, ...apiGenSettings } = genSettings;
      body = { model: conn.selectedModel, messages, stream: true, ...apiGenSettings };

      if (conn.reasoning?.enabled) {
        if (conn.provider === 'openrouter') {
          body.reasoning = { enabled: true, effort: conn.reasoning.effort || 'medium' };
        } else {
          body.thinking = { type: 'enabled' };
          body.reasoning_effort = conn.reasoning.effort || 'medium';
        }
      }

      url = conn.baseURL.replace(/\/$/, '') + '/chat/completions';
      headers = {
        'Authorization': `Bearer ${conn.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers (ignored by other providers)
        ...(conn.provider === 'openrouter' && {
          'HTTP-Referer': 'http://localhost:3001',
          'X-Title': 'st-alt',
        }),
      };
    }

    const upstream = new AbortController();
    const providerRes = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: upstream.signal,
    });

    if (!providerRes.ok) {
      const text = await providerRes.text();
      return res.status(providerRes.status).json({ error: text });
    }

    await proxyStream(providerRes, res, { settings, sessionId: req.body.sessionId, model: conn.selectedModel, controller: upstream, provider: conn.provider });

  } catch (err) {
    if (!res.headersSent) {
      res.status(err.status || 500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      res.end();
    }
  }
});

// GET /api/chat/active — list session IDs currently streaming
router.get('/active', (req, res) => {
  res.json({ sessions: [...activeStreams.keys()] });
});

// GET /api/chat/stream/:sessionId — reconnect to an active stream
router.get('/stream/:sessionId', (req, res) => {
  const entry = activeStreams.get(safePath(req.params.sessionId));
  if (!entry) return res.status(404).json({ error: 'No active stream' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffer so client catches up
  for (const data of entry.buffer) {
    if (!res.writableEnded) res.write(data);
  }

  entry.listeners.add(res);
  req.on('close', () => entry.listeners.delete(res));
});

// DELETE /api/chat/stream/:sessionId — abort an active stream
router.delete('/stream/:sessionId', (req, res) => {
  const entry = activeStreams.get(safePath(req.params.sessionId));
  if (!entry) return res.status(404).json({ error: 'No active stream' });
  entry.controller?.abort();
  activeStreams.delete(req.params.sessionId);
  res.json({ ok: true });
});

export default router;
