// Pairing-token issue + verify.
//
// Per P03B step 3: the desktop signs a JSON claim with its Ed25519
// signing key (from `keypair.ts`) and ships `{ claim, signature }` as
// the bearer token. We base64url-encode the claim + signature and join
// them with a dot — same vibe as a JWT, but we don't bring in `jose`
// because we own both ends and only need Ed25519. If we ever need
// audience-controlled tokens we'll swap in `jose`.

import { KeyObject, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

/** Claim payload carried by a pairing token. */
export interface PairingClaim {
  /** Stable id assigned to the paired device. */
  device_id: string;
  /** Human-readable device name (whatever the phone sent at pairing). */
  device_name: string;
  /** Stable id of the gateway that issued this token. */
  gateway_id: string;
  /** Epoch ms when the token was issued. */
  issued_at: number;
  /** Epoch ms after which the token must be rejected. */
  exp: number;
}

/** Default token lifetime — 30 days. Mobile rotates by re-pairing. */
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64');
}

/** Inputs the caller must supply; we fill in `issued_at` / `exp` ourselves. */
export interface IssueTokenInput {
  device_id: string;
  device_name: string;
  gateway_id: string;
  /** Override the token TTL (ms). Defaults to `DEFAULT_TOKEN_TTL_MS`. */
  ttlMs?: number;
  /** Override `issued_at` (epoch ms). Tests use this to produce fixtures. */
  issuedAt?: number;
}

/**
 * Sign + encode a pairing token. Returns the compact `claim.signature`
 * string the mobile client uses as a bearer credential.
 */
export function issueToken(privateKey: KeyObject, input: IssueTokenInput): string {
  const issued_at = input.issuedAt ?? Date.now();
  const exp = issued_at + (input.ttlMs ?? DEFAULT_TOKEN_TTL_MS);
  const claim: PairingClaim = {
    device_id: input.device_id,
    device_name: input.device_name,
    gateway_id: input.gateway_id,
    issued_at,
    exp,
  };
  const claimBytes = Buffer.from(JSON.stringify(claim), 'utf8');
  // Ed25519 in Node ignores the digest arg; pass `null`.
  const signature = cryptoSign(null, claimBytes, privateKey);
  return `${b64url(claimBytes)}.${b64url(signature)}`;
}

/**
 * Verify + decode a pairing token. Returns the claim on success, `null`
 * on any failure (bad shape, bad signature, or expired). Callers should
 * treat `null` as "reject, re-pair".
 */
export function verifyToken(
  publicKey: KeyObject,
  token: string,
  now: number = Date.now(),
): PairingClaim | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [claimB64, sigB64] = parts as [string, string];
  let claimBytes: Buffer;
  let sigBytes: Buffer;
  try {
    claimBytes = b64urlDecode(claimB64);
    sigBytes = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  let ok: boolean;
  try {
    ok = cryptoVerify(null, claimBytes, publicKey, sigBytes);
  } catch {
    return null;
  }
  if (!ok) return null;
  let claim: PairingClaim;
  try {
    claim = JSON.parse(claimBytes.toString('utf8')) as PairingClaim;
  } catch {
    return null;
  }
  if (
    typeof claim !== 'object' ||
    claim === null ||
    typeof claim.device_id !== 'string' ||
    typeof claim.device_name !== 'string' ||
    typeof claim.gateway_id !== 'string' ||
    typeof claim.issued_at !== 'number' ||
    typeof claim.exp !== 'number'
  ) {
    return null;
  }
  if (now >= claim.exp) return null;
  return claim;
}
