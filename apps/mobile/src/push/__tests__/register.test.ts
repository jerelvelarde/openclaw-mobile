// Tests for the Expo push registration flow.
//
// We exercise:
//   - `decodeDeviceIdFromToken` extracts the device_id claim from a desktop-
//     issued token.
//   - `postPushToken` sends the expected body to the expected URL with the
//     pairing token as Bearer auth.
//   - `registerPushToken` end-to-end: permission grant → Expo token →
//     desktop POST → refresh-listener subscription.
//   - The web fallback path (`Platform.OS === 'web'`) is a no-op.
//
// `expo-notifications` is stubbed via the `notifications` option on
// `registerPushToken` rather than `jest.mock`, since we never load the
// real native module from this test file.

import type { Token } from '@openclaw/protocol';

import {
  decodeDeviceIdFromToken,
  postPushToken,
  registerPushToken,
  type NotificationsLike,
} from '../register';

/** Helper: build a fake desktop-issued token whose claim contains `device_id`. */
function fakeToken(deviceId: string): Token {
  const claim = {
    device_id: deviceId,
    device_name: 'Test iPhone',
    gateway_id: 'gw-1',
    issued_at: 1_700_000_000_000,
    exp: 1_700_000_000_000 + 60_000,
  };
  // base64url(JSON(claim)) — same scheme as `apps/desktop/.../token.ts`.
  const json = JSON.stringify(claim);
  const base64 = Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  // Signature is opaque to the mobile-side decoder — pick anything.
  const value = `${base64}.sig-not-checked`;
  return { value, expiresAt: 1_700_000_000_000 + 60_000 };
}

/** Helper: build a `NotificationsLike` stub with sane defaults. */
function buildNotificationsStub(opts?: {
  permissionGranted?: boolean;
  expoToken?: string;
}): NotificationsLike & {
  _listeners: Array<(t: { type: string; data: string }) => void>;
  _emitRefresh(token: { type: string; data: string }): void;
  _removed: boolean;
} {
  const listeners: Array<(t: { type: string; data: string }) => void> = [];
  let removed = false;
  const stub = {
    requestPermissionsAsync: jest.fn(async () => ({
      granted: opts?.permissionGranted ?? true,
      status: opts?.permissionGranted === false ? 'denied' : 'granted',
    })),
    getPermissionsAsync: jest.fn(async () => ({
      granted: opts?.permissionGranted ?? true,
      status: opts?.permissionGranted === false ? 'denied' : 'granted',
    })),
    getExpoPushTokenAsync: jest.fn(async () => ({
      type: 'expo' as const,
      data: opts?.expoToken ?? 'ExponentPushToken[xxxxxx]',
    })),
    addPushTokenListener: jest.fn((listener) => {
      listeners.push(listener);
      return {
        remove() {
          removed = true;
        },
      };
    }),
    _listeners: listeners,
    _emitRefresh(t: { type: string; data: string }): void {
      for (const l of listeners) l(t);
    },
    get _removed(): boolean {
      return removed;
    },
  };
  return stub;
}

describe('decodeDeviceIdFromToken', () => {
  it('returns the device_id encoded in the claim segment', () => {
    const token = fakeToken('dev-123');
    expect(decodeDeviceIdFromToken(token.value)).toBe('dev-123');
  });

  it('returns null on a token with the wrong shape', () => {
    expect(decodeDeviceIdFromToken('not-a-jwt')).toBeNull();
    expect(decodeDeviceIdFromToken('a.b.c')).toBeNull();
    expect(decodeDeviceIdFromToken('')).toBeNull();
  });

  it('returns null on a claim missing device_id', () => {
    const claim = { device_name: 'x' };
    const b64 = Buffer.from(JSON.stringify(claim), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeDeviceIdFromToken(`${b64}.sig`)).toBeNull();
  });

  it('returns null on a non-JSON claim payload', () => {
    const b64 = Buffer.from('not-json', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeDeviceIdFromToken(`${b64}.sig`)).toBeNull();
  });
});

