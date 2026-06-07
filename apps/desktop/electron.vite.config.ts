import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // Bundle the workspace `shared` package into the main bundle instead of
    // externalizing it: it's ESM-only ("type":"module", and its exports map has
    // no `require` condition), so a CJS `require()` from the built main fails
    // (ERR_PACKAGE_PATH_NOT_EXPORTED). It's pure TS with no native deps, so
    // bundling is safe. agent-core stays external (dynamically imported as ESM).
    plugins: [externalizeDepsPlugin({ exclude: ['@fineguide-tesseract/shared'] })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        // Two preloads: the main-window bridge and the <webview> guest editor.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          editor: resolve(__dirname, 'src/preload/editor.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
