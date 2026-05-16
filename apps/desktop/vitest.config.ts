// Vitest config for the renderer. The main + preload processes don't have
// unit tests yet — they're thin glue around Electron APIs that are easier
// to cover via the eventual e2e setup (P09B+).
//
// `environment: 'jsdom'` lets us render <App /> with @testing-library/react.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/renderer/**/__tests__/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
