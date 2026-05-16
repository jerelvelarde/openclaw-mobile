// Ed25519 signing key for the desktop pairing service.
//
// Per P03B step 2: on first run, generate a fresh Ed25519 keypair via
// `crypto.generateKeyPairSync` and persist the private key under service
// `dev.openclaw.desktop`, account `signing-key` in the host keystore.
// On subsequent runs, reload the same key. The public key is derived
// deterministically from the private key, so we only persist one half.
//
// The key is exported as a PKCS#8 PEM string for storage — it round-trips
// cleanly through both Keychain and the file-encrypted fallback, and
// `crypto.createPrivateKey` can re-import it directly. The matching
// SubjectPublicKeyInfo PEM is produced on demand via `createPublicKey`.

import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from 'node:crypto';
import { KEYSTORE_SERVICE, Keystore, openKeystore } from './keystore';

/** Account name under `KEYSTORE_SERVICE` that holds the signing private key. */
export const SIGNING_KEY_ACCOUNT = 'signing-key';

/**
 * In-memory handle to the loaded signing keypair. Both halves are
 * `KeyObject`s so callers can hand them to `crypto.sign` / `verify`
 * without re-parsing the PEM each call.
 */
export interface SigningKey {
  /** Ed25519 private key — used by `token.ts` to sign claims. */
  privateKey: KeyObject;
  /** Ed25519 public key — used by `token.ts` to verify, and exported for pairing. */
  publicKey: KeyObject;
  /**
   * SPKI-PEM-encoded public key. Suitable for shipping to the mobile app
   * during pairing so it can verify tokens locally without round-tripping
   * to the gateway.
   */
  publicKeyPem: string;
}

/**
 * Generate a fresh Ed25519 keypair and return the private key as a PKCS#8
 * PEM string suitable for storing in the keystore. Exposed separately so
 * tests can exercise the generation step without touching disk.
 */
export function generateSigningKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

function importSigningKey(pem: string): SigningKey {
  const privateKey = createPrivateKey({ key: pem, format: 'pem' });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  return { privateKey, publicKey, publicKeyPem };
}

/**
 * Load the desktop app's signing key, generating + persisting one on first
 * run. Calls `openKeystore(userDataDir)` to pick the best-available
 * backend; pass a fresh temp dir from tests to avoid colliding with the
 * real user's Keychain.
 */
export async function loadOrCreateSigningKey(
  userDataDir: string,
  service: string = KEYSTORE_SERVICE,
): Promise<SigningKey & { keystore: Keystore }> {
  const keystore = await openKeystore(userDataDir, service);
  const existing = await keystore.getSecret(SIGNING_KEY_ACCOUNT);
  if (existing) {
    return { ...importSigningKey(existing), keystore };
  }
  const pem = generateSigningKeyPem();
  await keystore.setSecret(SIGNING_KEY_ACCOUNT, pem);
  return { ...importSigningKey(pem), keystore };
}
