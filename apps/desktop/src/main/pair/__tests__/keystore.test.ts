// File-encrypted keystore round-trip tests.
//
// The container these tests run in doesn't ship libsecret, so
// `openKeystore` will fall through to the file backend. That's the
// branch we care about anyway — the keytar path is a thin pass-through
// to the native module. We still assert the `backend === 'file'` so we
// notice if the keytar branch ever silently activates here.

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openKeystore } from '../keystore';

describe('openKeystore (file fallback)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openclaw-keystore-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips a secret through the file backend', async () => {
    const ks = await openKeystore(tmp, 'dev.openclaw.desktop.test');
    expect(ks.backend).toBe('file');
    expect(await ks.getSecret('signing-key')).toBeNull();
    await ks.setSecret('signing-key', 'hello-world');
    expect(await ks.getSecret('signing-key')).toBe('hello-world');
  });

  it('persists the secret across instances', async () => {
    const ksA = await openKeystore(tmp, 'dev.openclaw.desktop.test');
    await ksA.setSecret('signing-key', 'persisted-value');
    const ksB = await openKeystore(tmp, 'dev.openclaw.desktop.test');
    expect(await ksB.getSecret('signing-key')).toBe('persisted-value');
  });

  it('writes ciphertext, not plaintext, to disk', async () => {
    const ks = await openKeystore(tmp, 'dev.openclaw.desktop.test');
    await ks.setSecret('signing-key', 'plaintext-secret-marker');
    const onDisk = readFileSync(join(tmp, 'keystore.enc'), 'utf8');
    expect(existsSync(join(tmp, 'keystore.enc'))).toBe(true);
    expect(onDisk).not.toContain('plaintext-secret-marker');
  });
});
