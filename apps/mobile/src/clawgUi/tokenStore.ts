// Secure-store wrappers for the clawg-ui device token (P11B).
//
// clawg-ui's bearer token is a distinct credential from our P03B
// pairing token (which authenticates the phone↔Mac WS). We store it
// under its own SecureStore / localStorage key so a clawg-ui re-pair
// can wipe just the gateway token without invalidating the user's
// device-pairing session.
//
// Mirrors `src/pairing/store.ts`'s platform-split: `expo-secure-store`
// on native (Keychain / Keystore), `localStorage` on web (with the
// weaker guarantees called out in `.chalk/plans/P03A`).

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Storage key for the clawg-ui device bearer token. */
export const CLAWG_UI_TOKEN_KEY = 'openclaw.clawg-ui.token';

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

/** Persist the clawg-ui device token (received in the 403 response body). */
export async function saveClawgUiToken(token: string): Promise<void> {
  await writeItem(CLAWG_UI_TOKEN_KEY, token);
}

/** Read the persisted clawg-ui device token, or null if none exists. */
export async function loadClawgUiToken(): Promise<string | null> {
  return readItem(CLAWG_UI_TOKEN_KEY);
}

/** Remove the persisted clawg-ui device token. */
export async function clearClawgUiToken(): Promise<void> {
  await deleteItem(CLAWG_UI_TOKEN_KEY);
}
