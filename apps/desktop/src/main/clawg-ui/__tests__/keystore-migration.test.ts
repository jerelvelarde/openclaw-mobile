// One-shot legacy-bridge keystore-cleanup migration (P11D).
//
// The P10A real-gateway bridge (deleted in P11D) used to write three
// keystore entries on first connect:
//   - `bridge-upstream-key` (Ed25519 PKCS#8 PEM)
//   - `bridge-upstream-device-id` (UUID)
//   - `bridge-upstream-device-token` (upstream-issued bearer)
//
// With the bridge gone those entries are orphaned. The migration in
// `clawg-ui/identity.ts#runLegacyBridgeKeystoreCleanup` wipes them on
// the next boot of a post-P11D build. These tests verify the two
// branches that matter:
//
//   1. On a clean keystore (e.g. fresh install), the migration is a
//      pure no-op — it returns an empty array and writes nothing.
//   2. On a keystore pre-populated with the three legacy entries (e.g.
//      a Wave 14 user upgrading), the migration removes all three and
//      returns the list of removed account names.
//
// We back against an in-memory fake `Keystore` so the test stays
// hermetic and so the assertion can observe `setSecret` / `deleteSecret`
// calls precisely. The file-encrypted backend is exercised in
// `pair/__tests__/keystore.test.ts`.

import { describe, expect, it } from 'vitest';
import { LEGACY_BRIDGE_KEYSTORE_ACCOUNTS, runLegacyBridgeKeystoreCleanup } from '../identity';
import type { Keystore } from '../../pair/keystore';

/** Minimal in-memory `Keystore` for the migration test. */
function memoryKeystore(seed: Record<string, string> = {}): Keystore & {
  snapshot(): Record<string, string>;
  deleteCalls(): string[];
} {
  const entries: Record<string, string> = { ...seed };
  const deletes: string[] = [];
  return {
    backend: 'file' as const,
    async getSecret(account) {
      return Object.prototype.hasOwnProperty.call(entries, account)
        ? (entries[account] as string)
        : null;
    },
    async setSecret(account, value) {
      entries[account] = value;
    },
    async deleteSecret(account) {
      deletes.push(account);
      if (!Object.prototype.hasOwnProperty.call(entries, account)) return false;
      delete entries[account];
      return true;
    },
    snapshot() {
      return { ...entries };
    },
    deleteCalls() {
      return [...deletes];
    },
  };
}

describe('runLegacyBridgeKeystoreCleanup', () => {
  it('is a no-op on a clean keystore (returns [] without crashing)', async () => {
    const ks = memoryKeystore();
    const removed = await runLegacyBridgeKeystoreCleanup(ks);
    expect(removed).toEqual([]);
    // The migration still attempts a delete for each known account so
    // the keytar backend gets the chance to noop — assert we called
    // each one exactly once.
    expect(ks.deleteCalls()).toEqual([...LEGACY_BRIDGE_KEYSTORE_ACCOUNTS]);
    expect(ks.snapshot()).toEqual({});
  });

  it('wipes every legacy bridge entry on a Wave-14 keystore (returns the names)', async () => {
    const ks = memoryKeystore({
      'bridge-upstream-key':
        '-----BEGIN PRIVATE KEY----- pretend ed25519 -----END PRIVATE KEY-----',
      'bridge-upstream-device-id': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'bridge-upstream-device-token': 'tok.sig',
      // Unrelated entries that MUST survive (e.g. the desktop's own
      // signing key, the clawg-ui identity envelope).
      'signing-key': '-----BEGIN PRIVATE KEY----- desktop -----END PRIVATE KEY-----',
      clawgUiIdentities: '{"version":1,"entries":{}}',
    });
    const removed = await runLegacyBridgeKeystoreCleanup(ks);
    expect(removed.sort()).toEqual([...LEGACY_BRIDGE_KEYSTORE_ACCOUNTS].sort());
    const snap = ks.snapshot();
    expect(snap['bridge-upstream-key']).toBeUndefined();
    expect(snap['bridge-upstream-device-id']).toBeUndefined();
    expect(snap['bridge-upstream-device-token']).toBeUndefined();
    // Unrelated entries are untouched.
    expect(snap['signing-key']).toMatch(/desktop/);
    expect(snap['clawgUiIdentities']).toBe('{"version":1,"entries":{}}');
  });

  it('swallows backend failures (returns whichever accounts succeeded)', async () => {
    let calls = 0;
    const throwingKeystore: Keystore = {
      backend: 'file' as const,
      async getSecret() {
        return null;
      },
      async setSecret() {
        // unused
      },
      async deleteSecret(account) {
        calls += 1;
        // Fail on the middle account; the migration must keep going.
        if (account === 'bridge-upstream-device-id') {
          throw new Error('simulated keytar failure');
        }
        return true;
      },
    };
    const removed = await runLegacyBridgeKeystoreCleanup(throwingKeystore);
    // The two non-throwing accounts come back; the throwing one is
    // silently dropped from the result.
    expect(removed).toEqual(['bridge-upstream-key', 'bridge-upstream-device-token']);
    expect(calls).toBe(3);
  });
});
