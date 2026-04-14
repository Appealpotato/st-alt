# st-alt

Minimal LLM chat frontend for roleplay and collaborative fiction. Runs locally, stores everything as flat JSON — no database, no build step.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later

## Setup

1. Download or clone this repository.
2. Unzip if needed, then open the `st-alt` folder.
3. Open a terminal in that folder.
   - **Windows:** in File Explorer's address bar, type `cmd` and press Enter.
   - **macOS / Linux:** right-click the folder → *Open in Terminal*.
4. Install dependencies and start the server:
   ```bash
   npm install
   npm run dev
   ```
5. Open **http://localhost:3001/** in your browser.

On first run, open the **Settings** tab → **Connection** and add a preset (provider, API key, model) before starting a chat.

## Scripts

- `npm run dev` — runs with `--watch`; restarts on file changes.
- `npm start` — runs without watch.
