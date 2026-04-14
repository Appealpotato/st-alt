import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

import settingsRouter, { migrateIfNeeded } from './routes/settings.js';
import connectionsRouter   from './routes/connections.js';
import promptPresetsRouter from './routes/promptPresets.js';
import promptsRouter       from './routes/prompts.js';
import charactersRouter    from './routes/characters.js';
import modelsRouter        from './routes/models.js';
import historyRouter       from './routes/history.js';
import chatRouter          from './routes/chat.js';
import { ensureDataFiles, readJSON, dataPath } from './lib/fileStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PKG = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));

await ensureDataFiles();
// Run settings migration before serving any requests so all routes see the new schema
try {
  const settings = await readJSON(dataPath('settings.json'));
  await migrateIfNeeded(settings);
} catch (err) {
  console.warn('[startup] Settings migration failed:', err.message);
}

const app = express();

app.use(express.json({ limit: '50mb' }));
app.use('/avatars', express.static(path.join(__dirname, 'data', 'avatars')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/settings',       settingsRouter);
app.use('/api/connections',    connectionsRouter);
app.use('/api/prompt-presets', promptPresetsRouter);
app.use('/api/prompts',        promptsRouter);
app.use('/api/characters',     charactersRouter);
app.use('/api/models',         modelsRouter);
app.use('/api/history',        historyRouter);
app.use('/api/chat',           chatRouter);

app.get('/api/version', (_req, res) => res.json({ version: PKG.version, name: PKG.name }));

// Catch validation / safePath errors and return their status code
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`st-alt running at http://localhost:${PORT}`);
});
