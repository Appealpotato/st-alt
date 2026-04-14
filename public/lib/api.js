/**
 * api.js — fetch() wrappers for all backend routes
 */

async function request(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

// Settings (scalar fields only — preset arrays have their own routes)
export const getSettings  = ()       => request('GET',  '/api/settings');
export const saveSettings = (data)   => request('PUT',  '/api/settings', data);

// App version
export const getVersion = () => request('GET', '/api/version');

// Connection presets
export const getConnections   = ()       => request('GET',    '/api/connections');
export const createConnection = (data)   => request('POST',   '/api/connections', data);
export const updateConnection = (id, d)  => request('PUT',    `/api/connections/${id}`, d);
export const deleteConnection = (id)     => request('DELETE', `/api/connections/${id}`);

// Prompt presets
export const getPromptPresets      = ()       => request('GET',    '/api/prompt-presets');
export const createPromptPreset    = (data)   => request('POST',   '/api/prompt-presets', data);
export const updatePromptPreset    = (id, d)  => request('PUT',    `/api/prompt-presets/${id}`, d);
export const deletePromptPreset    = (id)     => request('DELETE', `/api/prompt-presets/${id}`);

// Active preset switching
export const setActiveConnection = (id) => request('PUT', '/api/settings/active-connection', { id });
export const setActivePrompt     = (id) => request('PUT', '/api/settings/active-prompt',     { id });

// Models
export const fetchModels       = ()   => request('GET',    '/api/models');
export const getActiveStreams  = ()   => request('GET',    '/api/chat/active');
export const abortStream       = (id) => request('DELETE', `/api/chat/stream/${id}`);

// Prompts
export const getPrompts      = ()      => request('GET',    '/api/prompts');
export const addPrompt       = (entry) => request('POST',   '/api/prompts', entry);
export const updatePrompt    = (id, p) => request('PATCH',  `/api/prompts/${id}`, p);
export const deletePrompt    = (id)    => request('DELETE', `/api/prompts/${id}`);
export const reorderPrompts  = (ids)   => request('PUT',    '/api/prompts/reorder', { ids });

// Characters
export const getCharacters    = ()        => request('GET',    '/api/characters');
export const createCharacter  = (data)    => request('POST',   '/api/characters', data);
export const getCharacter     = (id)      => request('GET',    `/api/characters/${id}`);
export const saveCharacter    = (id, d)   => request('PUT',    `/api/characters/${id}`, d);
export const deleteCharacter  = (id)      => request('DELETE', `/api/characters/${id}`);

// Avatar uploads (multipart — not JSON)
export async function uploadCharacterAvatar(charId, file) {
  const form = new FormData();
  form.append('avatar', file);
  const res = await fetch(`/api/characters/${charId}/avatar`, { method: 'POST', body: form });
  if (!res.ok) throw new Error('Avatar upload failed');
  return res.json();
}

export async function uploadPersonaAvatar(file) {
  const form = new FormData();
  form.append('avatar', file);
  const res = await fetch('/api/settings/avatar', { method: 'POST', body: form });
  if (!res.ok) throw new Error('Avatar upload failed');
  return res.json();
}

// History
export const getSessions    = ()      => request('GET',    '/api/history');
export const createSession  = (data)  => request('POST',   '/api/history', data);
export const getSession     = (id)    => request('GET',    `/api/history/${id}`);
export const updateSession  = (id, d) => request('PATCH',  `/api/history/${id}`, d);
export const deleteSession  = (id)    => request('DELETE', `/api/history/${id}`);
export const appendMessage   = (id, m)    => request('POST', `/api/history/${id}/messages`, m);
export const replaceMessages = (id, msgs) => request('PUT',  `/api/history/${id}/messages`, { messages: msgs });
export const searchMessages  = (q)        => request('GET',  `/api/history/search?q=${encodeURIComponent(q)}`);
