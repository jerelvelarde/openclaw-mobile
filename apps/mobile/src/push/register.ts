// Expo push registration for the mobile app.
//
// Lifecycle (driven by `PairingProvider` once `state.status === 'paired'`):
//
//   1. Ask for the OS notification permission. On iOS this fires the
//      well-known "Allow Notifications?" prompt; on Android 13+ the
//      `POST_NOTIFICATIONS` runtime grant. We ask for the basic alert /
//      badge / sound entitlements only — fancier categories can land later.
//   2. Fetch an Expo push token via `getExpoPushTokenAsync()`. Expo's
//      service abstracts APNs/FCM so the desktop doesn't need to juggle
//      provider-specific credentials in v1 (P08B uses `expo-server-sdk`).
//   3. POST `{ token, platform }` to the desktop at
//      `<httpBase>/devices/<deviceId>/push-token`, using the pairing bearer
//      token for auth. The desktop persists the token against the device
//      record (P08B's `devices.setPushToken`).
//   4. Subscribe to `addPushTokenListener` so we re-register whenever Apple
//      or Google rolls the device token underneath us.
//
// Web is out of scope for v1 (open question #25 doesn't cover web push
// either) — when `Platform.OS === 'web'` we no-op and return an unsubscribe
// that does nothing. The chat surface still works on web; only the
// "wake the phone" path is unavailable.
//
// The `deviceId` is encoded into the pairing token's claim by the desktop
// (`apps/desktop/src/main/pair/token.ts`'s `PairingClaim.device_id`). The
// token uses a compact `claim_b64url.signature_b64url` shape, so we decode
// the claim segment locally rather than asking the desktop to round-trip
// the id back to us. Signature verification stays a server-side concern;
// the only field we trust on-device is the one we read from a token *we*
// just received over a TLS-clean LAN socket inside the pairing flow.
//
// Tests live in `__tests__/register.test.ts` and stub both
// `expo-notifications` and `fetch`. The Linux dev container can't actually
// reach APNs/FCM, so this module is fully testable but only end-to-end
// observable on a real device.

import { Platform } from 'react-native';

import type { Token } from '@openclaw/protocol';

import type { FetchLike } from '../openclaw/transport/http';

/**
 * Minimal expo-notifications surface we depend on. Defined as a structural
 * interface so tests don't need to load the whole module — they pass a
 * stub conforming to this shape via `registerPushToken`'s options.
 */
export interface NotificationsLike {
  requestPermissionsAsync(permissions?: {
    ios?: { allowAlert?: boolean; allowBadge?: boolean; allowSound?: boolean };
  }): Promise<{ status?: string; granted?: boolean }>;
  getPermissionsAsync(): Promise<{ status?: string; granted?: boolean }>;
  getExpoPushTokenAsync(options?: { projectId?: string }): Promise<{ type: 'expo'; data: string }>;
  addPushTokenListener(listener: (token: { type: string; data: string }) => void): {
    remove(): void;
  };
}

/**
 * Lazily load the real `expo-notifications` module. We keep the import
 * dynamic so the web bundler (which lacks the native module) can still
 * compile this file — the web no-op short-circuits before we ever reach
 * the require call.
 */
function loadNotifications(): NotificationsLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-notifications') as NotificationsLike;
}

/** Body posted to `/devices/<id>/push-token`. */
export interface PushTokenBody {
  token: string;
  platform: 'ios' | 'android';
}

/** Result returned from `registerPushToken`. */
export interface PushRegistration {
  /** The Expo push token we registered with the desktop. */
  token: string;
  /** Platform the token is bound to. */
  platform: 'ios' | 'android';
  /**
   * Tear down the push-token-refresh listener. Always safe to call; calling
   * twice is a no-op. The web no-op path also returns a callable here so
   * callers can use `.unsubscribe()` unconditionally.
   */
  unsubscribe(): void;
}

/** Options for `registerPushToken`. All injection seams are for tests. */
export interface RegisterPushTokenOptions {
  /** HTTP base of the desktop server (e.g. `http://192.168.0.10:18789`). */
  httpBase: string;
  /** The pairing bearer token issued by the desktop at pairing time. */
  pairingToken: Token;
  /** Override the platform detection — defaults to `Platform.OS`. */
  platform?: 'ios' | 'android' | 'web';
  /** Inject a fetch implementation. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Inject the notifications surface. Defaults to the real `expo-notifications`. */
  notifications?: NotificationsLike;
  /**
   * Override device id resolution — tests use this to short-circuit the
   * claim decoder. In production we decode the id from `pairingToken`.
   */
  deviceId?: string;
  /** Override the EAS project id when calling `getExpoPushTokenAsync`. */
  projectId?: string;
}

/**
 * Strip a trailing slash so we can safely concatenate the path. Mirrors
 * `normalizeBase` from the HTTP transport but kept private to avoid a
 * cross-module import we don't otherwise need.
 */
function normalizeBase(httpBase: string): string {
  return httpBase.replace(/\/+$/, '');
}