describe('postPushToken', () => {
  it('POSTs the expected body to /devices/<id>/push-token with bearer auth', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    await postPushToken({
      httpBase: 'http://127.0.0.1:18789',
      deviceId: 'dev-123',
      body: { token: 'ExpoPushToken[abc]', platform: 'ios' },
      pairingToken: { value: 'bearer-tok', expiresAt: 1 },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/devices/dev-123/push-token');
    expect(init).toBeDefined();
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['authorization'] ?? '').toBe(
      'Bearer bearer-tok',
    );
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({
      token: 'ExpoPushToken[abc]',
      platform: 'ios',
    });
  });

  it('url-encodes a device id with special characters', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    await postPushToken({
      httpBase: 'http://127.0.0.1:18789',
      deviceId: 'dev/with spaces',
      body: { token: 'x', platform: 'android' },
      pairingToken: { value: 'tok', expiresAt: 1 },
      fetchImpl,
    });
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/devices/dev%2Fwith%20spaces/push-token');
  });

  it('strips a trailing slash on httpBase', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    await postPushToken({
      httpBase: 'http://127.0.0.1:18789/',
      deviceId: 'dev-1',
      body: { token: 't', platform: 'ios' },
      pairingToken: { value: 'tok', expiresAt: 1 },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:18789/devices/dev-1/push-token');
  });

  it('throws a structured error on non-2xx', async () => {
    const fetchImpl = jest.fn(
      async () =>
        ({
          ok: false,
          status: 401,
          json: async () => ({ error: 'unauthorized' }),
        }) as unknown as Response,
    );
    await expect(
      postPushToken({
        httpBase: 'http://x',
        deviceId: 'd',
        body: { token: 't', platform: 'ios' },
        pairingToken: { value: 'tok', expiresAt: 1 },
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 401.*unauthorized/);
  });
});

describe('registerPushToken', () => {
  it('grants permission, fetches an Expo token, POSTs it, and subscribes to refresh', async () => {
    const notifications = buildNotificationsStub({ expoToken: 'ExponentPushToken[abc]' });
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    const token = fakeToken('dev-zzz');
    const reg = await registerPushToken({
      httpBase: 'http://127.0.0.1:18789',
      pairingToken: token,
      platform: 'ios',
      notifications,
      fetchImpl,
    });
    expect(reg).not.toBeNull();
    expect(reg!.token).toBe('ExponentPushToken[abc]');
    expect(reg!.platform).toBe('ios');
    expect(notifications.requestPermissionsAsync).toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalled();
    expect(notifications.addPushTokenListener).toHaveBeenCalled();
    // Expected POST body + URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/devices/dev-zzz/push-token');
    expect(JSON.parse(init!.body as string)).toEqual({
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
  });

  it('throws when the permission is denied', async () => {
    const notifications = buildNotificationsStub({ permissionGranted: false });
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>();
    await expect(
      registerPushToken({
        httpBase: 'http://x',
        pairingToken: fakeToken('d'),
        platform: 'ios',
        notifications,
        fetchImpl,
      }),
    ).rejects.toThrow(/permission denied/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws when the device id cannot be decoded from the token', async () => {
    const notifications = buildNotificationsStub();
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>();
    await expect(
      registerPushToken({
        httpBase: 'http://x',
        pairingToken: { value: 'not-a-jwt', expiresAt: 1 },
        platform: 'ios',
        notifications,
        fetchImpl,
      }),
    ).rejects.toThrow(/device id/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-POSTs the Expo token when the push-token listener fires', async () => {
    const notifications = buildNotificationsStub({ expoToken: 'ExponentPushToken[first]' });
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    const reg = await registerPushToken({
      httpBase: 'http://127.0.0.1:18789',
      pairingToken: fakeToken('dev-q'),
      platform: 'android',
      notifications,
      fetchImpl,
    });
    expect(reg).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Simulate the OS rolling the token; getExpoPushTokenAsync now returns a
    // new Expo token, and the refresh path should re-POST.
    (notifications.getExpoPushTokenAsync as jest.Mock).mockResolvedValueOnce({
      type: 'expo',
      data: 'ExponentPushToken[second]',
    });
    notifications._emitRefresh({ type: 'android', data: 'native-token' });
    // The listener fires the async re-register on the next tick; flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1]!;
    expect(JSON.parse(init!.body as string)).toEqual({
      token: 'ExponentPushToken[second]',
      platform: 'android',
    });
  });

  it('returns null and never touches notifications on web', async () => {
    const notifications = buildNotificationsStub();
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>();
    const reg = await registerPushToken({
      httpBase: 'http://x',
      pairingToken: fakeToken('d'),
      platform: 'web',
      notifications,
      fetchImpl,
    });
    expect(reg).toBeNull();
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes an unsubscribe that removes the push token listener', async () => {
    const notifications = buildNotificationsStub();
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit?]>(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    );
    const reg = await registerPushToken({
      httpBase: 'http://x',
      pairingToken: fakeToken('d'),
      platform: 'ios',
      notifications,
      fetchImpl,
    });
    expect(reg).not.toBeNull();
    expect(notifications._removed).toBe(false);
    reg!.unsubscribe();
    expect(notifications._removed).toBe(true);
  });
});
