// macOS native notification for clawg-ui pairing approval (P11B).
//
// Mirrors `./notifications.ts` (legacy 6-digit pairing notification),
// just with the clawg-ui copy + a single `pairingCode` payload field
// instead of a `PendingPair`. We deliberately keep a separate helper —
// the two UIs live side-by-side (the legacy pairing is our own Ed25519
// flow per P03B; clawg-ui pairing is the gateway-plugin handshake the
// desktop wraps in P11B) and a shared helper would have to discriminate
// on a `kind` field, adding noise without saving meaningful code.
//
// As with the legacy helper, we don't import Electron's `Notification`
// at module scope — vitest loads this module without an Electron
// runtime. Callers (the controller) inject the constructor.

import type { NotificationCtor, NotificationOptionsLike, NotificationLike } from './notifications';

export type ClawgUiNotificationDecision = 'approve' | 'deny' | 'show-window';

export interface ShowClawgUiPairingNotificationOptions {
  /** The pairing code received in the 403 response body. */
  pairingCode: string;
  /** Electron `Notification` ctor; omit on non-macOS / vitest. */
  Notification?: NotificationCtor;
  /** Override `process.platform` for tests. */
  platform?: NodeJS.Platform;
}

/**
 * Show a native notification asking the user to approve a clawg-ui
 * pairing-pending request. Returns the decision the user picked.
 *
 * Behaviour matches `showPairingNotification` — on non-darwin or when
 * no constructor is injected we resolve immediately with `'show-window'`
 * so the caller can pop the Settings page instead.
 */
export function showClawgUiPairingNotification(
  opts: ShowClawgUiPairingNotificationOptions,
): Promise<ClawgUiNotificationDecision> {
  const platform = opts.platform ?? process.platform;
  const NotificationImpl = opts.Notification;

  if (platform !== 'darwin' || !NotificationImpl) {
    return Promise.resolve('show-window');
  }
  if (typeof NotificationImpl.isSupported === 'function' && !NotificationImpl.isSupported()) {
    return Promise.resolve('show-window');
  }

  return new Promise<ClawgUiNotificationDecision>((resolve) => {
    let settled = false;
    const settle = (decision: ClawgUiNotificationDecision): void => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };

    const notificationOpts: NotificationOptionsLike = {
      title: 'OpenClaw gateway requested pairing',
      body: `New device wants to pair: code ${opts.pairingCode}.`,
      silent: false,
      actions: [
        { type: 'button', text: 'Approve' },
        { type: 'button', text: 'Deny' },
      ],
      closeButtonText: 'Later',
    };

    const notification: NotificationLike = new NotificationImpl(notificationOpts);

    notification.on('action', (...args: unknown[]) => {
      const index = typeof args[1] === 'number' ? args[1] : 0;
      settle(index === 0 ? 'approve' : 'deny');
    });
    notification.on('click', () => settle('show-window'));
    notification.on('close', () => settle('show-window'));

    notification.show();
  });
}
