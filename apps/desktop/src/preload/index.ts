// Context-isolated bridge between the main and renderer processes.
//
// P02B exposed a single `ping()` smoke-test handle. P03B adds the
// pairing surface: list pending pairs, approve/deny by pair_id, and
// list/revoke approved devices. Plus a subscription seam for the
// "new pending pair" event that the main process fires when a
// pairing request comes in over HTTP.
//
// Everything routes through ipcRenderer; the channel names live in
// `./ipc-channels.ts` so main + preload can share them.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, PairedDeviceView, PendingPairView, SettingsView } from './ipc-channels';

const api = {
  /** Returns "pong". Smoke-test handle for the IPC bridge. */
  ping: (): string => 'pong',

  pairing: {
    /** Return the list of currently-pending pairing requests. */
    listPending: async (): Promise<PendingPairView[]> => {
      return (await ipcRenderer.invoke(IPC.PAIRING_LIST_PENDING)) as PendingPairView[];
    },
    /** Approve a pending pair. Resolves to `true` on success. */
    approve: async (pairId: string): Promise<boolean> => {
      return (await ipcRenderer.invoke(IPC.PAIRING_APPROVE, pairId)) as boolean;
    },
    /** Deny a pending pair. Resolves to `true` on success. */
    deny: async (pairId: string): Promise<boolean> => {
      return (await ipcRenderer.invoke(IPC.PAIRING_DENY, pairId)) as boolean;
    },
    /** Return the list of currently-approved devices. */
    listDevices: async (): Promise<PairedDeviceView[]> => {
      return (await ipcRenderer.invoke(IPC.PAIRING_LIST_DEVICES)) as PairedDeviceView[];
    },
    /** Revoke an approved device. */
    revokeDevice: async (deviceId: string): Promise<boolean> => {
      return (await ipcRenderer.invoke(IPC.PAIRING_REVOKE_DEVICE, deviceId)) as boolean;
    },
    /**
     * Subscribe to "new pending pair" events. Returns an unsubscribe fn
     * the caller invokes on unmount.
     */
    onPending: (handler: (pair: PendingPairView) => void): (() => void) => {
      const listener = (_event: unknown, pair: PendingPairView): void => handler(pair);
      ipcRenderer.on(IPC.PAIRING_PENDING_EVENT, listener);
      return () => {
        ipcRenderer.removeListener(IPC.PAIRING_PENDING_EVENT, listener);
      };
    },
    /**
     * Subscribe to navigation events from main (e.g. "show the pending
     * pair modal" when the tray entry is clicked).
     */
    onNavigate: (handler: (route: string) => void): (() => void) => {
      const listener = (_event: unknown, route: string): void => handler(route);
      ipcRenderer.on(IPC.NAVIGATE, listener);
      return () => {
        ipcRenderer.removeListener(IPC.NAVIGATE, listener);
      };
    },
  },

  settings: {
    /** Return the current persisted settings. */
    get: async (): Promise<SettingsView> => {
      return (await ipcRenderer.invoke(IPC.SETTINGS_GET)) as SettingsView;
    },
  },
} as const;

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
