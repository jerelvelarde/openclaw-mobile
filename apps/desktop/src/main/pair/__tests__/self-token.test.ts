// Unit tests for the self-token issuance helper.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey, type SigningKey } from '../keypair';
import { openKeystore, type Keystore } from '../keystore';
import { loadOrCreateSelfToken, SELF_DEVICE_ID, SELF_TOKEN_ACCOUNT } from '../self-token';
import { verifyToken } from '../token';

describe('self-token', () => {
  let tmp: string;
  let signingKey: SigningKey;
  let keystore: Keystore;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'openclaw-self-token-'));
    signingKey = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.self-token-test');
    keystore = await openKeystore(tmp, 'dev.openclaw.desktop.self-token-test-store');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('mints a fresh token on first run and persists it', async () => {
    const result = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
    });

    expect(typeof result.token).toBe('string');
    expect(result.token).toContain('.');
    expect(result.claim.device_id).toBe(SELF_DEVICE_ID);
    expect(result.claim.gateway_id).toBe('gw-test');

    const persisted = await keystore.getSecret(SELF_TOKEN_ACCOUNT);
    expect(persisted).toBe(result.token);

    const reverified = verifyToken(signingKey.publicKey, result.token);
    expect(reverified).not.toBeNull();
    expect(reverified?.device_id).toBe(SELF_DEVICE_ID);
  });

  it('returns the existing token on subsequent runs when still valid', async () => {
    const first = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
    });
    const second = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
    });
    expect(second.token).toBe(first.token);
  });

  it('rotates the token when the existing one has expired', async () => {
    const issuedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    const ttlMs = 60 * 60 * 1000; // 1 hour TTL — already expired by `now`
    const first = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
      ttlMs,
      issuedAt,
    });
    // Second call uses the default `now` (epoch ms), so the first
    // token is past its expiry and a fresh one should be minted.
    const second = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
    });
    expect(second.token).not.toBe(first.token);
    expect(second.claim.exp).toBeGreaterThan(Date.now());
  });

  it('rotates if the stored token fails verification (e.g. key changed)', async () => {
    await keystore.setSecret(SELF_TOKEN_ACCOUNT, 'not-a-real-token.with-bad-sig');
    const fresh = await loadOrCreateSelfToken({
      privateKey: signingKey.privateKey,
      publicKey: signingKey.publicKey,
      gatewayId: 'gw-test',
      keystore,
    });
    expect(fresh.token).not.toBe('not-a-real-token.with-bad-sig');
    expect(fresh.claim.device_id).toBe(SELF_DEVICE_ID);
  });
});
