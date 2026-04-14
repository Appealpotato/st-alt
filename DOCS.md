# st-alt — Technical Documentation

> Minimal locally-run LLM chat frontend for roleplay/collaborative fiction.
> Node/Express backend · Vanilla JS frontend · Flat JSON persistence

---

## Table of Contents

1. [Running the App](#1-running-the-app)
2. [Project Structure](#2-project-structure)
3. [Data Files & Schemas](#3-data-files--schemas)
4. [Backend API Reference](#4-backend-api-reference)
5. [Prompt Stack & Context Assembly](#5-prompt-stack--context-assembly)
6. [SillyTavern Preset Import](#6-sillytavern-preset-import)
7. [Frontend Architecture](#7-frontend-architecture)
8. [Streaming Implementation](#8-streaming-implementation)
9. [Character System](#9-character-system)
10. [Session & Chat History](#10-session--chat-history)
11. [Message Actions](#11-message-actions)
12. [Phase 2 Stubs](#12-phase-2-stubs)
13. [Known Limitations](#13-known-limitations)

---

## 1. Running the App

**Prerequisites:** Node.js v18+ (uses native `fetch`, ESM modules)

```bash
cd st-alt
npm install
node server.js          # production
npm run dev             # auto-restart on file changes (node --watch)
```

App runs at **http://localhost:3001**. Port overrideable via `PORT` env var.

**First run:** `data/` directory is created automatically with default JSON files. No manual setup needed.

**First-use flow:**
1. Go to **Settings** → enter API key → click **Fetch Models** → select model → **Save Settings**
2. Go to **Characters** → create a character → click **Set as Active**
3. Go to **Chat** → start writing

---

## 2. Project Structure

```
st-alt/
├── server.js                   Express entry point, route registration
├── package.json                type: "module", deps: express
│
├── routes/
│   ├── chat.js                 POST /api/chat — SSE streaming proxy
│   ├── settings.js             GET/PUT /api/settings (scalar fields + active-preset switches)
│   ├── connections.js          CRUD for connection presets (/api/connections)
│   ├── promptPresets.js        CRUD for prompt presets (/api/prompt-presets)
│   ├── prompts.js              CRUD + reorder for the active prompt preset's stack
│   ├── characters.js           CRUD for character cards + PNG import + avatar upload
│   ├── models.js               GET /api/models (fetches from provider)
│   └── history.js              CRUD for chat sessions and messages
│
├── lib/
│   ├── fileStore.js            JSON read/write, atomic write, safePath, withLock
│   ├── validate.js             Request body validation helpers (requireString, requireEnum, etc.)
│   ├── streamProxy.js          SSE piping from provider → client
│   └── toolHooks.js            Phase 2 stubs (no-ops in Phase 1)
│
├── data/                       Flat file persistence — gitignore this
│   ├── settings.json
│   ├── prompts.json
│   ├── characters/
│   │   ├── index.json          Character list (id + name only)
│   │   └── {charId}.json       Full character card
│   └── history/
│       ├── index.json          Session list (metadata only)
│       └── {sessionId}.json    Full session with messages
│
└── public/                     Served statically, no build step
    ├── index.html              Shell: nav + right panel + tab containers
    ├── style.css
    ├── app.js                  Global State, panel/tab routing, boot
    ├── views/
    │   ├── chat.js             Chat view (sessions, streaming, message rendering)
    │   ├── promptStack.js      Prompt stack view + ST import
    │   ├── characters.js       Character/persona management view
    │   └── settings.js         Connection, generation, and display settings
    └── lib/
        ├── api.js              fetch() wrappers for all routes
        ├── assembler.js        Prompt assembly — pure function
        ├── stream.js           fetch()-based SSE client
        ├── search.js           Search index used by command palette
        ├── commandPalette.js   Keyboard-accessible command palette (Ctrl+K)
        ├── toast.js            Toast notification system (success/error/info, auto-dismiss, action buttons)
        ├── confirmInline.js    Inline confirm/cancel button utility
        ├── colorPicker.js      HSL colour picker for dialogue colour
        ├── accordion.js        Collapsible accordion section component
        ├── panelResize.js      Drag-to-resize for the right panel with magnetic snap
        ├── cropModal.js        Image crop modal using Cropper.js (avatar uploads)
        ├── cropper.min.js      Vendored Cropper.js v1.5.13 (UMD, sets window.Cropper)
        ├── cropper.min.css     Cropper.js stylesheet
        ├── floatingPanel.js    Draggable floating panel (used by character gallery, editor popout, and prompt stack popout)
        ├── tokenizer.js        Client-side token counting (cl100k approximation)
        ├── icons.js            Lucide icon helper wrappers
        └── lucide.js           Bundled Lucide icon set
```

---

## 3. Data Files & Schemas

All data lives in `data/`. Files are created on first run with defaults. Writes are **atomic** (write to `.tmp` then rename) to prevent corruption.

### data/settings.json

Connection and generation parameters are stored as named presets rather than flat fields. The top-level settings file holds display settings and pointers to the active presets.

```json
{
  "activeConnectionPresetId": "conn_default",
  "activePromptPresetId": "prompt_default",
  "activeCharacterId": "char_a1b2c3d4",
  "activePersonaId": null,

  "chatDisplayMode": "bubble",
  "chatMaxWidth": 100,
  "chatAlign": "center",
  "showMsgDividers": false,
  "showMsgModel": false,
  "showMsgTokens": false,
  "showMsgDuration": false,
  "deleteMode": "single",
  "dialogueColor": "#ef6b6b",
  "avatarShape": "circle",
  "charBrowserView": "grid",
  "chatFont": "system",
  "uiFont": "system",
  "chatFontSize": 14,
  "uiFontSize": 13,
  "chatLineHeight": 1.6,

  "connectionPresets": [
    {
      "id": "conn_default",
      "name": "Default Connection",
      "provider": "openai",
      "baseURL": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-...",
      "selectedModel": "mistralai/mistral-7b-instruct",
      "reasoning": { "enabled": false, "effort": "medium" }
    }
  ],

  "promptPresets": [
    {
      "id": "prompt_default",
      "name": "Default Prompts",
      "stack": [ ... ],
      "generationSettings": {
        "temperature": 0.85,
        "top_p": 0.95,
        "frequency_penalty": 0.0,
        "presence_penalty": 0.0,
        "max_tokens": 1000,
        "context_size": 0
      }
    }
  ]
}
```

**Scalar display fields:**

| Field | Description |
|---|---|
| `activeConnectionPresetId` | ID of the active connection preset |
| `activePromptPresetId` | ID of the active prompt preset |
| `activeCharacterId` | ID of the currently active character card |
| `activePersonaId` | ID of the active persona character (`type: "persona"`). Null if none set |
| `chatDisplayMode` | `"bubble"` or `"manuscript"` — chat layout mode |
| `chatMaxWidth` | Chat column width as a percentage (50–100) |
| `chatAlign` | Chat message alignment: `"left"`, `"center"`, or `"right"` |
| `showMsgDividers` | If true, adds a horizontal rule between message rows |
| `showMsgModel` | If true, shows model ID below assistant messages |
| `showMsgTokens` | If true, shows completion token count below assistant messages |
| `showMsgDuration` | If true, shows generation duration below assistant messages |
| `deleteMode` | `"single"` (delete one message) or `"chain"` (delete from message to end) |
| `dialogueColor` | CSS colour string for quoted dialogue highlighting |
| `avatarShape` | `"circle"`, `"rounded"`, `"square"`, or `"portrait"` |
| `charBrowserView` | `"grid"` or `"list"` — character browser layout |
| `chatFont` / `uiFont` | Font family. `"system"` = system default |
| `chatFontSize` / `uiFontSize` | Font size in px |
| `chatLineHeight` | Line height multiplier for chat messages |

**Connection preset fields:**

| Field | Description |
|---|---|
| `id` | `"conn_"` + UUID slice — server-generated |
| `name` | Display name |
| `provider` | `"openai"` \| `"openrouter"` \| `"anthropic"` — controls request format, auth headers, and endpoint paths. `anthropic`: uses `x-api-key` + `anthropic-version: 2023-06-01`, sends `system` as content-block array `[{"type":"text","text":"..."}]`, drops one of `temperature`/`top_p` when both set (models reject both simultaneously) |
| `baseURL` | Provider base URL including `/v1`. OpenAI/OpenRouter: `{baseURL}/chat/completions` and `{baseURL}/models`. Anthropic: `{baseURL}/messages` and `{baseURL}/models`. Default: `https://api.anthropic.com/v1` |
| `apiKey` | Stored in plaintext. **Masked as `"••••••••"` in GET responses** |
| `selectedModel` | Model ID string passed directly in API requests |
| `reasoning` | `{ enabled: bool, effort: "low"\|"medium"\|"high" }` — for reasoning model support |

**Prompt preset fields:**

| Field | Description |
|---|---|
| `id` | `"prompt_"` + UUID slice — server-generated |
| `name` | Display name |
| `stack` | Array of prompt stack entries (same schema as `data/prompts.json` entries — see below) |
| `generationSettings` | `{ temperature, top_p, frequency_penalty, presence_penalty, max_tokens, context_size }` — context_size (0 = no limit) caps total prompt tokens client-side; other fields passed to provider |

**Scalar settings** are updated via `PUT /api/settings`. **Presets** are managed via their own routes (`/api/connections`, `/api/prompt-presets`). The `PUT /api/settings` endpoint ignores `connectionPresets` and `promptPresets` — they cannot be overwritten through the scalar endpoint.

**Migration:** On first run after updating from an older schema that has flat `apiKey`/`baseURL`/`provider` fields, `server.js` automatically migrates them into a `connectionPreset` and moves the `prompts.json` stack into a `promptPreset`. This migration runs at startup before any requests are served.

---

### data/prompts.json

```json
{
  "entries": [
    {
      "id": "entry_system",
      "type": "system",
      "label": "Main System Prompt",
      "content": "You are a creative writing assistant...",
      "enabled": true,
      "role": "system",
      "injection_depth": 0
    },
    {
      "id": "entry_character",
      "type": "character",
      "label": "Character Card",
      "content": null,
      "enabled": true,
      "role": "system",
      "injection_depth": 0
    },
    {
      "id": "entry_chathistory",
      "type": "chatHistory",
      "label": "Chat History",
      "content": null,
      "enabled": true,
      "role": null,
      "injection_depth": 0
    }
  ]
}
```

**Entry types:**

| `type` | Description |
|---|---|
| `"system"` | Regular prompt. Content is sent as-is. `role` and `injection_depth` apply. |
| `"character"` | Sentinel. `content` is always `null`. Expands to formatted character card at assembly time. |
| `"chatHistory"` | Sentinel. `content` is always `null`. Marks where chat messages are inserted in the stack. Cannot be disabled in the UI. |

**`injection_depth`:**
- `0` — entry appears at its normal stack position
- `> 0` — entry is woven *inside* the chat history block, N messages from the bottom (Authors Note pattern). See [Section 5](#5-prompt-stack--context-assembly).

**`role`:** `"system"`, `"user"`, or `"assistant"`. Passed directly in the messages array. `null` for sentinels.

**Order** in the array is canonical. `PUT /api/prompts/reorder` replaces the order.

---

### data/characters/index.json

Each entry is a lightweight summary — no full card data. Used by the character browser without fetching every card.

```json
{
  "characters": [
    {
      "id": "char_a1b2c3d4",
      "name": "Lyra",
      "type": "character",
      "avatar": "/avatars/char_a1b2c3d4.png",
      "creatorNotes": "A wandering archivist…"
    }
  ]
}
```

| Field | Description |
|---|---|
| `id` | Character ID |
| `name` | Character name |
| `type` | `"character"` or `"persona"` |
| `avatar` | Path to avatar image, or `null` |
| `creatorNotes` | First 120 chars of `creatorNotes`, for subtitle display |

---

### data/characters/{id}.json

```json
{
  "id": "char_a1b2c3d4",
  "type": "character",
  "name": "Lyra",
  "description": "A wandering archivist with silver-streaked hair...",
  "personality": "Curious, methodical, occasionally acerbic.",
  "scenario": "The archive has been sealed for three days.",
  "firstMessage": "The archive doors groan as you push them open...",
  "mesExample": "<START>\n{{user}}: Hello\n{{char}}: Hello to you.",
  "creatorNotes": "Internal notes, not sent to the model.",
  "avatar": "/avatars/char_a1b2c3d4.png"
}
```

| Field | Description |
|---|---|
| `type` | `"character"` (default) or `"persona"` (represents the human player) |
| `name` | Character name |
| `description` | Main character description |
| `personality` | Personality traits |
| `scenario` | Scene/context setup |
| `firstMessage` | **Auto-injected** as the first assistant message when a new session is created with this character |
| `mesExample` | Example dialogue — stored but not currently included in prompt assembly |
| `creatorNotes` | Private notes — stored but not sent to the model |
| `avatar` | Path to uploaded avatar image, or `null` |

---

### data/history/index.json

```json
{
  "sessions": [
    {
      "id": "ses_1713000000000",
      "title": "The Forest Encounter",
      "characterId": "char_a1b2c3d4",
      "characterName": "Lyra",
      "personaId": "char_e5f6g7h8",
      "createdAt": "2026-04-12T10:00:00.000Z",
      "updatedAt": "2026-04-12T10:45:00.000Z",
      "messageCount": 14,
      "lastMessagePreview": "She stepped into the light, her silver hair catching the…"
    }
  ]
}
```

Sessions are stored newest-first (unshift on create).

---

### data/history/{sessionId}.json

```json
{
  "id": "ses_1713000000000",
  "title": "The Forest Encounter",
  "characterId": "char_a1b2c3d4",
  "characterName": "Lyra",
  "createdAt": "2026-04-12T10:00:00.000Z",
  "updatedAt": "2026-04-12T10:45:00.000Z",
  "messages": [
    {
      "id": "msg_a1b2c3d4",
      "role": "user",
      "content": "I approach the archivist cautiously.",
      "timestamp": "2026-04-12T10:00:05.000Z"
    },
    {
      "id": "msg_e5f6g7h8",
      "role": "assistant",
      "content": "Lyra looks up from the scroll...",
      "timestamp": "2026-04-12T10:00:12.000Z",
      "swipes": ["Lyra looks up from the scroll...", "Lyra sets down her quill..."],
      "swipeIndex": 0,
      "metadata": {
        "model": "mistralai/mistral-7b-instruct",
        "usage": { "prompt_tokens": 312, "completion_tokens": 87 },
        "duration": 4200,
        "toolCalls": []
      }
    }
  ]
}
```

**Swipe fields** (assistant messages only, present only when regenerated):

| Field | Description |
|---|---|
| `swipes` | Array of alternate content strings. `swipes[swipeIndex]` always matches `content` |
| `swipeIndex` | Currently displayed swipe. `0`-based |

When a message has never been regenerated, `swipes` and `swipeIndex` are absent and `content` is the sole value. On first regeneration, the original content is wrapped into `swipes[0]` and the new response becomes `swipes[1]`.

`metadata.duration` is the wall-clock time in milliseconds for the stream to complete. `metadata.toolCalls` is always `[]` in Phase 1.

---

## 4. Backend API Reference

### Settings

#### `GET /api/settings`
Returns current settings. `connectionPresets[].apiKey` is masked as `"••••••••"` if set, `""` if not.

**Response:** Full settings object as described in [Section 3](#3-data-files--schemas).

#### `PUT /api/settings`
Updates **scalar display fields only**. Does not touch `connectionPresets` or `promptPresets` — those have their own routes.

**Allowed fields:** `activeConnectionPresetId`, `activePromptPresetId`, `activeCharacterId`, `activePersonaId`, `avatarShape`, `charBrowserView`, `chatDisplayMode`, `dialogueColor`, `chatMaxWidth`, `chatAlign`, `showMsgModel`, `showMsgTokens`, `showMsgDuration`, `showMsgDividers`, `chatFont`, `uiFont`, `chatFontSize`, `uiFontSize`, `chatLineHeight`, `deleteMode`

#### `PUT /api/settings/active-connection`
Switch which connection preset is active.

**Request body:** `{ "id": "conn_abc" }`

**Response:** `{ "activeId": "conn_abc" }`

#### `PUT /api/settings/active-prompt`
Switch which prompt preset is active.

**Request body:** `{ "id": "prompt_abc" }`

**Response:** `{ "activeId": "prompt_abc" }`

---

### Connections

#### `GET /api/connections`
**Response:** `{ "presets": [...], "activeId": "conn_abc" }` — all connection presets with API keys masked.

#### `POST /api/connections`
Create a new connection preset.

**Request body:** `{ name?, provider?, baseURL?, apiKey?, selectedModel?, reasoning? }` — all optional.

**Response:** `201` + `{ "preset": {...} }` with server-generated `id: "conn_" + UUID[0:8]`.

#### `PUT /api/connections/:id`
Update a connection preset (partial merge). If `apiKey` is `"••••••••"`, the existing key is preserved.

**Response:** `{ "preset": {...} }`

#### `DELETE /api/connections/:id`
Cannot delete the last preset — returns `400`.

**Response:** `{ "deleted": "conn_abc", "activeId": "conn_xyz" }`

---

### Prompt Presets

#### `GET /api/prompt-presets`
**Response:** `{ "presets": [...], "activeId": "prompt_abc" }` — all prompt presets including full stacks and generation settings.

#### `POST /api/prompt-presets`
Create a new prompt preset.

**Request body:** `{ name?, stack?, generationSettings? }` — all optional.

**Response:** `201` + `{ "preset": {...} }` with server-generated `id: "prompt_" + UUID[0:8]`.

#### `PUT /api/prompt-presets/:id`
Update a prompt preset. `stack` is replaced entirely if provided. `generationSettings` is shallow-merged if provided.

**Response:** `{ "preset": {...} }`

#### `DELETE /api/prompt-presets/:id`
Cannot delete the last preset — returns `400`.

**Response:** `{ "deleted": "prompt_abc", "activeId": "prompt_xyz" }`

---

### Models

#### `GET /api/models`
Fetches model list from the configured provider's `/models` endpoint. Requires `apiKey` to be set.

**Response:**
```json
{
  "models": [
    { "id": "anthropic/claude-opus-4-5", "name": "Claude Opus 4.5" },
    { "id": "mistralai/mistral-7b-instruct", "name": "Mistral 7B Instruct" }
  ]
}
```

Sorted alphabetically by `id`. Normalized from OpenAI/OpenRouter `data: [{id, name}]` format.

---

### Prompts

#### `GET /api/prompts`
Returns the prompt stack. **Auto-migration:** if no `chatHistory` sentinel exists in the entries, one is appended automatically and the file is saved.

**Response:** `{ "entries": [...] }` — full entry objects as described in [Section 3](#3-data-files--schemas).

#### `PUT /api/prompts`
Full replacement of the entries array.

**Request body:** `{ "entries": [...] }`

#### `POST /api/prompts`
Add a new entry.

**Request body:** Partial entry. Defaults: `type: "system"`, `label: "New Entry"`, `content: ""`, `enabled: true`, `role: "system"`, `injection_depth: 0`. Auto-generates `id: "entry_" + UUID[0:8]`.

**Response:** `201` + full entry object.

#### `PATCH /api/prompts/:id`
Partial update. Any provided fields are merged. `id` is always preserved.

#### `DELETE /api/prompts/:id`
**Response:** `{ "ok": true }`

#### `PUT /api/prompts/reorder`
Reorders the entries array to match the provided ID order.

**Request body:** `{ "ids": ["entry_abc", "entry_def", ...] }`

Any entries not in `ids` are appended at the end (safety net, shouldn't happen in normal use).

---

### Characters

#### `GET /api/characters`
Returns index only (no full card data). Auto-heals index entries missing `type`/`avatar`/`creatorNotes` from older schemas.

**Response:** `{ "characters": [{ "id", "name", "type", "avatar", "creatorNotes" }, ...] }`

#### `POST /api/characters`
Create a new character.

**Request body:** `{ name?, type?, description?, personality?, scenario?, firstMessage?, mesExample?, creatorNotes? }` — all optional.

**Response:** `201` + full character object with generated `id: "char_" + UUID[0:8]`.

#### `GET /api/characters/:id`
Full character card.

#### `PUT /api/characters/:id`
Full replacement. Merges over existing. Updates index entry automatically.

#### `DELETE /api/characters/:id`
Removes from index and deletes the file.

#### `POST /api/characters/import`
Import a character from a SillyTavern-format PNG (character data embedded in PNG `tEXt` chunk). Multipart `file` field. Accepts v1 (flat JSON), v2 (`chara_card_v2`, keyword `chara`), and v3 (`chara_card_v3`, keyword `ccv3`) cards; keyword match is case-insensitive and `ccv3` takes precedence when both are present.

**Response:** `201` + full character object. Avatar is saved to `data/avatars/`.

#### `GET /api/characters/:id/export-png`
Export a character as a SillyTavern-compatible PNG. Embeds the character card JSON (v2 format) in a PNG `tEXt` chunk with keyword `chara` (base64-encoded). Uses the character's avatar PNG as the base image if available; otherwise uses a 1×1 transparent PNG.

**Response:** PNG file download (`Content-Disposition: attachment; filename="{name}.png"`).

#### `POST /api/characters/:id/avatar`
Upload a new avatar image for a character. Multipart `file` field. Accepts `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` up to 5 MB.

**Response:** `{ "avatar": "/avatars/filename.ext" }`

---

### Chat History

#### `GET /api/history`
Returns session index (no messages).

**Response:** `{ "sessions": [...] }` — metadata objects, newest first.

#### `POST /api/history`
Create a new session.

**Request body:** `{ title?, characterId?, characterName?, personaId? }`

**Response:** `201` + metadata object. Session file is created with empty `messages: []`.

#### `GET /api/history/:id`
Full session including all messages.

#### `GET /api/history/:id/export-jsonl`
Downloads the session as a SillyTavern-compatible JSONL file. Line 1 is a metadata header (`user_name`, `character_name`, `create_date`), subsequent lines are messages with ST fields (`name`, `is_user`, `is_system`, `mes`, `send_date`, `swipes`, `swipe_id`, `swipe_info`, `extra`). Swipe fields are omitted for messages without swipes. `{{char}}`/`{{user}}` macros are preserved raw.

**Response:** `Content-Type: application/x-ndjson`, `Content-Disposition: attachment` with filename `CharName - YYYY-MM-DD@HHhMMmSSs.jsonl`.

#### `GET /api/history/search?q=term`
Searches message content across all sessions. Minimum query length: 2 characters. Returns up to 20 results with context preview (~100 chars around match).

**Response:** `{ results: [{ sessionId, sessionTitle, characterName, messageId, role, preview, historyIndex }] }`

Results are surfaced in the command palette (Ctrl+K) as an async "Messages" group. Clicking a result navigates to the session and highlights the matched message.

#### `POST /api/history/import-jsonl`
Imports a SillyTavern-compatible JSONL file as a new chat session. Accepts `multipart/form-data` with a single `file` field. Maps ST fields (`mes`, `is_user`, `swipes`, `swipe_id`, `send_date`, `extra.model`) back to st-alt format. Attempts to match a character by name (case-insensitive).

**Response:** `201` + `{ id, title, messageCount, characterMatched }`. Returns `400` on invalid/empty file.

#### `GET /api/history/export-character/:charId`
Downloads a zip of all JSONL chat exports for a character. Each chat is a separate `.jsonl` file inside the zip, using the same ST-compatible format as the single-chat export.

**Response:** `Content-Type: application/zip`, `Content-Disposition: attachment` with filename `CharName - all chats.zip`. Returns `404` if no chats exist for the character.

#### `PATCH /api/history/:id`
Update session title and/or persona binding.

**Request body:** `{ "title": "...", "personaId": "char_..." | null }`  
Both fields are optional. `personaId: null` removes the persona binding (falls back to global active persona).

#### `DELETE /api/history/:id`
Removes from index and deletes session file.

#### `POST /api/history/:id/messages`
Append a message. Called after a user sends a message, and again after the assistant response is complete.

**Request body:**
```json
{
  "role": "user" | "assistant",
  "content": "...",
  "model": "...",       // assistant only
  "usage": { ... },     // assistant only
  "duration": 4200      // assistant only — ms elapsed
}
```

**Response:** `201` + full message object. Also updates `messageCount` and `updatedAt` in the index.

#### `PUT /api/history/:id/messages`
Replace the entire messages array. Used by regen (truncate), inline edit save, swipe navigation, and branch operations — any operation that modifies existing messages rather than appending.

**Request body:** `{ "messages": [...] }` — full messages array to write.

**Response:** `{ "ok": true, "messageCount": N }`

---

### Chat (Streaming)

#### `POST /api/chat`
Initiates a streaming completion. **Returns `text/event-stream`.**

**Request body:**
```json
{
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user",   "content": "..." }
  ],
  "sessionId": "ses_..."
}
```

The `messages` array is **pre-assembled by the client** (see [Section 5](#5-prompt-stack--context-assembly)). The backend's only job is to proxy and pipe.

**Headers sent to provider:**
- `Authorization: Bearer {apiKey}`
- `HTTP-Referer: http://localhost:3001` (required by OpenRouter)
- `X-Title: st-alt` (required by OpenRouter)

**Provider request body:**
```json
{
  "model": "{selectedModel}",
  "messages": [...],
  "stream": true
}
```

**SSE response format:**
```
data: {"type":"token","content":"Hello"}
data: {"type":"token","content":" there"}
data: {"type":"done","usage":{"prompt_tokens":120,"completion_tokens":45}}
data: {"type":"error","message":"Something went wrong"}
```

**Error responses (before streaming starts):**
- `400` — no API key, no model selected, or empty messages
- `{providerStatus}` — if provider returns a non-2xx response

---

## 5. Prompt Stack & Context Assembly

The context sent to the model is assembled entirely client-side in `public/lib/assembler.js`, then POSTed as a `messages` array. The backend has no knowledge of what's in the array.

### Stack Anatomy

```
┌──────────────────────────────┐
│ [entry: system]              │  ← Regular entries — sent as {role, content}
│ [entry: character]           │  ← Expands to formatted character fields
│ [entry: system]              │
│ [entry: chatHistory]         │  ← SENTINEL: chat messages inserted here
│ [entry: system, post-hist]   │  ← Post-history (jailbreak, nudge, etc.)
└──────────────────────────────┘
```

The position of the `chatHistory` sentinel determines where actual chat messages appear in the context. Entries above it are pre-history context. Entries below it are post-history instructions. This is how SillyTavern's system prompt ordering works.

### Depth Injection (Authors Note pattern)

Any entry with `injection_depth > 0` is **not** placed at its stack position. Instead, it is inserted *inside* the chat history block, N messages from the bottom:

```
depth=1  →  inserted before the last message
depth=2  →  inserted before the second-to-last message
depth=N  →  inserted before the Nth message from the end
```

If depth exceeds the number of chat messages, the entry is prepended before all chat messages.

This is used for Authors Notes, scene reminders, and other injections that need to stay near the bottom of context for the model's attention.

### Character Card Expansion

When the assembler encounters a `type: "character"` entry, it expands it to:

```
Name: {name}
Description: {description}
Personality: {personality}
Scenario: {scenario}
```

Empty fields are omitted. The result is sent as a single message at `{entry.role}` (default: `"system"`).

### Assembly Algorithm

```
function assembleMessages(promptEntries, character, chatHistory):

  # Split into depth-injected (woven into chat) and main (positioned by stack)
  depthEntries = entries where enabled and injection_depth > 0
  mainEntries  = entries where enabled and not depth-injected

  hasSentinel = mainEntries contains a chatHistory entry

  messages = []
  for entry in mainEntries:
    if entry.type == "chatHistory":
      insertChatHistory(messages, chatHistory, depthEntries)
    elif entry.type == "character":
      content = formatCharacterCard(character)
      if content: messages.push({role: entry.role, content})
    else:
      if entry.content: messages.push({role: entry.role, content: entry.content})

  # Fallback: no chatHistory sentinel found — append at end
  if not hasSentinel:
    insertChatHistory(messages, chatHistory, depthEntries)

  return applyPersistentInjections(messages)  # Phase 2 stub, no-op now


function insertChatHistory(messages, chatHistory, depthEntries):
  len = chatHistory.length
  for i in 0..len:
    for dep in depthEntries:
      targetIdx = max(0, len - dep.injection_depth)
      if i == targetIdx:
        messages.push({role: dep.role, content: dep.content})
    messages.push({role: chatHistory[i].role, content: chatHistory[i].content})

  # Edge case: empty chat history — still inject depth entries
  if len == 0:
    for dep in depthEntries:
      if dep.content: messages.push({role: dep.role, content: dep.content})
```

### Full Context Example

Given this prompt stack and chat history:

```
Stack (in order):
  [system] "You are a creative writing assistant"     injection_depth=0
  [character] expands to "Name: Lyra\nDescription: ..."  injection_depth=0
  [system] "Keep responses under 300 words"           injection_depth=4
  [chatHistory] ← sentinel
  [system] "Always end your turn."                    injection_depth=0

Chat history (5 messages):
  user: "Hello"
  assistant: "Hi there"
  user: "Tell me a story"
  assistant: "Once upon..."
  user: "Continue"
```

Assembled messages:

```
1. system  "You are a creative writing assistant"
2. system  "Name: Lyra\nDescription: ..."
   ─── chat history starts ───
3. user    "Hello"
4. assistant "Hi there"
   ─── depth=4 injected here (5-4=1, i.e. before message at index 1) ───
5. system  "Keep responses under 300 words"
6. user    "Tell me a story"
7. assistant "Once upon..."
8. user    "Continue"
   ─── chat history ends ───
9. system  "Always end your turn."
```

---

## 6. SillyTavern Preset Import

Import from the Prompts view using the **Import ST Preset** button. Accepts `.json` files in SillyTavern's preset format.

### ST Preset Format

```json
{
  "prompts": [
    {
      "identifier": "main",
      "name": "Main Prompt",
      "content": "You are a helpful assistant...",
      "enable": true,
      "role": "system",
      "injection_position": 0,
      "injection_depth": 0
    }
  ],
  "prompt_order": [
    {
      "order": [
        { "identifier": "worldInfoBefore", "enabled": false },
        { "identifier": "charDescription",  "enabled": true },
        { "identifier": "charPersonality",  "enabled": true },
        { "identifier": "scenario",         "enabled": true },
        { "identifier": "chatHistory",      "enabled": true },
        { "identifier": "main",             "enabled": true },
        { "identifier": "jailbreak",        "enabled": true }
      ]
    }
  ]
}
```

### Identifier Mapping

| ST identifier | Maps to |
|---|---|
| `chatHistory` | `type: "chatHistory"` sentinel — **critical for correct assembly** |
| `charDescription` | Collapsed into `type: "character"` sentinel |
| `charPersonality` | Collapsed into `type: "character"` sentinel |
| `scenario` | Collapsed into `type: "character"` sentinel |
| `dialogueExamples` | Collapsed into `type: "character"` sentinel |
| `worldInfoBefore` | Imported as **disabled** system entry (if content present) |
| `worldInfoAfter` | Imported as **disabled** system entry (if content present) |
| `personaDescription` | Imported as system entry (if content present) |
| Any custom prompt | Imported as `type: "system"` entry |

All four character markers collapse into a **single** character sentinel placed at the first occurrence. The character card content comes from the active character card, not from the preset.

### Depth Injection Mapping

ST uses `injection_position` to indicate depth injection:

| ST value | Behavior |
|---|---|
| `injection_position: 0` | Normal stack position (`injection_depth: 0`) |
| `injection_position: 1` | Depth-injected. Uses `injection_depth` from ST data, defaults to `4` if absent |

### Import Behavior

On import:
1. All existing non-sentinel entries are deleted
2. The imported entries are created (new IDs assigned)
3. The character and chatHistory sentinels are preserved (or added if missing)
4. The prompts view reloads from the server

**If the preset has no `chatHistory` identifier:** A chatHistory sentinel is appended at the end.
**If the preset has no character identifiers:** A character sentinel is prepended at the top.

---

## 7. Frontend Architecture

### View System

The right panel slides in/out. Each tab (`characters`, `prompts`, `settings`)
has a persistent `.tab-container` div that is shown/hidden via the `tab-container--active`
class. Views are lazy-initialized on first visit (`init`) and refreshed on revisits (`onShow`).
The panel and last-visited tab are persisted in `localStorage` so state is restored on refresh.
The panel uses overlay mode — it floats over the chat area instead of displacing it. A
`--active-panel-width` CSS variable is synced on open, close, and during resize drag;
`#chat-messages` uses it to expand its `padding-right` and `max-width` so messages center in the
visible area while the input area stays fixed at the bottom. `.fp-overlay` uses it as `right` so
floating/popout windows also center in the visible area. A semi-transparent backdrop (visual only,
clicks pass through to chat) dims the chat area when the panel is open. The panel and resize
handle live inside an absolutely-positioned `#panel-wrapper` (z-index 60, above floating panels
at 50). The panel is drag-resizable via a handle on its left edge (`panelResize.js`). Width is
persisted in `localStorage('panelWidth')`. A magnetic snap pulls the width to 400px (default)
within a 20px range; dragging past breaks free.

The `characters` tab has two subtabs ("Editor" and "Chats") that appear when a character is
open in the inline editor. The Chats subtab shows all sessions for that character with relative
timestamps and last-message previews. Both subtabs can be popped out into floating panels via
the Maximize button in the inline editor header.

The Chats subtab toolbar is a right-aligned row of Lucide icon buttons: **MessageSquarePlus** (new chat), **Upload** (import JSONL), **Package** (export all as zip), and **ListChecks** (toggle select mode). The select button gets an accent highlight while active.

Select mode is click-to-select with no checkboxes: clicking anywhere on a row toggles selection (accent left-border + tinted background). Per-row hover actions (rename / export / delete) are hidden while in select mode via `.char-chat-list--selecting .char-chat-item-actions { display: none }`. A sticky bulk bar at the bottom shows `N selected` and a red **Trash2** icon; clicking it runs `confirmInline`, which swaps the icon in-place to `[✓] [✗]` (checkmark left of X). Exit select mode by clicking the toggle again; selection clears on exit.

Per-row actions (rename / export / delete) live in a fixed-width (72px `min-width`) hover-revealed bar to prevent any layout shift when delete → `[✓] [✗]` confirm swap fires; rename + export siblings `display: none` during the pending confirm so the ✓/✗ fill their slot. Inline rename swaps the title span for a borderless transparent input with an underline `box-shadow` cue — zero card height change.

When a new session is created anywhere (new chat button, branch from message), `chat.js` dispatches a `sessionscreated` CustomEvent; `characters.js` listens for it and refreshes the chats subtab if the new session belongs to the character currently open in the inline editor.

Characters tab state is fully persisted across refreshes via `localStorage`:
- `charTypeFilter` — active type filter (`character` or `persona`)
- `charInlineId` — ID of the character open in the inline editor (cleared on back-to-browser)
- `charSubtab` — active inline subtab (`editor` or `chats`)

Each view module exports:
- `init(State)` — called once on first visit. Sets up DOM, wires events, fetches initial data.
- `onShow(State)` — called on subsequent visits. Refreshes stale data if needed.

### Global State

```javascript
const State = {
  settings: null,           // Full settings object from /api/settings

  prompts: [],              // Prompt stack entries

  characters: [],           // [{ id, name }, ...] — lightweight index
  activeCharacterId: null,  // ID of the active character
  activePersonaId:   null,  // ID of the active persona
  activePersona:     null,  // Full persona object (type: "persona" character)
  sessionCharacter:  null,  // Full character object for the currently open session
  sessionPersona:    null,  // Persona bound to current session (falls back to activePersona)

  sessions: [],             // Session metadata list (newest first)
  activeSessionId:   null,
  chatHistory:       [],    // Messages for the active session

  isStreaming: false,       // True while a completion is in flight
};
```

State is mutated directly by view modules. There is no reactivity layer — each mutation is followed by a targeted render call.

### API Layer (`public/lib/api.js`)

All backend communication goes through typed wrapper functions:

```javascript
// Settings
getSettings()                       → GET /api/settings
saveSettings(data)                  → PUT /api/settings (scalar fields only)

// Connection presets
getConnections()                    → GET /api/connections
createConnection(data)              → POST /api/connections
updateConnection(id, data)          → PUT /api/connections/:id
deleteConnection(id)                → DELETE /api/connections/:id
setActiveConnection(id)             → PUT /api/settings/active-connection

// Prompt presets
getPromptPresets()                  → GET /api/prompt-presets
createPromptPreset(data)            → POST /api/prompt-presets
updatePromptPreset(id, data)        → PUT /api/prompt-presets/:id
deletePromptPreset(id)              → DELETE /api/prompt-presets/:id
setActivePromptPreset(id)           → PUT /api/settings/active-prompt

// Active prompt stack (operates on the active preset's stack)
getPrompts()                        → GET /api/prompts
addPrompt(entry)                    → POST /api/prompts
updatePrompt(id, patch)             → PATCH /api/prompts/:id
deletePrompt(id)                    → DELETE /api/prompts/:id
reorderPrompts(ids)                 → PUT /api/prompts/reorder

// Models
fetchModels()                       → GET /api/models

// Characters
getCharacters()                     → GET /api/characters
createCharacter(data)               → POST /api/characters
getCharacter(id)                    → GET /api/characters/:id
saveCharacter(id, data)             → PUT /api/characters/:id
deleteCharacter(id)                 → DELETE /api/characters/:id
uploadCharacterAvatar(id, file)     → POST /api/characters/:id/avatar

// Sessions
getSessions()                       → GET /api/history
createSession(data)                 → POST /api/history
getSession(id)                      → GET /api/history/:id
updateSession(id, patch)            → PATCH /api/history/:id
deleteSession(id)                   → DELETE /api/history/:id
appendMessage(sessionId, msg)       → POST /api/history/:id/messages
replaceMessages(sessionId, msgs)    → PUT /api/history/:id/messages

// Active streams (for reconnect on reload)
getActiveStreams()                   → GET /api/chat/active-streams
abortStream(sessionId)              → DELETE /api/chat/active-streams/:id
```

All functions return `Promise<JSON>` and throw on non-2xx responses.

---

## 8. Backend Utilities

### `lib/fileStore.js`

| Export | Description |
|---|---|
| `readJSON(path)` | Read and parse a JSON file |
| `writeJSON(path, data)` | Atomic write (tmp + rename), serialized per file path |
| `withLock(pathOrPaths, fn)` | Serialize a read-modify-write cycle. `fn` receives parsed JSON, must return updated object to write back. Accepts a single path or array of paths for multi-file locking. |
| `dataPath(...segments)` | Resolve a path under `data/` |
| `safePath(id)` | Validate that an ID is safe for use in file paths (`/^[a-zA-Z0-9_-]+$/`). Throws 400 on invalid input. |
| `createCharacterCard(card)` | Write card file + append to character index (locked) |
| `updateCharacterIndex(card)` | Update character index entry (locked) |

### `lib/validate.js`

Lightweight request body validators. Each throws with `err.status = 400` on failure.

| Export | Signature |
|---|---|
| `requireString(obj, field, opts?)` | `{ maxLen?, optional? }` |
| `requireEnum(obj, field, allowed, opts?)` | `{ optional? }` |
| `requireArray(obj, field, opts?)` | `{ maxLen?, optional? }` |
| `requireBool(obj, field, opts?)` | `{ optional? }` |
| `requireNumber(obj, field, opts?)` | `{ min?, max?, optional? }` |

---

## 9. Streaming Implementation

### Backend (`lib/streamProxy.js`)

The backend receives a streaming response from the provider and pipes it to the client in a normalized format.

1. Sets SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
2. Reads the provider's response body as a `ReadableStream` of SSE chunks
3. Buffers incomplete lines across chunks
4. For each `data: {...}` line: extracts `choices[0].delta.content` (OpenAI format)
5. Re-emits as `data: {"type":"token","content":"..."}` to the client
6. On `data: [DONE]`: emits `{"type":"done","usage":{...}}` and closes
7. On any error: emits `{"type":"error","message":"..."}` and closes

The re-wrapping normalizes away provider-specific SSE quirks. OpenRouter and vanilla OpenAI have minor differences in their streams; the client sees a consistent format regardless.

### Frontend (`public/lib/stream.js`)

`EventSource` only supports GET requests, so streaming uses `fetch()` with a `ReadableStream` response body.

```javascript
streamCompletion(messages, sessionId, onToken, onDone, onError)
// Returns an abort() function
```

1. POSTs to `/api/chat` with `{ messages, sessionId }`
2. Reads response body via `ReadableStream.getReader()`
3. Decodes chunks with `TextDecoder({ stream: true })`
4. Buffers and splits on `\n`, parses `data: {JSON}` lines
5. Calls `onToken(content)` for each token event
6. Calls `onDone({ usage })` on done event
7. Calls `onError(message)` on error events or fetch failures

The returned abort function calls `AbortController.abort()`, which is caught silently.

### Chat View Flow

```
User sends message
  │
  ├─ Append user message to DOM
  ├─ POST message to /api/history/:id/messages (persist immediately)
  │
  ├─ assembleMessages(prompts, character, chatHistory) → messages[]
  │
  ├─ streamCompletion(messages, sessionId, ...)
  │     ├─ onToken: accumulate + update message DOM in place
  │     ├─ onDone:  POST complete assistant message to history
  │     │           Auto-title session if first exchange
  │     └─ onError: show error in message bubble
  │
  ├─ Typing indicator (animated dots) shown for 400ms minimum before first content
  │  Avatar pulses with accent-colored glow during streaming (CSS :has() selector)
  │
  └─ Send button becomes "Stop" during streaming
     Clicking Stop calls abort(), preserves partial content client- and server-side
```

---

## 10. Character System

Characters are stored as individual JSON files in `data/characters/`. The `data/characters/index.json` file holds lightweight metadata (id + name) for list display without reading every file.

### Active Character

One character can be designated the **active character** via the Characters view. The active character ID is stored in `settings.activeCharacterId`.

New chat sessions created while a character is active automatically inherit:
- `characterId` — the character's ID (stored in session)
- `characterName` — the character's name at creation time (denormalized for display)

### Personas

A **persona** is a character with `type: "persona"`. It represents the human player's
in-character identity. One persona can be set as active (`settings.activePersonaId`).

The active persona affects:
- The user-side avatar displayed in chat messages
- The `{{user}}` / `{{User}}` template variable substitution
- The name shown in the user message header (manuscript mode)

Personas are created and managed in the Characters view, which has a separate "Personas"
section. They share the same JSON schema as regular characters.

Personas are **bound to sessions**: when a new session is created, the currently active
`personaId` is stored on the session. Loading a session restores its bound persona as
`State.sessionPersona`. Old sessions without a `personaId` fall back to `State.activePersona`.

### Character & Persona ↔ Session Binding

Sessions have `characterId` and `personaId` fields. When a session is loaded:

```javascript
// Character
const charId = session.characterId ?? State.activeCharacterId;
if (charId) State.sessionCharacter = await getCharacter(charId);

// Persona
const pId = session.personaId;
if (pId) State.sessionPersona = await getCharacter(pId);
else     State.sessionPersona = State.activePersona;  // fallback for old sessions
```

This means:
- Sessions created with a specific character/persona always use those, even if the global active selection changes later
- Old sessions without a `characterId` or `personaId` fall back to the current active character/persona
- Chat rendering, prompt assembly, and `{{user}}`/`{{char}}` substitution all use `State.sessionPersona` (not `State.activePersona`)

### Character Fields in Context

The assembler expands the character card into this format:

```
Name: {name}
Description: {description}
Personality: {personality}
Scenario: {scenario}
```

Each field is only included if non-empty. The result is injected as a single system message at the position of the `character` sentinel in the prompt stack.

`mesExample` and `creatorNotes` are stored on the character card but **not** included in prompt assembly.

**`firstMessage`** is **auto-injected** as the first assistant message when a new session is created with the character. This happens before `selectSession` is called, so it appears in the chat history like any other message and is included in context assembly normally.

---

## 11. Session & Chat History

### Session Lifecycle

```
createSession({ title, characterId, characterName, personaId })
  → Writes history/{id}.json with empty messages[]
  → Unshifts metadata into history/index.json
  → Returns metadata

selectSession(id)
  → Loads history/{id}.json (full messages)
  → Loads character for this session
  → Renders message list

appendMessage(sessionId, { role, content, model?, usage? })
  → Appends to messages[] in history/{id}.json
  → Updates messageCount, updatedAt, and lastMessagePreview in index
```

### Auto-title

When the first exchange completes (2 messages in history), the session title is updated automatically to the first 40 characters of the user's opening message.

### ID Schemes

| Entity | ID format | Generated by |
|---|---|---|
| Character | `char_` + UUID[0:8] | `routes/characters.js` |
| Session | `ses_` + `Date.now()` | `routes/history.js` |
| Message | `msg_` + UUID[0:8] | `routes/history.js` |
| Prompt entry | `entry_` + UUID[0:8] | `routes/prompts.js` |

Session IDs use `Date.now()` for natural chronological ordering. All others use UUID slices for collision resistance.

---

## 12. Message Actions

Each message bubble has a hover/tap action bar with the following buttons:

| Action | Roles | Description |
|---|---|---|
| Edit (pencil) | user + assistant | Replaces the bubble with a textarea. Save commits via `PUT /api/history/:id/messages`. If the message has swipes, the active swipe content is updated too |
| Delete (trash) | user + assistant | Inline confirm required. `deleteMode: "single"` removes just that message; `deleteMode: "chain"` splices from that index to the end |
| Branch (git branch) | user + assistant | Copies history up to and including the clicked message into a new session. Immediately switches to the new session |
| ← N/M → (swipe counter) | assistant only | Shown when `msg.swipes.length > 1`. Navigate between alternate generations. Updates `swipeIndex` and `content` in memory, then persists via `PUT /api/history/:id/messages` |
| Regen (↻) | assistant only | If the target is the **last** message: generates a new response and stores it as an additional swipe. If it's an **earlier** message: truncates history from that point and re-streams |

### Swipe System

Swipes are alternate assistant responses stored in-place on the message object. They are created by clicking Regen on the last assistant message.

```
First generation:  msg = { role:"assistant", content:"A", swipes: undefined }

After regen:       msg = { role:"assistant", content:"B", swipes: ["A", "B"], swipeIndex: 1 }

After another:     msg = { role:"assistant", content:"C", swipes: ["A", "B", "C"], swipeIndex: 2 }
```

Navigating swipes updates `msg.content` to `msg.swipes[newIndex]` and saves the full message array via `replaceMessages`. Context assembly always uses `msg.content`, so the displayed swipe is what gets sent to the model on the next turn.

**Mobile swipe gestures:** On touch devices, horizontal swipe on an assistant message navigates swipes (left = next, right = previous). Swiping right on the last assistant message when already at swipe index 0 triggers regeneration as a new swipe.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+K` / `Cmd+K` | Open command palette |
| `Escape` | Stop active stream |
| `←` / `→` | Navigate swipes on last assistant message (when no input focused) |
| `↑` | Edit last user message (when chat input empty and no input focused) |

### Auto-save Pattern

The character editor has **no Save button** — changes are persisted automatically 600 ms after the last keystroke (`scheduleAutoSave`). This is specific to the character editor. Chat message edits require explicit confirmation (Save/Cancel buttons in the edit bar).

---

## 13. Phase 2 Stubs

Phase 2 will implement secondary model tool calling (NemosGuides-style). The architecture is already prepared — the stubs are no-ops that will be replaced without requiring structural changes.

### What Phase 2 Will Do

The main model can call tools mid-generation. Each tool triggers a **sidecar call** to a configurable secondary model. Results are injected back into context — either ephemerally (visible only for the current response) or persistently (stored and always prepended in future turns).

This is based on NemoPresetExt's NemosGuides system. See the NemoPresetExt codebase for reference.

### Stub Locations

| Location | Stub | Phase 2 purpose |
|---|---|---|
| `lib/toolHooks.js` | `processRequest(messages, settings)` | Inject tool definitions into messages array before sending |
| `lib/toolHooks.js` | `onToken(token, context)` | Detect tool call syntax mid-stream |
| `lib/toolHooks.js` | `onStreamEnd(content, context)` | Parse completed tool calls, execute sidecar calls, inject results |
| `lib/toolHooks.js` | `onStreamStart(context)` | Initialize tool call accumulation buffer |
| `lib/streamProxy.js` | Three `toolHooks.*()` calls | Hook points in the proxy pipeline |
| `public/lib/assembler.js` | `applyPersistentInjections(messages)` | Prepend persistently stored tool results (scene state, etc.) |
| `data/history/*.json` | `metadata.toolCalls: []` | Record of tool calls per assistant message |

---

## 14. Known Limitations

| Area | Limitation |
|---|---|
| Lorebooks / World Info | Not implemented. WI entries from ST presets are imported as disabled system entries |
| Multiple characters per session | Not supported. One character per session |
| Session character name is denormalized | `characterName` in session metadata is written at creation time and not updated if the character is renamed |
| `injection_depth` with empty chat | Depth entries are injected after all chat messages; if chat is empty, all depth entries are appended together in stack order |
| No auth / multi-user | Designed for single local user. No authentication layer |
| API key storage | Stored in plaintext in `data/settings.json`. Keep `data/` out of any shared or public directory |
