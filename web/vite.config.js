import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Emit sw.js with the list of built assets so the app shell works offline. */
function serviceWorker() {
  return {
    name: 'screenrate-sw',
    apply: 'build',
    generateBundle(_, bundle) {
      const assets = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const publicFiles = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
      const list = [...assets, ...publicFiles].filter((f) => f !== 'imdb.sqlite.enc' && !/sqlite3-(worker1|opfs)/.test(f));
      const version = createHash('sha256').update(list.sort().join('|')).digest('hex').slice(0, 12);
      const src = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__ASSETS__', JSON.stringify(list.map((f) => `./${f}`)));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  base: './', // served from https://mgschwend.github.io/screenrate/
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  plugins: [serviceWorker()],
});
