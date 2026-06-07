import { defineConfig } from 'vitest/config';

// Unit tests for pure logic across the workspace. Tests import the module under
// test by RELATIVE path (e.g. `../frame`) so vitest's resolver doesn't need the
// workspace package aliases, and the tested modules are kept free of
// import-time side effects (no port binding, no env reads at module scope).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
