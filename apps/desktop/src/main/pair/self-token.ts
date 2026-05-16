// Self-issued bearer token for the desktop's own renderer.
//
// Per P05B step 8: the renderer chat surface needs to talk to its own
// backend over WS (`/ws`) + the CopilotKit runtime endpoint
// (`/copilot/runtime/...`). Both check `Authorization: Bearer <token>`
// using `verifyToken(publicKey, ...)`. Rather than expose a public
// device-pairing flow for the same machine, we mint a token once at
// startup under a fixed device id (`self`) and persist it in the same
// keystore that holds the signing key.
//
// Threat model: the self-token is **local-only**. It must never leave
// the box — see the plan's "Critical constraints". Concretely, this
// means:
//
//   1. The token is fetched by the renderer via an IPC call only. The
//      preload bridge does not surface it via a query param or env var,
//      so a malicious page (if one ever loaded into our renderer) can't
//      grab it without going through `contextBridge`.
//   2. The token still encodes `device_id: "self"`. If LAN exposure is
//      on (P04B) and an attacker on the LAN somehow guessed the token,
//      it would pass token validation. That risk is mitigated by the
//      token's signed-claim opacity (high-entropy Ed25519 signature
//      over a 32-byte UUID-equivalent claim). We accept this trade-off
//      for v1; production hardening (e.g. binding the self-token to
//      loopback-only routes) is tracked in open-questions.md #28.
//   3. On rotation, the existing entry is overwritten. There's no
//      mid-rotation grace period because the only consumer is the same
//      process's renderer.
//
// We deliberately mirror `keypair.ts`'s shape so the test surface looks
// familiar: pass a `Keystore` (or rely on `openKeystore(userDataDir)`),
// get back a token string + the underlying claim.

import { KEYSTORE_SERVICE, Keystore, openKeystore } from './keystore';
import { issueToken, type PairingClaim, verifyToken } from './token';
import type { KeyObject } from 'node:crypto';

/** Account name under `KEYSTORE_SERVICE` that holds the self-token. */
export const SELF_TOKEN_ACCOUNT = 'self-token';
/** Device id baked into the self-token's claim. */
export const SELF_DEVICE_ID = 'self';
/** Human-readable device name baked into the self-token's claim. */
export const SELF_DEVICE_NAME = 'desktop-self';

/** Resolved self-token + the claim it was minted from. */
export interface SelfToken {
  /** Compact `claim.signature` string the renderer presents as a bearer credential. */
  token: string;
  /** Decoded claim — exposed so callers can read the expiry without re-decoding. */
  claim: PairingClaim;
}

/** Inputs `loadOrCreateSelfToken` needs that aren't backend-internal. */
export interface LoadSelfTokenOptions {
  /** Per-gateway signing private key (used to mint a new token if needed). */
  privateKey: KeyObject;
  /** Per-gateway signing public key (used to verify an existing token). */
  publicKey: KeyObject;
  /** Gateway id to embed in the claim. */
  gatewayId: string;
  /** Keystore the token is persisted under. Defaults to `openKeystore(userDataDir)`. */
  keystore: Keystore;
  /** Override the TTL of a freshly-minted token. Tests use a short value. */
  ttlMs?: number;
  /** Override the issued-at timestamp. Tests use this to produce fixtures. */
  issuedAt?: number;
  /** Override the device id. Tests should normally leave this alone. */
  deviceId?: string;
  /** Override the device name. Tests should normally leave this alone. */
  deviceName?: string;
}

/**
 * Load the self-token, minting one on first run. If an existing token is
 * present but has already expired (or fails verification under the
 * current key), rotate it. Verification short-circuits to `null` for
 * any non-trivial parse error, which matches `verifyToken`'s contract.
 */
export async function loadOrCreateSelfToken(opts: LoadSelfTokenOptions): Promise<SelfToken> {
  const now = opts.issuedAt ?? Date.now();
  const existing = await opts.keystore.getSecret(SELF_TOKEN_ACCOUNT);
  if (existing) {
    const claim = verifyToken(opts.publicKey, existing, now);
    if (claim) {
      return { token: existing, claim };
    }
    // Either the key rotated under us or the token expired — fall through
    // to mint a fresh one. We don't surface this to the user; the renderer
    // just gets a new bearer credential on its next IPC call.
  }
  const token = issueToken(opts.privateKey, {
    device_id: opts.deviceId ?? SELF_DEVICE_ID,
    device_name: opts.deviceName ?? SELF_DEVICE_NAME,
    gateway_id: opts.gatewayId,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    issuedAt: now,
  });
  await opts.keystore.setSecret(SELF_TOKEN_ACCOUNT, token);
  // verifyToken always succeeds for a token we just minted with the
  // matching private key; calling it gives us the structured claim
  // without round-tripping through JSON.parse.
  const claim = verifyToken(opts.publicKey, token, now);
  if (!claim) {
    // This is a "the universe is broken" path — guard against it so the
    // type stays SelfToken (no `null` leakage to the renderer).
    throw new Error('self-token: freshly-minted token failed to verify');
  }
  return { token, claim };
}

/**
 * Convenience wrapper that opens the default keystore for the given
 * userData dir before delegating to `loadOrCreateSelfToken`. The main
 * process uses this; tests usually inject a pre-built `Keystore`.
 */
export async function openSelfToken(input: {
  userDataDir: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  gatewayId: string;
  service?: string;
  ttlMs?: number;
}): Promise<SelfToken> {
  const keystore = await openKeystore(input.userDataDir, input.service ?? KEYSTORE_SERVICE);
  return loadOrCreateSelfToken({
    privateKey: input.privateKey,
    publicKey: input.publicKey,
    gatewayId: input.gatewayId,
    keystore,
    ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
  });
}
