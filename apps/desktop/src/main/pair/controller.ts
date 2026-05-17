// Glue between the pairing HTTP server, the IPC channels exposed to the
// renderer, and the macOS notification.
//
// Lives in its own module so `main/index.ts` stays small and so the wiring
// can be exercised from a future integration test without booting Electron.

import type { BrowserWindow, IpcMain, Notification } from 'electron';
import { DeviceStore } from './store';
import { loadOrCreateSigningKey, SigningKey } from './keypair';
import { loadOrCreateGatewayId } from './gateway-id';
import { buildPairingServer, PairingServer, PendingPair } from './server';
import { showPairingNotification } from '../notifications';
import { IPC, PairedDeviceView, PendingPairView } from '../../preload/ipc-channels';

/** Public surface exposed by the controller. */
export interface PairingController {
  server: PairingServer;
  signingKey: SigningKey;
  gatewayId: string;
  deviceStore: DeviceStore;
  /** Tear down (close fastify, drop IPC handlers). */
  close(): Promise<void>;
}

export interface BuildControllerOptions {
  userDataDir: string;
  version: string;
  /** Required Electron handles. Injected for testability. */
  ipcMain: IpcMain;
  /** Callable that returns the renderer window to focus/route. */
  getWindow: () => BrowserWindow | null;
  /** Electron's `Notification` constructor, or `null` on non-macOS dev. */
  Notification?: typeof Notification;
  /**
   * Optional override for the `runtime_url` value returned by
   * `/pair/status` after approval. P04B passes the LAN URL when
   * `settings.lan_enabled` is true; tests + P03B-era callers leave it
   * `undefined` to use `RUNTIME_URL_PLACEHOLDER`.
   */
  runtimeUrl?: string;
  /**
   * Optional clawg-ui daemon base URL to echo to mobile in the approval
   * payload. Only set when the desktop is running in
   * `gateway_mode: "clawg-ui"`. Closes Q46 (mobile-side clawg-ui base
   * URL discovery).
   */
  clawgUiBaseUrl?: string;
}

function toPendingView(pair: PendingPair): PendingPairView {
  return {
    pair_id: pair.pair_id,
    device_name: pair.device_name,
    code: pair.code,
    expires_at: pair.expires_at,
  };
}

/**
 * Construct the pairing controller, register IPC handlers, and return a
 * handle the main process can use to start the fastify listener.
 */
export async function buildPairingController(
  opts: BuildControllerOptions,
): Promise<PairingController> {
  const signingKey = await loadOrCreateSigningKey(opts.userDataDir);
  const gatewayId = loadOrCreateGatewayId(opts.userDataDir);
  const deviceStore = new DeviceStore(opts.userDataDir);

  const server = buildPairingServer({
    signingKey: {
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      publicKeyPem: signingKey.publicKeyPem,
    },
    gatewayId,
    deviceStore,
    version: opts.version,
    runtimeUrl: opts.runtimeUrl,
    ...(opts.clawgUiBaseUrl !== undefined ? { clawgUiBaseUrl: opts.clawgUiBaseUrl } : {}),
    onPendingPair: (pair) => {
      const view = toPendingView(pair);
      // 1. Push the event to the renderer so an open modal updates.
      const win = opts.getWindow();
      win?.webContents.send(IPC.PAIRING_PENDING_EVENT, view);
      // 2. Show the native notification (macOS) or just nudge the window.
      void showPairingNotification({
        pair,
        Notification: opts.Notification,
      }).then((decision) => {
        if (decision === 'approve') {
          server.approve(pair.pair_id);
        } else if (decision === 'deny') {
          server.deny(pair.pair_id);
        } else {
          // 'show-window' — bring the renderer to the front and route to
          // the approve page.
          const w = opts.getWindow();
          if (w) {
            w.show();
            w.focus();
            w.webContents.send(IPC.NAVIGATE, '/approve');
          }
        }
        // Whichever path resolved this pair, fire another pending event
        // so any open ApprovePairing component refreshes its queue.
        const w = opts.getWindow();
        w?.webContents.send(IPC.PAIRING_PENDING_EVENT, view);
      });
    },
  });

  // ---- IPC wiring -----------------------------------------------------
  opts.ipcMain.handle(IPC.PAIRING_LIST_PENDING, async (): Promise<PendingPairView[]> => {
    return server.pending.listPending().map(toPendingView);
  });

  opts.ipcMain.handle(IPC.PAIRING_APPROVE, async (_event, pairId: string): Promise<boolean> => {
    return server.approve(pairId) !== null;
  });

  opts.ipcMain.handle(IPC.PAIRING_DENY, async (_event, pairId: string): Promise<boolean> => {
    return server.deny(pairId) !== null;
  });

  opts.ipcMain.handle(IPC.PAIRING_LIST_DEVICES, async (): Promise<PairedDeviceView[]> => {
    return deviceStore.listDevices();
  });

  opts.ipcMain.handle(
    IPC.PAIRING_REVOKE_DEVICE,
    async (_event, deviceId: string): Promise<boolean> => {
      deviceStore.revokeDevice(deviceId);
      return true;
    },
  );

  return {
    server,
    signingKey,
    gatewayId,
    deviceStore,
    async close(): Promise<void> {
      opts.ipcMain.removeHandler(IPC.PAIRING_LIST_PENDING);
      opts.ipcMain.removeHandler(IPC.PAIRING_APPROVE);
      opts.ipcMain.removeHandler(IPC.PAIRING_DENY);
      opts.ipcMain.removeHandler(IPC.PAIRING_LIST_DEVICES);
      opts.ipcMain.removeHandler(IPC.PAIRING_REVOKE_DEVICE);
      await server.fastify.close();
    },
  };
}
