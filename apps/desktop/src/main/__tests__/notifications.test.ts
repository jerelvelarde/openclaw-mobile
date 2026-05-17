// Notification helper unit tests.
//
// We stub Electron's `Notification` constructor with a tiny event-emitter
// shim so we can drive the `action` / `click` / `close` paths without an
// Electron runtime.

import { describe, expect, it, vi } from 'vitest';
import {
  NotificationCtor,
  NotificationLike,
  NotificationOptionsLike,
  showPairingNotification,
} from '../notifications';
import type { PendingPair } from '../pair/server';

function fakePair(): PendingPair {
  return {
    pair_id: 'pair-1',
    device_name: 'Test Phone',
    public_key: 'pk',
    code: '123456',
    expires_at: Date.now() + 10_000,
    status: 'pending',
  };
}

function buildFakeNotification(): {
  Notification: NotificationCtor;
  fire: (event: 'action' | 'click' | 'close', ...args: unknown[]) => void;
  shown: () => boolean;
} {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  let shown = false;
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
  const ctor = function Notification(_opts: NotificationOptionsLike) {
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
  };
}

describe('showPairingNotification', () => {
  it('resolves to "show-window" on non-darwin platforms', async () => {
    const decision = await showPairingNotification({
      pair: fakePair(),
      platform: 'linux',
    });
    expect(decision).toBe('show-window');
  });

  it('resolves to "show-window" when no Notification ctor is injected', async () => {
    const decision = await showPairingNotification({
      pair: fakePair(),
      platform: 'darwin',
    });
    expect(decision).toBe('show-window');
  });

  it('resolves to "approve" when the user clicks the first action button', async () => {
    const fake = buildFakeNotification();
    const promise = showPairingNotification({
      pair: fakePair(),
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('action', {}, 0);
    expect(fake.shown()).toBe(true);
    expect(await promise).toBe('approve');
  });

  it('resolves to "deny" when the user clicks the second action button', async () => {
    const fake = buildFakeNotification();
    const promise = showPairingNotification({
      pair: fakePair(),
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('action', {}, 1);
    expect(await promise).toBe('deny');
  });

  it('resolves to "show-window" when the notification body is clicked', async () => {
    const fake = buildFakeNotification();
    const promise = showPairingNotification({
      pair: fakePair(),
      platform: 'darwin',
      Notification: fake.Notification,
    });
    fake.fire('click');
    expect(await promise).toBe('show-window');
  });

  it('skips when isSupported() reports false', async () => {
    const fake = buildFakeNotification();
    const Notification = Object.assign(fake.Notification, { isSupported: vi.fn(() => false) });
    const decision = await showPairingNotification({
      pair: fakePair(),
      platform: 'darwin',
      Notification,
    });
    expect(decision).toBe('show-window');
  });
});
