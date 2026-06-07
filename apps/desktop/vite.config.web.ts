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
// apps/api (the cloud API / fineguide.ai mock) — /auth + /fineguide proxy to it in dev.
const API_PORT = Number(process.env.CCB_API_PORT ?? 9320);
// Only set in the Docker dev stack (docker-compose.dev.yml). When present, Vite's
// HMR websocket must dial back through the public nginx gateway port rather than
// the internal 5173 — otherwise the browser, talking to the gateway, can't reach
// HMR. Left undefined for plain local `npm run dev:web` so default HMR keeps working.
const GATEWAY_PORT = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : undefined;

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  server: {
    host: true, // bind 0.0.0.0 so the dev server is reachable from the gateway container
    port: 5173,
    ...(GATEWAY_PORT ? { hmr: { clientPort: GATEWAY_PORT } } : {}),
    proxy: {
      '/ws': { target: `ws://localhost:${SERVER_PORT}`, ws: true },
      '/fs': { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      // Auth + federated identity live in apps/api (or its fineguide.ai mock). In the
      // Docker stack the nginx gateway routes these; for plain `dev:web` we proxy here
      // (otherwise every /auth + /fineguide request 404s against the Vite dev server).
      '/auth': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
      '/fineguide': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
  },
});
