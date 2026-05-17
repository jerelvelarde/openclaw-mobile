// Native pairing-approval notifications.
//
// Per P03B step 6: on macOS we surface incoming pairing requests with an
// Electron `Notification` that carries [Approve] / [Deny] buttons. The
// notification's `action` event fires when the user clicks a button; we
// fall back to the `click` event (notification body) for platforms that
// don't expose action buttons. On non-macOS the renderer modal is the
// only path, so this helper short-circuits to a no-op except for an
// optional "focus the window" hook the caller wires up.
//
// We deliberately don't import Electron's `Notification` at module scope
// because the pair modules need to be loadable from vitest (which doesn't
// have an Electron runtime). Instead the caller injects the constructor.

import type { PendingPair } from './pair/server';

/**
 * Subset of Electron's `Notification` API we depend on. Declared
 * structurally so we can inject a stub from tests + so we don't pull the
 * full Electron type graph into modules that vitest needs to load.
 */
export interface NotificationLike {
  on(event: 'click' | 'close' | 'action', handler: (...args: unknown[]) => void): this;
  show(): void;
}

/** Constructor signature compatible with Electron's `new Notification(opts)`. */
export interface NotificationCtor {
  new (opts: NotificationOptionsLike): NotificationLike;
  isSupported?: () => boolean;
}

/** Minimal `NotificationConstructorOptions` we use. */
export interface NotificationOptionsLike {
  title: string;
  body: string;
  silent?: boolean;
  actions?: Array<{ type: 'button'; text: string }>;
  closeButtonText?: string;
}

/** Resolution emitted when the user clicks a notification button. */
export type PairingDecision = 'approve' | 'deny' | 'show-window';

export interface ShowPairingNotificationOptions {
  /** Pending pair entry the user is asked about. */
  pair: PendingPair;
  /**
   * Injected Electron `Notification` constructor. If absent (e.g. running
   * under vitest without Electron) the call resolves immediately with
   * `'show-window'` so the caller can still bring the renderer modal to
   * the front.
   */
  Notification?: NotificationCtor;
  /** Override `process.platform` for tests. */
  platform?: NodeJS.Platform;
}

/**
 * Show a native notification asking the user to approve a pairing
 * request. Returns the decision the user picked. On non-macOS platforms
 * (or if Electron `Notification` is unsupported / not injected), the
 * function resolves immediately with `'show-window'` to indicate that
 * the renderer modal must drive the decision.
 *
 * The promise resolves only once the notification is dismissed; the
 * caller should treat a `'show-window'` resolution as "user didn't pick
 * via the notification — pivot to the modal".
 */
export function showPairingNotification(
  opts: ShowPairingNotificationOptions,
): Promise<PairingDecision> {
  const platform = opts.platform ?? process.platform;
  const NotificationImpl = opts.Notification;

  // On non-macOS the renderer modal is the only path per P03B.
  if (platform !== 'darwin' || !NotificationImpl) {
    return Promise.resolve('show-window');
  }
  if (typeof NotificationImpl.isSupported === 'function' && !NotificationImpl.isSupported()) {
    return Promise.resolve('show-window');
  }

  return new Promise<PairingDecision>((resolve) => {
    let settled = false;
    const settle = (decision: PairingDecision): void => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    const notification = new NotificationImpl({
      title: 'OpenClaw — pairing request',
      body: `${opts.pair.device_name} wants to pair (code ${opts.pair.code}).`,
      silent: false,
      actions: [
        { type: 'button', text: 'Approve' },
        { type: 'button', text: 'Deny' },
      ],
      closeButtonText: 'Later',
    });

    notification.on('action', (...args: unknown[]) => {
      const index = typeof args[1] === 'number' ? args[1] : 0;
      settle(index === 0 ? 'approve' : 'deny');
    });
    notification.on('click', () => settle('show-window'));
    notification.on('close', () => settle('show-window'));

    notification.show();
  });
}
