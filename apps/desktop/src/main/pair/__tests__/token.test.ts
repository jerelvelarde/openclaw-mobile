// Token issue → verify, plus tampering + expiry rejection.

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOKEN_TTL_MS, issueToken, verifyToken } from '../token';

function freshKeyPair(): {
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  publicKey: ReturnType<typeof generateKeyPairSync>['publicKey'];
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

describe('issueToken / verifyToken', () => {
  it('issues a token that verifies and round-trips the claim', () => {
    const { privateKey, publicKey } = freshKeyPair();
    const issuedAt = 1_700_000_000_000;
    const token = issueToken(privateKey, {
      device_id: 'dev-1',
      device_name: 'Test Phone',
      gateway_id: 'gw-1',
      issuedAt,
    });
    const claim = verifyToken(publicKey, token, issuedAt + 1000);
    expect(claim).not.toBeNull();
    expect(claim?.device_id).toBe('dev-1');
    expect(claim?.device_name).toBe('Test Phone');
    expect(claim?.gateway_id).toBe('gw-1');
    expect(claim?.issued_at).toBe(issuedAt);
    expect(claim?.exp).toBe(issuedAt + DEFAULT_TOKEN_TTL_MS);
  });

  it('rejects a tampered claim payload', () => {
    const { privateKey, publicKey } = freshKeyPair();
    const token = issueToken(privateKey, {
      device_id: 'dev-1',
      device_name: 'Phone',
      gateway_id: 'gw-1',
    });
    const [claimB64, sigB64] = token.split('.');
    // Flip a byte well inside the encoded claim. Tampering at the very
    // last character can be absorbed by base64url's trailing-bit padding
    // (length-mod-4 == 2 leaves only 2 useful bits in the last char), so
    // we splice a substitution somewhere in the middle where every bit
    // round-trips.
    const middle = Math.floor((claimB64 ?? '').length / 2);
    const original = (claimB64 ?? '').charAt(middle);
    const swap = original === 'A' ? 'B' : 'A';
    const tampered = `${(claimB64 ?? '').slice(0, middle)}${swap}${(claimB64 ?? '').slice(middle + 1)}.${sigB64 ?? ''}`;
    expect(verifyToken(publicKey, tampered)).toBeNull();
  });

  it('rejects a token signed with the wrong key', () => {
    const a = freshKeyPair();
    const b = freshKeyPair();
    const token = issueToken(a.privateKey, {
      device_id: 'dev-1',
      device_name: 'Phone',
      gateway_id: 'gw-1',
    });
    expect(verifyToken(b.publicKey, token)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { privateKey, publicKey } = freshKeyPair();
    const issuedAt = 1_700_000_000_000;
    const token = issueToken(privateKey, {
      device_id: 'dev-1',
      device_name: 'Phone',
      gateway_id: 'gw-1',
      issuedAt,
      ttlMs: 1000,
    });
    expect(verifyToken(publicKey, token, issuedAt + 2000)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    const { publicKey } = freshKeyPair();
    expect(verifyToken(publicKey, '')).toBeNull();
    expect(verifyToken(publicKey, 'not-a-token')).toBeNull();
    expect(verifyToken(publicKey, 'a.b.c')).toBeNull();
  });
});
