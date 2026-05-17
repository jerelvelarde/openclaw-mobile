// clawg-ui identity-store round-trip tests (P11A).
//
// We back onto the same `Keystore` facade the real bridge uses; on Linux
// dev containers without libsecret this resolves to the file-encrypted
// fallback under `userDataDir`, which is exactly what production
// installs hit too — the tests are real round-trips, not in-memory
// mocks.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAWG_UI_IDENTITIES_ACCOUNT,
  openClawgUiIdentityStore,
  type ClawgUiIdentity,
} from '../identity';
import { openKeystore, type Keystore } from '../../pair/keystore';

let tmp: string;
let keystore: Keystore;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'openclaw-clawg-ui-identity-'));
  keystore = await openKeystore(tmp, 'dev.openclaw.clawg-ui.test');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('openClawgUiIdentityStore', () => {
  it('returns null for an unknown host:port', async () => {
    const store = openClawgUiIdentityStore(keystore);
    expect(await store.read('127.0.0.1', 18789)).toBeNull();
  });

  it('persists and re-reads an upserted identity', async () => {
    const store = openClawgUiIdentityStore(keystore);
    const identity: ClawgUiIdentity = {
      host: '127.0.0.1',
      port: 18789,
      deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      deviceToken: 'abc.def',
      pairingCode: 'ABCD1234',
    };
    await store.upsert(identity);
    const fresh = openClawgUiIdentityStore(keystore);
    const read = await fresh.read('127.0.0.1', 18789);
    expect(read).toEqual(identity);
  });

  it('records a pairing-pending response and surfaces the pairing code', async () => {
    const store = openClawgUiIdentityStore(keystore);
    const persisted = await store.recordPairingPending({
      host: '192.168.1.42',
      port: 18789,
      deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      deviceToken: 'tok.sig',
      pairingCode: 'XYZ12345',
    });
    expect(persisted.pairingCode).toBe('XYZ12345');
    const read = await store.read('192.168.1.42', 18789);
    expect(read?.deviceToken).toBe('tok.sig');
    expect(read?.pairingCode).toBe('XYZ12345');
  });

  it('clears the pairing code on markApproved but keeps the token', async () => {
    const store = openClawgUiIdentityStore(keystore);
    await store.recordPairingPending({
      host: '127.0.0.1',
      port: 18789,
      deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      deviceToken: 'tok.sig',
      pairingCode: 'XYZ12345',
    });
    await store.markApproved('127.0.0.1', 18789);
    const read = await store.read('127.0.0.1', 18789);
    expect(read).not.toBeNull();
    expect(read?.deviceToken).toBe('tok.sig');
    expect(read?.pairingCode).toBeUndefined();
  });

  it('markApproved on a missing identity is a no-op', async () => {
    const store = openClawgUiIdentityStore(keystore);
    await expect(store.markApproved('nowhere', 18789)).resolves.toBeUndefined();
  });

  it('isolates entries per host:port', async () => {
    const store = openClawgUiIdentityStore(keystore);
    await store.upsert({
      host: 'a',
      port: 1,
      deviceId: 'id-a',
      deviceToken: 'tok-a',
    });
    await store.upsert({
      host: 'b',
      port: 2,
      deviceId: 'id-b',
      deviceToken: 'tok-b',
    });
    expect((await store.read('a', 1))?.deviceToken).toBe('tok-a');
    expect((await store.read('b', 2))?.deviceToken).toBe('tok-b');
    expect(await store.read('a', 2)).toBeNull();
  });

  it('lists every persisted identity sorted by host:port', async () => {
    const store = openClawgUiIdentityStore(keystore);
    await store.upsert({ host: 'z', port: 1, deviceId: 'idz', deviceToken: 'tz' });
    await store.upsert({ host: 'a', port: 1, deviceId: 'ida', deviceToken: 'ta' });
    const all = await store.list();
    expect(all.map((i) => i.host)).toEqual(['a', 'z']);
  });

  it('remove deletes the entry', async () => {
    const store = openClawgUiIdentityStore(keystore);
    await store.upsert({
      host: 'h',
      port: 1,
      deviceId: 'idx',
      deviceToken: 'tx',
    });
    await store.remove('h', 1);
    expect(await store.read('h', 1)).toBeNull();
  });

  it('survives a corrupted keystore blob (returns null + recovers on next write)', async () => {
    await keystore.setSecret(CLAWG_UI_IDENTITIES_ACCOUNT, 'this-is-not-json');
    const store = openClawgUiIdentityStore(keystore);
    expect(await store.read('h', 1)).toBeNull();
    await store.upsert({
      host: 'h',
      port: 1,
      deviceId: 'idx',
      deviceToken: 'tx',
    });
    expect((await store.read('h', 1))?.deviceToken).toBe('tx');
  });
});
