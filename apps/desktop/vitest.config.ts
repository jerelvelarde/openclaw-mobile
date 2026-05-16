// Vitest config covering the renderer (jsdom) + the main-process pairing
// modules (node). The renderer tests live under `src/renderer/.../__tests__`;
// the main tests live under `src/main/.../__tests__`. Each gets the
// environment it needs via `environmentMatchGlobs`.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/renderer/**/__tests__/**/*.test.{ts,tsx}', 'src/main/**/*.test.ts'],
    environmentMatchGlobs: [
      ['src/renderer/**', 'jsdom'],
      ['src/main/**', 'node'],
    ],
    globals: false,
    // Auto-unmount renderer trees between tests so `getByRole` doesn't
    // match leftover DOM from the previous `render()`. Scoped to
    // renderer files via the path filter — main-process tests run in
    // `node` and don't import React.
    setupFiles: ['./src/renderer/test-setup.ts'],
  },
});
