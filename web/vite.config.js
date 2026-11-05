import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // served from https://mgschwend.github.io/screenrate/
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
