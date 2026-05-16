// Pairing-token persistence.
//
// On native (`ios`/`android`) we use `expo-secure-store`, which writes to
// the platform Keychain/Keystore. On web there's no Keychain; we fall back
// to `localStorage` and accept that web's security guarantees are weaker
// (the v1 trade-off called out in `.chalk/plans/P03A-mobile-pairing-ui.md`).
//
// Callers (`PairingProvider`, settings "Re-pair" stub) hit `savePairingToken`
// / `loadPairingToken` / `clearPairingToken` only — they never touch
// `SecureStore` or `localStorage` directly so swapping the backend later is
// a single-file change.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { Token } from '@openclaw/protocol';

/**
 * Storage key for the bearer token. Single key per device since v1 is
 * single-gateway; multi-gateway support gets a keyed scheme later.
 */
export const PAIRING_TOKEN_KEY = 'openclaw.pairing.token';

/** Plain Token shape persisted as JSON; matches `@openclaw/protocol`. */
type PersistedToken = Pick<Token, 'value' | 'expiresAt'>;

/** Cheap runtime guard — `SecureStore`/`localStorage` both return strings. */
function parseToken(raw: string | null): Token | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedToken>;
    if (typeof parsed.value !== 'string' || typeof parsed.expiresAt !== 'number') {
      return null;
    }
    return { value: parsed.value, expiresAt: parsed.expiresAt };
  } catch {
    // Corrupt JSON in the store is treated as "no token" so the user falls
    // back to the welcome screen rather than seeing a crash.
    return null;
  }
}

/**
 * Persist the bearer token. On native this writes to the Keychain; on web
 * it writes to `localStorage` under `PAIRING_TOKEN_KEY`.
 */
export async function savePairingToken(token: Token): Promise<void> {
  const serialized = JSON.stringify({ value: token.value, expiresAt: token.expiresAt });
  if (Platform.OS === 'web') {
    // expo-secure-store has no web implementation in v15 (it throws on call);
    // intentional fallback per the P03A plan note.
    if (typeof globalThis.localStorage === 'undefined') {
      throw new Error('localStorage unavailable on this web runtime');
    }
    globalThis.localStorage.setItem(PAIRING_TOKEN_KEY, serialized);
    return;
  }
  await SecureStore.setItemAsync(PAIRING_TOKEN_KEY, serialized);
}

/**
 * Load any previously-persisted token. Returns `null` if no token exists or
 * if the stored payload doesn't match the expected shape.
 */
export async function loadPairingToken(): Promise<Token | null> {
  if (Platform.OS === 'web') {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return parseToken(globalThis.localStorage.getItem(PAIRING_TOKEN_KEY));
  }
  const raw = await SecureStore.getItemAsync(PAIRING_TOKEN_KEY);
  return parseToken(raw);
}

/**
 * Remove the persisted token. Used by re-pair on the settings tab and by
 * any "this token is no longer valid" path the real WS client will add
 * once it lands in P04A.
 */
export async function clearPairingToken(): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.removeItem(PAIRING_TOKEN_KEY);
    return;
  }
  await SecureStore.deleteItemAsync(PAIRING_TOKEN_KEY);
}
