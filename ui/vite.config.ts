import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  root: __dirname,
  plugins: [react()],
  base: command === 'serve' ? '/' : '/ui/',
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/healthz': 'http://127.0.0.1:21100',
      '/v1': 'http://127.0.0.1:21100',
    },
  },
}));
