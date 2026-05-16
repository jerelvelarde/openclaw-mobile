import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite splits the build into three roots:
//   - `main`     → Node/Electron main process     (out/main/index.js)
//   - `preload`  → context-isolated bridge        (out/preload/index.js)
//   - `renderer` → the React UI                   (out/renderer/)
//
// `root` for the renderer is `src/renderer` so its `index.html` can sit there
// alongside the React entry. The web tsconfig (tsconfig.web.json) covers it.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
});
