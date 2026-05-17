// Tests for the clawg-ui pairing native notification (P11B).
//
// Mirrors `notifications.test.ts` — drives the fake Notification
// constructor's events and asserts the resolved decision.

import { describe, expect, it, vi } from 'vitest';
import { showClawgUiPairingNotification } from '../clawg-ui-notification';
import type { NotificationCtor, NotificationLike, NotificationOptionsLike } from '../notifications';

function buildFakeNotification(): {
  Notification: NotificationCtor;
  fire: (event: 'action' | 'click' | 'close', ...args: unknown[]) => void;
  shown: () => boolean;
  lastOpts: () => NotificationOptionsLike | undefined;
} {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let shown = false;
  let lastOpts: NotificationOptionsLike | undefined;
  const instance: NotificationLike = {
    on(event, handler) {
      listeners[event] = listeners[event] ?? [];
      listeners[event]!.push(handler);
      return this;
    },
    show() {
      shown = true;
    },
  };
  const ctor = function Notification(opts: NotificationOptionsLike) {
    lastOpts = opts;
    return instance;
  } as unknown as NotificationCtor;
  return {
    Notification: ctor,
    fire(event, ...args) {
      for (const handler of listeners[event] ?? []) {
        handler(...args);
      }
    },
    shown: () => shown,
    lastOpts: () => lastOpts,
  };
}

describe('showClawgUiPairingNotification', () => {
  it('resolves to show-window on non-darwin', async () => {
    const decision = await showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'linux',
    });
    expect(decision).toBe('show-window');
  });

  it('resolves to show-window when no Notification ctor is injected', async () => {
    const decision = await showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
    });
    expect(decision).toBe('show-window');
  });

  it('uses the new-device copy + includes the pairing code in the body', async () => {
    const fake = buildFakeNotification();
    const promise = showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('action', {}, 0);
    await promise;
    const opts = fake.lastOpts();
    expect(opts?.title).toContain('gateway');
    expect(opts?.body).toContain('ABCD1234');
    expect(opts?.actions).toEqual([
      { type: 'button', text: 'Approve' },
      { type: 'button', text: 'Deny' },
    ]);
  });

  it('resolves to approve when the user clicks the first button', async () => {
    const fake = buildFakeNotification();
    const promise = showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('action', {}, 0);
    expect(fake.shown()).toBe(true);
    expect(await promise).toBe('approve');
  });

  it('resolves to deny when the user clicks the second button', async () => {
    const fake = buildFakeNotification();
    const promise = showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('action', {}, 1);
    expect(await promise).toBe('deny');
  });

  it('falls back to show-window on body click', async () => {
    const fake = buildFakeNotification();
    const promise = showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('click');
    expect(await promise).toBe('show-window');
  });

  it('skips when isSupported() reports false', async () => {
    const fake = buildFakeNotification();
    const Notification = Object.assign(fake.Notification, { isSupported: vi.fn(() => false) });
    const decision = await showClawgUiPairingNotification({
      pairingCode: 'ABCD1234',
      platform: 'darwin',
      Notification,
    });
    expect(decision).toBe('show-window');
  });
});
