// clawg-ui device-token store round-trip tests (P11B).
//
// Mirrors `src/pairing/__tests__/store.test.ts` — an in-memory shim for
// expo-secure-store + a separate suite for the web fallback.

import { Platform } from 'react-native';

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

import {
  CLAWG_UI_TOKEN_KEY,
  clearClawgUiToken,
  loadClawgUiToken,
  saveClawgUiToken,
} from '../tokenStore';

const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.fake.token';

describe('clawg-ui token store (native — Platform.OS=ios)', () => {
  beforeEach(() => {
    mockSecureStoreMemory.clear();
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
  });

  it('save → load returns the same token', async () => {
    await saveClawgUiToken(FAKE_TOKEN);
    expect(await loadClawgUiToken()).toBe(FAKE_TOKEN);
  });

  it('clear removes the token', async () => {
    await saveClawgUiToken(FAKE_TOKEN);
    await clearClawgUiToken();
    expect(await loadClawgUiToken()).toBeNull();
  });

  it('uses a key distinct from the pairing-session store', () => {
    expect(CLAWG_UI_TOKEN_KEY).not.toEqual('openclaw.pairing.token');
    expect(CLAWG_UI_TOKEN_KEY).not.toEqual('openclaw.pairing.session');
  });
});

describe('clawg-ui token store (web — Platform.OS=web)', () => {
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'web' });
    // jsdom-ish localStorage shim. We need this even when jest-expo
    // doesn't provide one (some preset versions skip it for native).
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        getItem: (k: string) => store.get(k) ?? null,
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
  });

  it('round-trips via localStorage', async () => {
    await saveClawgUiToken(FAKE_TOKEN);
    expect(await loadClawgUiToken()).toBe(FAKE_TOKEN);
    await clearClawgUiToken();
    expect(await loadClawgUiToken()).toBeNull();
  });
});
