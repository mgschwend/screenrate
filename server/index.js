// Entry point. Config by environment: DATA_DIR, WEB_DIR, TMDB_API_KEY, PORT, INSECURE_COOKIES=1 (localhost only).
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app.js';
import { openStore } from './store.js';

const dataDir = process.env.DATA_DIR || '/data';
const webDir = process.env.WEB_DIR || '/app/web';
const port = Number(process.env.PORT || 8080);

const store = openStore(join(dataDir, 'app.sqlite'));
const handle = createApp({
  store, dataDir, webDir, tmdbKey: process.env.TMDB_API_KEY || '', secure: process.env.INSECURE_COOKIES !== '1',
});

const backup = () => { try { store.backup(join(dataDir, 'backups')); } catch (e) { console.error('backup failed', e); } };
backup();
setInterval(backup, 3_600_000).unref();

const server = createServer(handle).listen(port, () => console.log(`ScreenRate on :${port}`));
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