/** Decode a base64url segment to a UTF-8 string. RN exposes `atob`/`btoa`. */
function b64urlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const standard = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  // `atob` is available on RN 0.81+ and on the web. We avoid `Buffer` so the
  // web bundle doesn't need a polyfill.
  // eslint-disable-next-line no-undef
  const binary = atob(standard);
  // Convert binary to UTF-8 — the claim is JSON which may include
  // non-ASCII in `device_name`. `decodeURIComponent(escape(...))` is the
  // canonical RN-friendly trick.
  let percentEncoded = '';
  for (let i = 0; i < binary.length; i += 1) {
    const c = binary.charCodeAt(i).toString(16).padStart(2, '0');
    percentEncoded += `%${c}`;
  }
  return decodeURIComponent(percentEncoded);
}

/**
 * Pull the `device_id` out of a desktop-issued pairing token claim. The
 * token shape is `<claim-b64url>.<signature-b64url>` per the desktop's
 * `apps/desktop/src/main/pair/token.ts`. Returns `null` on any decode
 * failure so callers can surface a friendly error.
 */
export function decodeDeviceIdFromToken(tokenValue: string): string | null {
  if (typeof tokenValue !== 'string' || !tokenValue.includes('.')) return null;
  const parts = tokenValue.split('.');
  if (parts.length !== 2) return null;
  const claimSegment = parts[0];
  if (!claimSegment) return null;
  try {
    const json = b64urlDecode(claimSegment);
    const parsed = JSON.parse(json) as { device_id?: unknown };
    if (typeof parsed.device_id !== 'string' || parsed.device_id.length === 0) {
      return null;
    }
    return parsed.device_id;
  } catch {
    return null;
  }
}

/**
 * Drive one full registration cycle: permission → token → POST → listener.
 *
 * On web this is a no-op (returns an empty unsubscribe). On native, throws
 * if the permission is denied or the desktop rejects the POST — callers
 * (the PairingProvider hook) swallow the error and log it.
 */
export async function registerPushToken(
  opts: RegisterPushTokenOptions,
): Promise<PushRegistration | null> {
  const platform = opts.platform ?? (Platform.OS as 'ios' | 'android' | 'web');
  if (platform === 'web') {
    // No web push in v1 — see the file header. We return `null` so callers
    // can short-circuit any "registered" state they keep.
    return null;
  }

  const notifications = opts.notifications ?? loadNotifications();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  const permission = await notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  // `granted` is the cross-platform truthy field on the standard
  // PermissionResponse shape; some Android paths leave it undefined and
  // only fill `status`. Treat either as "ok".
  const granted = permission.granted === true || permission.status === 'granted';
  if (!granted) {
    throw new Error('Notification permission denied');
  }

  const tokenResponse = await notifications.getExpoPushTokenAsync(
    opts.projectId ? { projectId: opts.projectId } : undefined,
  );
  const expoToken = tokenResponse.data;
  if (!expoToken) {
    throw new Error('Expo push token was empty');
  }

  const deviceId = opts.deviceId ?? decodeDeviceIdFromToken(opts.pairingToken.value);
  if (!deviceId) {
    throw new Error('Could not derive device id from pairing token');
  }

  await postPushToken({
    httpBase: opts.httpBase,
    deviceId,
    body: { token: expoToken, platform },
    pairingToken: opts.pairingToken,
    fetchImpl,
  });

  // Subscribe to refresh so we re-POST whenever the OS rolls the token.
  // The listener takes a `DevicePushToken` (the underlying APNs/FCM token),
  // not an Expo token — but on rotation we want a *fresh* Expo token, so
  // we re-fetch it before posting.
  const sub = notifications.addPushTokenListener(() => {
    void (async () => {
      try {
        const refreshed = await notifications.getExpoPushTokenAsync(
          opts.projectId ? { projectId: opts.projectId } : undefined,
        );
        const refreshedExpo = refreshed.data;
        if (!refreshedExpo) return;
        await postPushToken({
          httpBase: opts.httpBase,
          deviceId,
          body: { token: refreshedExpo, platform },
          pairingToken: opts.pairingToken,
          fetchImpl,
        });
      } catch (err) {
        // We don't have a UI surface for token-refresh errors; log + drop.
        // The next foregrounding will pick it up again via the next
        // `paired` transition (re-registers from scratch).
        // eslint-disable-next-line no-console
        console.warn('[openclaw/push] token refresh failed:', err);
      }
    })();
  });

  return {
    token: expoToken,
    platform,
    unsubscribe: () => sub.remove(),
  };
}

/** Internal: POST the body. Exposed for direct testing without permission flow. */
export async function postPushToken(args: {
  httpBase: string;
  deviceId: string;
  body: PushTokenBody;
  pairingToken: Token;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const url = `${normalizeBase(args.httpBase)}/devices/${encodeURIComponent(args.deviceId)}/push-token`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${args.pairingToken.value}`,
    },
    body: JSON.stringify(args.body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const json = (await res.json()) as { error?: unknown };
      if (typeof json?.error === 'string') detail = `: ${json.error}`;
    } catch {
      // Body wasn't JSON — fine, drop the detail.
    }
    throw new Error(`POST /devices/:id/push-token failed: HTTP ${res.status}${detail}`);
  }
}
