// Keypair: generate, persist, reload.
//
// We point `loadOrCreateSigningKey` at a fresh temp dir so the keytar
// fallback writes its file there. The second call should reload the
// same key — we check this by comparing the SPKI PEM of the public key
// (which is deterministic given the private key).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey } from '../keypair';

describe('loadOrCreateSigningKey', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openclaw-keypair-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('generates a fresh keypair on first call and reloads the same key on the next', async () => {
    const first = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.keypair-test');
    expect(first.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
    const second = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.keypair-test');
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('produces different keys in different userData dirs', async () => {
    const otherTmp = mkdtempSync(join(tmpdir(), 'openclaw-keypair-other-'));
    try {
      const a = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.keypair-test');
      const b = await loadOrCreateSigningKey(otherTmp, 'dev.openclaw.desktop.keypair-test');
      expect(a.publicKeyPem).not.toBe(b.publicKeyPem);
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });
});
