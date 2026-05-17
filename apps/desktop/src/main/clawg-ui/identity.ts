// Per-gateway clawg-ui identity + device-token persistence (P11A).
//
// The `@contextableai/clawg-ui` plugin (vendored at `vendor/clawg-ui/`
// @ v0.7.0) authenticates AG-UI requests with an HMAC-signed device
// token (`vendor/clawg-ui/src/http-handler.ts:97–136`) minted on the
// first unauthenticated POST and returned in the 403 `pairing_pending`
// body alongside a 6-digit pairing code the user approves on the
// gateway host via `openclaw pairing approve clawg-ui <code>`. Once the
// user approves, every subsequent request with `Authorization: Bearer
// <deviceToken>` succeeds.
//
// We persist the per-gateway identity (device id, token, last-known
// pairing code) so the desktop can survive restarts without re-doing
// the pairing dance. The identity is keyed by `host:port` because a
// single desktop may eventually talk to more than one clawg-ui-enabled
// daemon (e.g. a dev gateway on localhost and a home-server gateway on
// the LAN).
//
// Storage backs onto the existing `Keystore` facade (`pair/keystore.ts`)
// under a single JSON namespace `clawgUiIdentities`. We only ever hold
// the parsed object in memory long enough to mutate + write back — no
// caching, no listeners. Throughput is one write per pairing-approval +
// occasional reads on boot, so a JSON round-trip per call is fine.
//
// The pairing flow itself (the desktop button that runs
// `openclaw pairing approve clawg-ui <code>` for the user) lives in
// P11B. This module only owns persistence + a tiny accessor surface.

import type { Keystore } from '../pair/keystore';

/** Account name (under `KEYSTORE_SERVICE`) that holds the JSON envelope. */
export const CLAWG_UI_IDENTITIES_ACCOUNT = 'clawgUiIdentities';

/** A single clawg-ui device identity, keyed by `host:port`. */
export interface ClawgUiIdentity {
  /** Upstream daemon host (matches the value in `settings.gateway_host`). */
  host: string;
  /** Upstream daemon port (matches the value in `settings.gateway_port`). */
  port: number;
  /** UUID minted by the plugin on first unauthenticated POST. */
  deviceId: string;
  /** HMAC-signed bearer token returned in the 403 `pairing_pending` body. */
  deviceToken: string;
  /**
   * Last-known pairing code returned by the plugin. Cleared once the
   * desktop observes a successful authenticated POST (set via
   * `markApproved()`). Surfaced in the Settings UI so the user sees
   * "Pairing pending — code `ABCD1234`" rather than just "Not paired".
   */
  pairingCode?: string;
}

/** JSON envelope persisted under {@link CLAWG_UI_IDENTITIES_ACCOUNT}. */
interface IdentityEnvelope {
  version: 1;
  /** `host:port` → identity. */
  entries: Record<string, ClawgUiIdentity>;
}

function emptyEnvelope(): IdentityEnvelope {
  return { version: 1, entries: {} };
}

function makeKey(host: string, port: number): string {
  return `${host}:${port}`;
}

async function readEnvelope(keystore: Keystore): Promise<IdentityEnvelope> {
  const raw = await keystore.getSecret(CLAWG_UI_IDENTITIES_ACCOUNT);
  if (!raw) return emptyEnvelope();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted blob — overwrite on next write. Don't throw; the boot path
    // should not crash because the keystore got into a weird state.
    return emptyEnvelope();
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as IdentityEnvelope).version !== 1 ||
    typeof (parsed as IdentityEnvelope).entries !== 'object' ||
    (parsed as IdentityEnvelope).entries === null
  ) {
    return emptyEnvelope();
  }
  return parsed as IdentityEnvelope;
}

async function writeEnvelope(keystore: Keystore, envelope: IdentityEnvelope): Promise<void> {
  await keystore.setSecret(CLAWG_UI_IDENTITIES_ACCOUNT, JSON.stringify(envelope));
}

/** Read-only handle for diagnostics — does NOT mint a new identity. */
export interface ClawgUiIdentityHandle {
  /** Snapshot of the persisted identity for `host:port`, or `null` if absent. */
  read(host: string, port: number): Promise<ClawgUiIdentity | null>;
  /**
   * Persist a fresh identity (or overwrite an existing one) for
   * `host:port`. Returns the same identity for chaining.
   */
  upsert(identity: ClawgUiIdentity): Promise<ClawgUiIdentity>;
  /**
   * Convenience: persist the `deviceId` / `deviceToken` / `pairingCode`
   * the plugin returned in a 403 `pairing_pending` response. Caller
   * supplies `host`/`port` because the response itself doesn't echo them
   * back.
   */
  recordPairingPending(opts: {
    host: string;
    port: number;
    deviceId: string;
    deviceToken: string;
    pairingCode: string;
  }): Promise<ClawgUiIdentity>;
  /**
   * Mark an identity as approved — clears the `pairingCode` field but
   * leaves the device id + token intact. No-op if no identity exists for
   * `host:port`. Called from the client after the first authenticated
   * 2xx response (i.e. when the gateway accepted the bearer token).
   */
  markApproved(host: string, port: number): Promise<void>;
  /** Remove the identity for `host:port`. Used by tests + manual reset. */
  remove(host: string, port: number): Promise<void>;
  /** List every persisted identity, sorted by `host:port`. */
  list(): Promise<ClawgUiIdentity[]>;
}

/**
 * Open the clawg-ui identity store backed by the given keystore. Each
 * call returns a fresh handle, but they all observe the same persisted
 * state — there's no in-memory cache.
 */
export function openClawgUiIdentityStore(keystore: Keystore): ClawgUiIdentityHandle {
  return {
    async read(host, port) {
      const env = await readEnvelope(keystore);
      return env.entries[makeKey(host, port)] ?? null;
    },
    async upsert(identity) {
      const env = await readEnvelope(keystore);
      env.entries[makeKey(identity.host, identity.port)] = { ...identity };
      await writeEnvelope(keystore, env);
      return identity;
    },
    async recordPairingPending(opts) {
      const env = await readEnvelope(keystore);
      const next: ClawgUiIdentity = {
        host: opts.host,
        port: opts.port,
        deviceId: opts.deviceId,
        deviceToken: opts.deviceToken,
        pairingCode: opts.pairingCode,
      };
      env.entries[makeKey(opts.host, opts.port)] = next;
      await writeEnvelope(keystore, env);
      return next;
    },
    async markApproved(host, port) {
      const env = await readEnvelope(keystore);
      const key = makeKey(host, port);
      const current = env.entries[key];
      if (!current) return;
      if (current.pairingCode === undefined) return;
      const { pairingCode: _drop, ...rest } = current;
      void _drop;
      env.entries[key] = rest;
      await writeEnvelope(keystore, env);
    },
    async remove(host, port) {
      const env = await readEnvelope(keystore);
      const key = makeKey(host, port);
      if (!(key in env.entries)) return;
      delete env.entries[key];
      await writeEnvelope(keystore, env);
    },
    async list() {
      const env = await readEnvelope(keystore);
      return Object.keys(env.entries)
        .sort()
        .map((k) => env.entries[k] as ClawgUiIdentity);
    },
  };
}
