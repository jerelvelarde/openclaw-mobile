// Minimal wrapper around `expo-server-sdk`.
//
// Per P08B step 3: we wrap Expo's `Expo` class so the rest of the push
// module (dispatch, route handler, tests) can depend on a tiny surface
// rather than the full SDK. Two reasons:
//
//   1. The SDK is ESM-only and the constructor allocates an HTTP agent +
//      undici pool eagerly. Hiding it behind a factory lets us defer the
//      allocation, lets us swap in a fake `Expo` from tests with no
//      module-level mocking gymnastics, and keeps the dispatcher free
//      of `import('expo-server-sdk')` calls that fight with vitest's
//      module mocking.
//
//   2. We want `sendNotification({token, title, body, data})` rather
//      than the SDK's `sendPushNotificationsAsync([{ to, title, ... }])`
//      so the dispatcher reads naturally. Chunking is handled here —
//      callers can send a single message and we'll still do the
//      `chunkPushNotifications` dance for forwards compat with future
//      bulk sends.
//
// Receipt polling: per the plan, fire-and-forget for v1. We collect the
// ticket ids returned by `sendPushNotificationsAsync` and just log
// errors. The receipt-polling endpoint is documented in the README and
// we'll wire it in a later plan once we have a place to surface
// "DeviceNotRegistered" feedback (revoking dead tokens automatically).

import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

/** Single notification payload the dispatcher builds. */
export interface PushNotification {
  /** Expo push token (`ExponentPushToken[...]`). */
  token: string;
  /** Notification title — typically the agent name. */
  title: string;
  /** Notification body — typically a one-line snippet. */
  body: string;
  /**
   * Deep-link payload mobile receives in the notification handler. Kept
   * generic so dispatch can stuff `{ threadId, sessionId, kind }` etc.
   */
  data?: Record<string, unknown>;
  /** Optional channel id for Android. Defaults to undefined (system default). */
  channelId?: string;
}

/**
 * Outcome of `sendNotification`. We surface tickets so tests can assert
 * what was actually sent, and so a follow-up receipt-poller has the ids
 * to query. Errors thrown by the SDK (network, auth) are caught and
 * surfaced via `error` rather than re-thrown — the dispatcher must not
 * crash on a single failed push.
 */
export interface PushSendResult {
  tickets: ExpoPushTicket[];
  error?: Error;
}

/** Public surface returned by `createPushClient`. */
export interface PushClient {
  sendNotification(notif: PushNotification): Promise<PushSendResult>;
  /**
   * Bulk variant — sends multiple notifications in chunks. Same return
   * shape, with one ticket per message in the same order they arrived.
   */
  sendNotifications(notifs: PushNotification[]): Promise<PushSendResult>;
  /** Validate the shape of a token before storing it. */
  isExpoPushToken(token: unknown): token is string;
}

/**
 * Constructor injection for the underlying SDK class. Production wires
 * the real `expo-server-sdk` `Expo` class in; tests pass a fake.
 *
 * The shape matches `expo-server-sdk@6`'s ESM export — we just need the
 * subset we actually call. Marking it `unknown` would force casts on
 * every test fake; this typed alias keeps both ends honest.
 */
export interface ExpoSdkLike {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
}

export interface ExpoSdkCtor {
  new (options?: { accessToken?: string }): ExpoSdkLike;
  isExpoPushToken(token: unknown): boolean;
}

/** Options accepted by `createPushClient`. */
export interface PushClientOptions {
  /**
   * Optional access token. Required for projects that have enabled the
   * "Enhanced Security for Push Notifications" toggle in the Expo
   * dashboard. We treat the env var as the source of truth so packagers
   * can rotate without rebuilding.
   */
  accessToken?: string;
  /**
   * Injected SDK class. Default: the real `expo-server-sdk` Expo class.
   * Tests pass a fake so we don't reach out to expo.dev.
   */
  expoClass?: ExpoSdkCtor;
  /**
   * Logger sink — defaults to `console.warn` for receipts / send errors.
   * Tests inject a stub to assert what was logged.
   */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/**
 * Build a push client. The real `Expo` class is imported lazily inside
 * the factory so importing this module from a unit test that *only*
 * uses a fake `expoClass` doesn't fault on missing native deps.
 */
export async function createPushClient(opts: PushClientOptions = {}): Promise<PushClient> {
  const log = opts.logger ?? defaultLogger;
  let ExpoCtor: ExpoSdkCtor;
  if (opts.expoClass) {
    ExpoCtor = opts.expoClass;
  } else {
    // Dynamic import keeps the ESM-only `expo-server-sdk` out of the
    // bundle until something actually needs to send a push.
    const mod = (await import('expo-server-sdk')) as unknown as {
      Expo?: ExpoSdkCtor;
      default?: ExpoSdkCtor;
    };
    const ctor = mod.Expo ?? mod.default;
    if (!ctor) throw new Error('expo-server-sdk: Expo class not found in module exports');
    ExpoCtor = ctor;
  }
  const expo = new ExpoCtor({ accessToken: opts.accessToken });

  async function send(notifs: PushNotification[]): Promise<PushSendResult> {
    if (notifs.length === 0) return { tickets: [] };
    const messages: ExpoPushMessage[] = notifs.map((n) => ({
      to: n.token,
      title: n.title,
      body: n.body,
      data: n.data,
      sound: 'default',
      priority: 'high',
      channelId: n.channelId,
    }));
    const chunks = expo.chunkPushNotifications(messages);
    const tickets: ExpoPushTicket[] = [];
    let lastError: Error | undefined;
    for (const chunk of chunks) {
      try {
        const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...chunkTickets);
        // Fire-and-forget receipt logging. Per the plan we don't poll
        // receipts in v1, but ticket-level errors come back here
        // synchronously and are worth surfacing.
        for (const t of chunkTickets) {
          if (t.status === 'error') {
            log('warn', '[push] expo ticket error', t);
          }
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        log('error', '[push] sendPushNotificationsAsync threw', lastError.message);
        // Continue with the remaining chunks — a single failure shouldn't
        // sink the rest of the batch.
      }
    }
    return lastError ? { tickets, error: lastError } : { tickets };
  }

  return {
    sendNotification(notif) {
      return send([notif]);
    },
    sendNotifications(notifs) {
      return send(notifs);
    },
    isExpoPushToken(token): token is string {
      return typeof token === 'string' && ExpoCtor.isExpoPushToken(token);
    },
  };
}

function defaultLogger(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  // eslint-disable-next-line no-console
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) sink(msg, meta);
  else sink(msg);
}
