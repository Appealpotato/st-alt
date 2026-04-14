# Claude Instructions for st-alt

## Project overview

st-alt is a locally-run LLM chat frontend for roleplay/collaborative fiction — a SillyTavern alternative. Node/Express backend, vanilla JS ES module frontend, flat JSON persistence. No build step.

See `DOCS.md` in the project root for the full technical reference: API endpoints, data schemas, architecture, and prompt assembly.

## Coding conventions

- **Vanilla JS only** — no frameworks (React, Vue, etc.), no bundlers, no TypeScript. Browser-native ESM.
- **CSS custom properties** for all theming and configurable display values. No inline style hacks.
- **No build step** — changes to `public/` are immediately live. Don't introduce anything that requires compilation.
- Express routes in `routes/`, frontend views in `public/views/`, shared frontend utilities in `public/lib/`.
- Flat JSON files in `data/` — no database.

## Response style

- Concise responses. Don't summarize what was done — the user can read the diff.
- No trailing "Here's what I changed" paragraphs.

## Keeping DOCS.md current

Any task that adds, removes, or changes an API endpoint, data schema, UI component, or frontend module is **not complete** until the relevant section of `DOCS.md` is updated to reflect it.

## After completing any feature or fix

1. **Update `project_context.md`** in memory if the feature state changed — add it to the "Implemented" list or remove it from "Not implemented".

2. **Create a `feedback_*.md`** memory file if a new non-obvious pattern was established or a non-obvious bug was caught. Only create one if it's genuinely reusable — not for one-off fixes. Update `MEMORY.md` index accordingly.

Memory lives at: `C:\Users\appl\.claude\projects\C--Users-appl-Desktop-ST-work-st-alt\memory\`
