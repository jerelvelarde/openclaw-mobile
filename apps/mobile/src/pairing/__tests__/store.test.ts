// Pairing-token store round-trip tests.
//
// We mock `expo-secure-store` with an in-memory shim so the suite runs
// under jest-expo without touching a real Keychain. The mock also lets us
// assert the right key is used. Web behavior is exercised separately via
// `Platform.OS = "web"` and `globalThis.localStorage`.

import { Platform } from 'react-native';

import type { Token } from '@openclaw/protocol';

// In-memory shim for expo-secure-store. The mock keeps a Map of key→value so
// successive save/load/clear calls behave like a real store. The variable
// name must start with `mock` so jest's module-factory hoist guard allows it.
const mockSecureStoreMemory = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecureStoreMemory.set(k, v);
  }),
  getItemAsync: jest.fn(async (k: string) => mockSecureStoreMemory.get(k) ?? null),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockSecureStoreMemory.delete(k);
  }),
}));

import { PAIRING_TOKEN_KEY, clearPairingToken, loadPairingToken, savePairingToken } from '../store';

const FAKE_TOKEN: Token = { value: 'tok_round_trip', expiresAt: 9_999_999_999_999 };

describe('pairing token store (native default — Platform.OS=ios)', () => {
  beforeEach(() => {
    mockSecureStoreMemory.clear();
    // jest-expo defaults Platform.OS to "ios" inside tests.
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
  });

  it('save → load returns the same token shape', async () => {
    await savePairingToken(FAKE_TOKEN);
    const loaded = await loadPairingToken();
    expect(loaded).toEqual(FAKE_TOKEN);
  });

  it('load returns null when nothing is stored', async () => {
    const loaded = await loadPairingToken();
    expect(loaded).toBeNull();
  });

  it('clear deletes the persisted token', async () => {
    await savePairingToken(FAKE_TOKEN);
    await clearPairingToken();
    expect(await loadPairingToken()).toBeNull();
  });

  it('load returns null when the stored value is corrupt JSON', async () => {
    // Force a corrupt value into the store; loadPairingToken should not
    // throw — it should return null so the user falls back to welcome.
    mockSecureStoreMemory.set(PAIRING_TOKEN_KEY, '{not valid json');
    expect(await loadPairingToken()).toBeNull();
  });

  it('load returns null when the stored payload is the wrong shape', async () => {
    mockSecureStoreMemory.set(
      PAIRING_TOKEN_KEY,
      JSON.stringify({ value: 'tok', expiresAt: 'soon' }),
    );
    expect(await loadPairingToken()).toBeNull();
  });
});

describe('pairing token store (web fallback — Platform.OS=web)', () => {
  // Stand-in localStorage so the test doesn't depend on a DOM polyfill.
  const memory = new Map<string, string>();
  const fakeLocalStorage = {
    setItem: (k: string, v: string) => memory.set(k, v),
    getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
    removeItem: (k: string) => {
      memory.delete(k);
    },
  };

  beforeEach(() => {
    memory.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
    // jest-expo doesn't seed `globalThis.localStorage`; attach one we control.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: fakeLocalStorage,
    });
  });

  afterAll(() => {
    // Restore Platform.OS so other suites in the same worker see the default.
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
  });

  it('round-trips via localStorage', async () => {
    await savePairingToken(FAKE_TOKEN);
    expect(memory.get(PAIRING_TOKEN_KEY)).toBeDefined();
    const loaded = await loadPairingToken();
    expect(loaded).toEqual(FAKE_TOKEN);
    await clearPairingToken();
    expect(memory.has(PAIRING_TOKEN_KEY)).toBe(false);
  });
});
