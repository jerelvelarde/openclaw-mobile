// Ambient declaration for the `window.api` bridge exposed by `preload/index.ts`.
// The renderer imports this via the `tsconfig.web.json` include so that
// `window.api.ping()` typechecks without the renderer pulling in
// `electron` itself.

import type { DesktopApi } from './index';

declare global {
  interface Window {
    api: DesktopApi;
  }
}

export {};
