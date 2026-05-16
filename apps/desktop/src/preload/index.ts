// Context-isolated bridge between the main and renderer processes.
//
// P02B scope: a single `ping()` method that returns "pong", just so the
// renderer can prove the IPC seam is wired. Real IPC surface (pairing,
// gateway lifecycle, etc.) lands in P03B+.

import { contextBridge } from 'electron';

const api = {
  /** Returns "pong". Smoke-test handle for the IPC bridge. */
  ping: (): string => 'pong',
} as const;

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
