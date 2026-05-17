// Controller IPC + notification contract (P11B).
//
// Drives the controller through a fake `ipcMain` so we can assert which
// channels are registered + what payloads they accept. Uses a stubbed
// `spawn` so we never touch a real binary.

import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { ClawgUiPairingState } from '@openclaw/protocol';
import { buildClawgUiPairingController } from '../controller';
import { CLAWG_UI_IPC } from '../../../preload/ipc-channels';
import type { ChildProcessLike, SpawnFn } from '../cli';
import { EventEmitter } from 'node:events';

function buildFakeChild(): ChildProcessLike & {
  finish(code: number | null): void;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const lifecycle = new EventEmitter();
  const child = {
    stdout: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => stdout.on(event, cb) },
    stderr: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => stderr.on(event, cb) },
    on(event: 'error' | 'close', cb: (...args: unknown[]) => void) {
      lifecycle.on(event, cb);
    },
    kill(): boolean {
      return true;
    },
    finish(code: number | null): void {
      lifecycle.emit('close', code, null);
    },
  };
  return child as ReturnType<typeof buildFakeChild>;
}

function buildFakeIpcMain(): {
  ipcMain: IpcMain;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  registered: () => string[];
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle(channel: string, fn: (...args: unknown[]) => unknown): void {
      handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
      handlers.delete(channel);
    },
  } as unknown as IpcMain;
  return {
    ipcMain,
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      // Replicate Electron's `_event` first arg + the original args.
      return handler({}, ...args);
    },
    registered: () => Array.from(handlers.keys()),
  };
}

describe('buildClawgUiPairingController', () => {
  it('registers the four IPC channels', () => {
    const ipc = buildFakeIpcMain();
    buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
    });
    expect(ipc.registered().sort()).toEqual(
      [
        CLAWG_UI_IPC.PAIRING_APPROVE,
        CLAWG_UI_IPC.PAIRING_DENY,
        CLAWG_UI_IPC.PAIRING_DISMISS,
        CLAWG_UI_IPC.PAIRING_STATE_GET,
      ].sort(),
    );
  });

  it('starts in idle and returns it via PAIRING_STATE_GET', async () => {
    const ipc = buildFakeIpcMain();
    buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
    });
    const state = await ipc.invoke(CLAWG_UI_IPC.PAIRING_STATE_GET);
    expect(state).toEqual({ status: 'idle' });
  });

  it('forwards onStateChange + emits to subscribers on notifyPending', () => {
    const ipc = buildFakeIpcMain();
    const onStateChange = vi.fn();
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
      onStateChange,
    });
    controller.notifyPending('ABCD1234');
    expect(onStateChange).toHaveBeenCalledWith({
      status: 'pending',
      pairingCode: 'ABCD1234',
    });
  });

  it('approve flow: spawns the CLI, transitions to approved, returns result', async () => {
    const ipc = buildFakeIpcMain();
    const child = buildFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
      spawnFn,
      pathExists: () => true,
      binaryPath: '/usr/local/bin/openclaw',
    });
    controller.notifyPending('ABCD1234');

    const resultPromise = ipc.invoke(CLAWG_UI_IPC.PAIRING_APPROVE, 'ABCD1234');
    child.finish(0);
    const result = (await resultPromise) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(controller.state.state).toEqual({ status: 'approved' });
  });

  it('approve failure: transitions to error with the captured message', async () => {
    const ipc = buildFakeIpcMain();
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
      // Force the path probe to fail so the CLI bails before spawn.
      pathExists: () => false,
      binaryPath: '/definitely/not/here/openclaw',
    });
    controller.notifyPending('ABCD1234');
    const result = (await ipc.invoke(CLAWG_UI_IPC.PAIRING_APPROVE, 'ABCD1234')) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    const state = controller.state.state as ClawgUiPairingState;
    expect(state.status).toBe('error');
  });

  it('deny flow: transitions to denied with reason', async () => {
    const ipc = buildFakeIpcMain();
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
    });
    controller.notifyPending('ABCD1234');
    const ok = (await ipc.invoke(CLAWG_UI_IPC.PAIRING_DENY, 'nope')) as boolean;
    expect(ok).toBe(true);
    expect(controller.state.state).toEqual({ status: 'denied', reason: 'nope' });
  });

  it('dismiss flow: resets to idle', async () => {
    const ipc = buildFakeIpcMain();
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
    });
    controller.notifyPending('ABCD1234');
    controller.state.setApproved();
    const ok = (await ipc.invoke(CLAWG_UI_IPC.PAIRING_DISMISS)) as boolean;
    expect(ok).toBe(true);
    expect(controller.state.state).toEqual({ status: 'idle' });
  });

  it('close() removes all registered handlers', () => {
    const ipc = buildFakeIpcMain();
    const controller = buildClawgUiPairingController({
      ipcMain: ipc.ipcMain,
      getWindow: () => null,
    });
    expect(ipc.registered().length).toBeGreaterThan(0);
    controller.close();
    expect(ipc.registered()).toEqual([]);
  });
});
