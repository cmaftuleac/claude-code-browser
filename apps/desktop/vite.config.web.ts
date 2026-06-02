/**
 * Plain Vite config for browser mode — serves the renderer at http://localhost:5173
 * without electron-vite/Electron. Proxies /ws and /fs/* to apps/server.
 *
 * Run with: npm run dev:web -w apps/desktop
 * Pairs with: npm run dev -w apps/server (server on :9315)
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const SERVER_PORT = Number(process.env.CCB_PORT ?? 9315);

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/fs': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
  },
});
