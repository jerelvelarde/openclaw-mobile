// Permission flow tests for the voice surface (P07A).
//
// We exercise three platform branches by injecting dependencies into the
// module's `MicPermissionsDeps` seam. The real `PermissionsAndroid` /
// `expo-secure-store` are never loaded — that lets the tests run on
// node-jest without simulators.

import { getMicPermissionStatus, requestMicPermission } from '../permissions';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFakeSecureStore(): {
  store: Map<string, string>;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    deleteItemAsync: jest.fn(async (k: string) => {
      store.delete(k);
    }),
  };
}

function makeFakeAndroid(result: string): {
  request: jest.Mock;
  PERMISSIONS: { RECORD_AUDIO: string };
  RESULTS: { GRANTED: string; DENIED: string; NEVER_ASK_AGAIN: string };
} {
  return {
    request: jest.fn().mockResolvedValue(result),
    PERMISSIONS: { RECORD_AUDIO: 'android.permission.RECORD_AUDIO' },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
  };
}

// ── Android ────────────────────────────────────────────────────────────────

describe('requestMicPermission — android', () => {
  it('returns granted and persists when the OS prompt grants', async () => {
    const secureStore = makeFakeSecureStore();
    const android = makeFakeAndroid('granted');

    const status = await requestMicPermission(
      { rationale: { title: 't', message: 'm' } },
      {
        platformOS: 'android',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        permissionsAndroid: android as any,
        secureStore,
      },
    );
    expect(status).toBe('granted');
    expect(android.request).toHaveBeenCalledWith(
      'android.permission.RECORD_AUDIO',
      expect.objectContaining({ title: 't', message: 'm' }),
    );
    expect(secureStore.store.get('openclaw.voice.mic.state')).toBe('granted');
  });

  it('returns blocked on NEVER_ASK_AGAIN', async () => {
    const secureStore = makeFakeSecureStore();
    const android = makeFakeAndroid('never_ask_again');
    const status = await requestMicPermission(
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { platformOS: 'android', permissionsAndroid: android as any, secureStore },
    );
    expect(status).toBe('blocked');
    expect(secureStore.store.get('openclaw.voice.mic.state')).toBe('blocked');
  });

  it('returns denied on plain denial', async () => {
    const secureStore = makeFakeSecureStore();
    const android = makeFakeAndroid('denied');
    const status = await requestMicPermission(
      {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { platformOS: 'android', permissionsAndroid: android as any, secureStore },
    );
    expect(status).toBe('denied');
    expect(secureStore.store.get('openclaw.voice.mic.state')).toBe('denied');
  });
});

// ── iOS ────────────────────────────────────────────────────────────────────

describe('requestMicPermission — ios', () => {
  it('optimistically persists granted and lets the WebRTC layer surface deny', async () => {
    const secureStore = makeFakeSecureStore();
    const status = await requestMicPermission({}, { platformOS: 'ios', secureStore });
    expect(status).toBe('granted');
    expect(secureStore.store.get('openclaw.voice.mic.state')).toBe('granted');
  });
});

// ── Web ────────────────────────────────────────────────────────────────────

describe('requestMicPermission — web', () => {
  it('persists granted on successful getUserMedia', async () => {
    const fakeLocalStorage = new Map<string, string>();
    const status = await requestMicPermission(
      {},
      {
        platformOS: 'web',
        webNavigator: {
          mediaDevices: {
            getUserMedia: jest.fn().mockResolvedValue({
              getTracks: () => [{ stop: jest.fn() }],
            }),
          },
        },
        localStorage: {
          getItem: (k) => fakeLocalStorage.get(k) ?? null,
          setItem: (k, v) => {
            fakeLocalStorage.set(k, v);
          },
        },
      },
    );
    expect(status).toBe('granted');
    expect(fakeLocalStorage.get('openclaw.voice.mic.state')).toBe('granted');
  });

  it('returns unavailable when getUserMedia is missing', async () => {
    const fakeLocalStorage = new Map<string, string>();
    const status = await requestMicPermission(
      {},
      {
        platformOS: 'web',
        webNavigator: {},
        localStorage: {
          getItem: (k) => fakeLocalStorage.get(k) ?? null,
          setItem: (k, v) => {
            fakeLocalStorage.set(k, v);
          },
        },
      },
    );
    expect(status).toBe('unavailable');
  });

  it('persists denied when getUserMedia rejects', async () => {
    const fakeLocalStorage = new Map<string, string>();
    const status = await requestMicPermission(
      {},
      {
        platformOS: 'web',
        webNavigator: {
          mediaDevices: {
            getUserMedia: jest.fn().mockRejectedValue(new Error('NotAllowedError')),
          },
        },
        localStorage: {
          getItem: (k) => fakeLocalStorage.get(k) ?? null,
          setItem: (k, v) => {
            fakeLocalStorage.set(k, v);
          },
        },
      },
    );
    expect(status).toBe('denied');
    expect(fakeLocalStorage.get('openclaw.voice.mic.state')).toBe('denied');
  });
});

// ── Status peek ────────────────────────────────────────────────────────────

describe('getMicPermissionStatus', () => {
  it('returns the persisted value when present', async () => {
    const secureStore = makeFakeSecureStore();
    secureStore.store.set('openclaw.voice.mic.state', 'granted');
    expect(await getMicPermissionStatus({ platformOS: 'android', secureStore })).toBe('granted');
  });

  it('returns unknown by default', async () => {
    const secureStore = makeFakeSecureStore();
    expect(await getMicPermissionStatus({ platformOS: 'ios', secureStore })).toBe('unknown');
  });

  it('returns unavailable on web when no getUserMedia is present', async () => {
    expect(
      await getMicPermissionStatus({
        platformOS: 'web',
        webNavigator: {},
      }),
    ).toBe('unavailable');
  });
});
