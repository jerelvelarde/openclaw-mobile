// Glue between the clawg-ui pairing-state machine, the IPC bridge, and
// the macOS notification helper (P11B).
//
// Mirrors the shape of `main/pair/controller.ts` so a reader who knows
// the legacy 6-digit pairing surface can find their footing. The two
// controllers are deliberately independent: legacy pairing (P03B) is
// gated on `gateway_mode === "stub"`; clawg-ui pairing is gated on
// `gateway_mode === "clawg-ui"`. They coexist in `main/index.ts` but
// never run concurrently against the same renderer.

import type { BrowserWindow, IpcMain, Notification as ElectronNotification } from 'electron';
import type { ClawgUiPairingState } from '@openclaw/protocol';

import { runClawgUiPairingApprove, type ApprovePairingResult, type SpawnFn } from './cli';
import { existsSync } from 'node:fs';
import { ClawgUiPairingStateMachine } from './pairing-state';
import { CLAWG_UI_IPC } from '../../preload/ipc-channels';
import {
  showClawgUiPairingNotification,
  type ClawgUiNotificationDecision,
} from '../clawg-ui-notification';

/** Wiring options for `buildClawgUiPairingController`. */
export interface BuildControllerOptions {
  /** Injected Electron handles, the same way `pair/controller.ts` does it. */
  ipcMain: IpcMain;
  /** Callable that returns the renderer window to focus/route. */
  getWindow: () => BrowserWindow | null;
  /** Electron's `Notification` constructor, or `undefined` on non-macOS. */
  Notification?: typeof ElectronNotification;
  /**
   * Optional override for the `openclaw` binary path. The user can set
   * this in Settings when auto-detect fails (P11B follow-up). Today the
   * value comes from environment configuration only.
   */
  binaryPath?: string;
  /** Injected `child_process.spawn` for tests. */
  spawnFn?: SpawnFn;
  /** Injected fs-exists probe for tests; defaults to `existsSync`. */
  pathExists?: (p: string) => boolean;
  /**
   * Hook fired on every state transition. Wired in `main/index.ts` to
   * push the new state to any connected mobile peers via the existing
   * WS server.
   */
  onStateChange?: (state: ClawgUiPairingState) => void;
}

/** Surface returned to `main/index.ts`. */
export interface ClawgUiPairingController {
  /** The underlying state machine — exposed so transport code can subscribe. */
  state: ClawgUiPairingStateMachine;
  /**
   * Called by the runtime client (P11A) when a 403 pairing_pending
   * response arrives. Pops the notification (if available) and queues
   * the Settings banner via the state machine.
   */
  notifyPending(pairingCode: string): void;
  /** Drop IPC handlers — used by `app.will-quit`. */
  close(): void;
}

/**
 * Construct the controller and register the four IPC handlers the
 * preload bridge exposes. Returns a handle the main process holds onto
 * for the lifetime of the app.
 */
export function buildClawgUiPairingController(
  opts: BuildControllerOptions,
): ClawgUiPairingController {
  const state = new ClawgUiPairingStateMachine();

  // Broadcast state transitions to the renderer + the caller-supplied
  // hook (which forwards to mobile peers).
  state.subscribe((next) => {
    const win = opts.getWindow();
    win?.webContents.send(CLAWG_UI_IPC.PAIRING_STATE_EVENT, next);
    try {
      opts.onStateChange?.(next);
    } catch {
      // The broadcaster is best-effort; a thrown listener can't take
      // the state machine down.
    }
  });

  const pathExists = opts.pathExists ?? existsSync;

  async function approveByCode(pairingCode: string): Promise<ApprovePairingResult> {
    const result = await runClawgUiPairingApprove({
      pairingCode,
      pathExists,
      ...(opts.binaryPath ? { binaryPath: opts.binaryPath } : {}),
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    });
    if (result.ok) {
      state.setApproved();
    } else {
      state.setError(
        result.error ??
          `openclaw exited with code ${result.exitCode ?? 'null'}: ${result.stderr || result.stdout || 'unknown error'}`,
      );
    }
    return result;
  }

  function denyByCode(reason?: string): void {
    // clawg-ui has no reject RPC — we just flip the local state machine
    // so the banner disappears. The pairing code times out server-side
    // (10 minute TTL per `vendor/clawg-ui/src/http-handler.ts:285`).
    state.setDenied(reason);
  }

  // ---- IPC wiring -----------------------------------------------------
  opts.ipcMain.handle(
    CLAWG_UI_IPC.PAIRING_STATE_GET,
    async (): Promise<ClawgUiPairingState> => state.state,
  );

  opts.ipcMain.handle(
    CLAWG_UI_IPC.PAIRING_APPROVE,
    async (_event, pairingCode: string): Promise<ApprovePairingResult> => {
      return approveByCode(pairingCode);
    },
  );

  opts.ipcMain.handle(
    CLAWG_UI_IPC.PAIRING_DENY,
    async (_event, reason?: string): Promise<boolean> => {
      denyByCode(reason);
      return true;
    },
  );

  opts.ipcMain.handle(CLAWG_UI_IPC.PAIRING_DISMISS, async (): Promise<boolean> => {
    state.reset();
    return true;
  });

  function notifyPending(pairingCode: string): void {
    state.setPending(pairingCode);
    void showClawgUiPairingNotification({
      pairingCode,
      Notification: opts.Notification,
    }).then((decision: ClawgUiNotificationDecision) => {
      if (decision === 'approve') {
        void approveByCode(pairingCode);
      } else if (decision === 'deny') {
        denyByCode('user dismissed via notification');
      } else {
        // 'show-window' — bring the renderer to the Settings page so
        // the user can act on the banner.
        const win = opts.getWindow();
        if (win) {
          win.show();
          win.focus();
          win.webContents.send(CLAWG_UI_IPC.NAVIGATE_TO_SETTINGS, '/settings');
        }
      }
    });
  }

  return {
    state,
    notifyPending,
    close(): void {
      opts.ipcMain.removeHandler(CLAWG_UI_IPC.PAIRING_STATE_GET);
      opts.ipcMain.removeHandler(CLAWG_UI_IPC.PAIRING_APPROVE);
      opts.ipcMain.removeHandler(CLAWG_UI_IPC.PAIRING_DENY);
      opts.ipcMain.removeHandler(CLAWG_UI_IPC.PAIRING_DISMISS);
    },
  };
}
