// Pairing-token + session persistence.
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
//
// P05A: extended to also persist the `runtimeUrl` + `httpBase` so that on
// app restart the CopilotKit runtime client can resume without re-pairing.
// The bearer token is still the primary record (legacy callers using
// `savePairingToken` keep working) — `saveSession` is the new wide call.

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { Token } from '@openclaw/protocol';

/**
 * Storage key for the bearer token. Single key per device since v1 is
 * single-gateway; multi-gateway support gets a keyed scheme later.
 */
export const PAIRING_TOKEN_KEY = 'openclaw.pairing.token';

/** Storage key for the wider session record (token + runtimeUrl + httpBase). */
export const PAIRING_SESSION_KEY = 'openclaw.pairing.session';

/** Plain Token shape persisted as JSON; matches `@openclaw/protocol`. */
type PersistedToken = Pick<Token, 'value' | 'expiresAt'>;

/** Full session record persisted alongside the token. */
export interface PersistedSession {
  token: Token;
  /** Absolute runtime URL the desktop advertised at pairing time. */
  runtimeUrl?: string;
  /** HTTP base (host:port) the phone paired against — used as fallback. */
  httpBase?: string;
}

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

/** Parse a persisted session. Returns null on corrupt / wrong-shape input. */
function parseSession(raw: string | null): PersistedSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    if (
      !parsed.token ||
      typeof parsed.token.value !== 'string' ||
      typeof parsed.token.expiresAt !== 'number'
    ) {
      return null;
    }
    const out: PersistedSession = {
      token: { value: parsed.token.value, expiresAt: parsed.token.expiresAt },
    };
    if (typeof parsed.runtimeUrl === 'string') out.runtimeUrl = parsed.runtimeUrl;
    if (typeof parsed.httpBase === 'string') out.httpBase = parsed.httpBase;
    return out;
  } catch {
    return null;
  }
}

async function writeItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof globalThis.localStorage === 'undefined') {
      throw new Error('localStorage unavailable on this web runtime');
    }
    globalThis.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function readItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (typeof globalThis.localStorage === 'undefined') return null;
    return globalThis.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof globalThis.localStorage === 'undefined') return;
    globalThis.localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

/**
 * Persist the bearer token. On native this writes to the Keychain; on web
 * it writes to `localStorage` under `PAIRING_TOKEN_KEY`.
 */
export async function savePairingToken(token: Token): Promise<void> {
  const serialized = JSON.stringify({ value: token.value, expiresAt: token.expiresAt });
  await writeItem(PAIRING_TOKEN_KEY, serialized);
}

/**
 * Load any previously-persisted token. Returns `null` if no token exists or
 * if the stored payload doesn't match the expected shape.
 */
export async function loadPairingToken(): Promise<Token | null> {
  return parseToken(await readItem(PAIRING_TOKEN_KEY));
}

/**
 * Remove the persisted token. Used by re-pair on the settings tab and by
 * any "this token is no longer valid" path the real WS client will add
 * once it lands in P04A.
 */
export async function clearPairingToken(): Promise<void> {
  await deleteItem(PAIRING_TOKEN_KEY);
}

/**
 * Persist the wider session record (token + runtimeUrl + httpBase). Also
 * writes the legacy `PAIRING_TOKEN_KEY` entry so existing readers continue
 * to load a valid token without migration.
 */
export async function savePairingSession(session: PersistedSession): Promise<void> {
  const serialized = JSON.stringify({
    token: { value: session.token.value, expiresAt: session.token.expiresAt },
    runtimeUrl: session.runtimeUrl,
    httpBase: session.httpBase,
  });
  await writeItem(PAIRING_SESSION_KEY, serialized);
  await savePairingToken(session.token);
}

/**
 * Load a previously-persisted session. Falls back to `loadPairingToken()`
 * when only the legacy single-token record is present (e.g. token from a
 * build that predates P05A).
 */
export async function loadPairingSession(): Promise<PersistedSession | null> {
  const session = parseSession(await readItem(PAIRING_SESSION_KEY));
  if (session) return session;
  const token = await loadPairingToken();
  if (!token) return null;
  return { token };
}

/** Remove both the session record and the legacy token. */
export async function clearPairingSession(): Promise<void> {
  await deleteItem(PAIRING_SESSION_KEY);
  await clearPairingToken();
}
