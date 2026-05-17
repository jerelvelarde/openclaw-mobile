/**
 * @deprecated The P10A bridge is superseded by the clawg-ui pivot
 * (`vendor/clawg-ui/` @ v0.7.0). Real-mode chat now POSTs directly to
 * the gateway's clawg-ui plugin, which has its own HTTP pairing
 * handshake (`vendor/clawg-ui/src/http-handler.ts:260–338`) — no
 * Ed25519 challenge/response, no WebSocket connect frame. See
 * `.chalk/plans/P11A-adopt-clawg-ui-clients.md` for the replacement
 * (`apps/desktop/src/main/clawg-ui/identity.ts` +
 * `apps/desktop/src/main/clawg-ui/client.ts`). This module is scheduled
 * for removal in `.chalk/plans/P11D-tear-down-openclaw-bridge.md`.
 */

// Pairing + connect handshake for the upstream OpenClaw gateway.
//
// Per `.chalk/openclaw-upstream.md` §3.3 + §9, the wire to the real
// `openclaw gateway` daemon is:
//
//   1. Open a WebSocket. The server immediately emits
//      `{type:"event", event:"connect.challenge", payload:{ nonce }}`.
//   2. Build a `ConnectParams` payload with our `client` identity, our
//      `device` block (id + base64url(publicKey) + base64url(signature
//      over a canonical buffer that embeds the nonce) + signedAt + the
//      echoed nonce), and an `auth` block carrying either a
//      `bootstrapToken` (first time) or a `deviceToken` (every reconnect
//      after the first successful pair).
//   3. Send `{type:"req", id:<uuid>, method:"connect", params: …}`.
//   4. Read the matching `{type:"res", id, ok:true, payload: HelloOk}`.
//      `HelloOk.auth.deviceToken` is the long-lived credential we
//      persist and use on every subsequent reconnect.
//
// This file is split out from `openclaw-bridge.ts` so the signing /
// keypair / token-persistence logic can be unit-tested against a mocked
// JSON-RPC peer without spinning up the whole bridge.
//
// The signed payload format is `signDevicePayload()` /
// `buildDeviceAuthPayloadV3()` in `src/gateway/client.ts:561–581` of the
// upstream tree. The canonical layout below mirrors that: a UTF-8 JSON
// stringification of `{ id, publicKey, signedAt, nonce }` (no key
// reordering, fields in source order). Upstream is permissive on what
// goes in — they sign the same set of fields we echo back in
// `device.*` — so this matches the v3 contract documented in `frames.ts`.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto';
import { hostname, platform as osPlatform } from 'node:os';
import type { Keystore } from '../pair/keystore';

/** Account name under `KEYSTORE_SERVICE` that holds the upstream-bridge Ed25519 key. */
export const BRIDGE_KEY_ACCOUNT = 'bridge-upstream-key';
/** Account name that holds the long-lived upstream-issued device token. */
export const BRIDGE_DEVICE_TOKEN_ACCOUNT = 'bridge-upstream-device-token';
/** Stable client id we advertise to upstream. Plumbed into `ConnectParams.client.id`. */
export const BRIDGE_CLIENT_ID = 'openclaw-desktop-bridge';
/** Protocol version we send + minimum we accept. Mirrors upstream `PROTOCOL_VERSION = 4`. */
export const BRIDGE_PROTOCOL_VERSION = 4;
/** Stable per-bridge device id derived from the host + persisted alongside the key. */
export const BRIDGE_DEVICE_ID_ACCOUNT = 'bridge-upstream-device-id';

/** Shape of the upstream-issued credentials we persist after a successful connect. */
export interface BridgeIdentity {
  /** PKCS#8 PEM of our Ed25519 private key. */
  privateKeyPem: string;
  /** Base64url of the SPKI-encoded raw 32-byte Ed25519 public key. */
  publicKeyB64u: string;
  /** Stable device id we register under (uuid; persisted on first run). */
  deviceId: string;
  /** Long-lived upstream-issued credential. Null until the first successful connect. */
  deviceToken: string | null;
}

/** Discriminated upstream frame union. Mirrors `frames.ts:138–177`. */
export type UpstreamFrame =
  | { type: 'req'; id: string; method: string; params?: unknown }
  | {
      type: 'res';
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: UpstreamErrorShape;
    }
  | {
      type: 'event';
      event: string;
      payload?: unknown;
      seq?: number;
      stateVersion?: unknown;
    };

/** Error envelope per `frames.ts:127–136`. */
export interface UpstreamErrorShape {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** Subset of `HelloOk` we actually consume in the bridge. Full shape at `frames.ts:73–125`. */
export interface UpstreamHelloOk {
  type: 'hello-ok';
  protocol: number;
  server: { version: string; connId: string };
  features?: { methods?: string[]; events?: string[] };
  snapshot?: unknown;
  pluginSurfaceUrls?: Record<string, string>;
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
  };
  policy?: {
    maxPayload?: number;
    maxBufferedBytes?: number;
    tickIntervalMs?: number;
  };
}

/** Result of a completed connect handshake. */
export interface HandshakeResult {
  hello: UpstreamHelloOk;
  /** The deviceToken we should use on the next reconnect (may be unchanged). */
  deviceToken: string;
}

/** Minimal pluggable transport so the handshake can be unit-tested without a real WS. */
export interface HandshakeTransport {
  /** Send a JSON-serialised frame. */
  send(frame: UpstreamFrame): void;
  /**
   * Read the next inbound frame. Must resolve in the order the wire
   * delivered them. Returns `null` if the peer closed the socket.
   */
  recv(): Promise<UpstreamFrame | null>;
}

/** Options for {@link performConnect}. */
export interface PerformConnectOptions {
  transport: HandshakeTransport;
  identity: BridgeIdentity;
  /** Optional one-shot pairing token (first-time pair). */
  bootstrapToken?: string;
  /** Override `client.displayName`. Defaults to `os.hostname()`. */
  clientDisplayName?: string;
  /** Override `client.version`. Defaults to `0.0.0`. */
  clientVersion?: string;
  /** Override `Date.now`. Injected by tests. */
  now?: () => number;
}

/**
 * Base64url-encode a buffer with no `=` padding. Upstream's signed-payload
 * helpers use this form (`src/gateway/client.ts:561+`).
 */
export function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Extract the raw 32-byte Ed25519 public key from a `KeyObject` and
 * return it as base64url. Node's SPKI export is 44 bytes total; the
 * actual key sits in the last 32 bytes after the ASN.1 prefix.
 */
export function publicKeyToBase64Url(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI for Ed25519 is fixed 44 bytes; raw key is the last 32 bytes.
  const raw = der.subarray(der.length - 32);
  return base64UrlEncode(raw);
}

/**
 * Build + sign the device payload that goes into `ConnectParams.device`.
 * The canonical serialisation we sign over is the JSON stringification of
 * `{ id, publicKey, signedAt, nonce }` in that key order — matching what
 * upstream's `buildDeviceAuthPayloadV3` constructs.
 */
export function signDevicePayload(opts: {
  deviceId: string;
  publicKeyB64u: string;
  privateKey: KeyObject;
  nonce: string;
  signedAt: number;
}): {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
} {
  const canonical = JSON.stringify({
    id: opts.deviceId,
    publicKey: opts.publicKeyB64u,
    signedAt: opts.signedAt,
    nonce: opts.nonce,
  });
  const sigBuf = cryptoSign(null, Buffer.from(canonical, 'utf8'), opts.privateKey);
  return {
    id: opts.deviceId,
    publicKey: opts.publicKeyB64u,
    signature: base64UrlEncode(sigBuf),
    signedAt: opts.signedAt,
    nonce: opts.nonce,
  };
}

/** Generate a fresh Ed25519 PKCS#8 PEM. Exposed for tests. */
export function generateBridgeKeyPem(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

/**
 * Load (or create on first run) the per-bridge Ed25519 keypair + the
 * stable device id from the given keystore. The deviceToken is loaded
 * if present but stays `null` until the first successful handshake.
 *
 * The keystore is the same facade `pair/keystore.ts` exposes for the
 * desktop's own signing key — we just register under a different
 * account so the two keys don't collide.
 */
export async function loadOrCreateBridgeIdentity(keystore: Keystore): Promise<BridgeIdentity> {
  let pem = await keystore.getSecret(BRIDGE_KEY_ACCOUNT);
  if (!pem) {
    pem = generateBridgeKeyPem();
    await keystore.setSecret(BRIDGE_KEY_ACCOUNT, pem);
  }
  let deviceId = await keystore.getSecret(BRIDGE_DEVICE_ID_ACCOUNT);
  if (!deviceId) {
    deviceId = randomUUID();
    await keystore.setSecret(BRIDGE_DEVICE_ID_ACCOUNT, deviceId);
  }
  const deviceToken = await keystore.getSecret(BRIDGE_DEVICE_TOKEN_ACCOUNT);
  const privateKey = createPrivateKey({ key: pem, format: 'pem' });
  const publicKey = createPublicKey(privateKey);
  const publicKeyB64u = publicKeyToBase64Url(publicKey);
  return {
    privateKeyPem: pem,
    publicKeyB64u,
    deviceId,
    deviceToken,
  };
}

/** Persist the freshly-issued deviceToken to the keystore. */
export async function persistBridgeDeviceToken(
  keystore: Keystore,
  deviceToken: string,
): Promise<void> {
  await keystore.setSecret(BRIDGE_DEVICE_TOKEN_ACCOUNT, deviceToken);
}

/**
 * Perform the connect handshake. Reads the `connect.challenge`, signs +
 * sends the `connect` request, awaits the matching response, and
 * returns the `HelloOk` body + the device token to persist.
 *
 * On any error (bad challenge, signature rejection, version mismatch,
 * peer close) throws an `Error` with a stable `code` property set to
 * one of the upstream error codes when applicable.
 */
export async function performConnect(opts: PerformConnectOptions): Promise<HandshakeResult> {
  const { transport, identity, bootstrapToken, clientDisplayName, clientVersion } = opts;
  const now = opts.now ?? Date.now;

  // 1. Wait for the connect.challenge event.
  const challenge = await transport.recv();
  if (!challenge) {
    throw bridgeError('connect.closed', 'gateway closed socket before challenge');
  }
  if (challenge.type !== 'event' || challenge.event !== 'connect.challenge') {
    throw bridgeError(
      'connect.unexpected-frame',
      `expected connect.challenge event, got ${frameLabel(challenge)}`,
    );
  }
  const nonce = readNonce(challenge.payload);
  if (!nonce) {
    throw bridgeError('connect.bad-challenge', 'connect.challenge payload missing nonce');
  }

  // 2. Build + send the signed connect req.
  const privateKey = createPrivateKey({ key: identity.privateKeyPem, format: 'pem' });
  const signedAt = now();
  const devicePayload = signDevicePayload({
    deviceId: identity.deviceId,
    publicKeyB64u: identity.publicKeyB64u,
    privateKey,
    nonce,
    signedAt,
  });
  const reqId = randomUUID();
  const auth: Record<string, string> = {};
  if (identity.deviceToken) auth.deviceToken = identity.deviceToken;
  if (bootstrapToken) auth.bootstrapToken = bootstrapToken;
  if (!auth.deviceToken && !auth.bootstrapToken) {
    throw bridgeError(
      'connect.no-credentials',
      'no deviceToken and no bootstrapToken — cannot authenticate',
    );
  }

  transport.send({
    type: 'req',
    id: reqId,
    method: 'connect',
    params: {
      minProtocol: BRIDGE_PROTOCOL_VERSION,
      maxProtocol: BRIDGE_PROTOCOL_VERSION,
      client: {
        id: BRIDGE_CLIENT_ID,
        displayName: clientDisplayName ?? hostname(),
        version: clientVersion ?? '0.0.0',
        platform: osPlatform(),
        mode: 'backend',
        instanceId: identity.deviceId,
      },
      role: 'node',
      device: devicePayload,
      auth,
    },
  });

  // 3. Read frames until we see the response for our connect id, ignoring
  // any other events that may arrive (server is allowed to emit ticks
  // etc. before/after the response).
  for (;;) {
    const next = await transport.recv();
    if (!next) {
      throw bridgeError('connect.closed', 'gateway closed socket before connect response');
    }
    if (next.type === 'event') {
      // Ignore stray events during handshake — the bridge owns the event
      // pump after we return, so we drop these on the floor.
      continue;
    }
    if (next.type === 'req') {
      // Server-initiated request before handshake completion is unusual;
      // ignore so we don't get stuck.
      continue;
    }
    if (next.type !== 'res' || next.id !== reqId) {
      continue;
    }
    if (!next.ok) {
      const err = next.error;
      throw bridgeError(
        err?.code ?? 'connect.rejected',
        err?.message ?? 'gateway rejected connect',
      );
    }
    const hello = parseHelloOk(next.payload);
    if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      throw bridgeError(
        'connect.protocol-mismatch',
        `gateway protocol ${hello.protocol} != bridge ${BRIDGE_PROTOCOL_VERSION}`,
      );
    }
    const deviceToken = hello.auth.deviceToken ?? identity.deviceToken;
    if (!deviceToken) {
      throw bridgeError(
        'connect.no-device-token',
        'gateway HelloOk omitted deviceToken and we had none cached',
      );
    }
    return { hello, deviceToken };
  }
}

function readNonce(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const n = (payload as { nonce?: unknown }).nonce;
  return typeof n === 'string' && n.length > 0 ? n : null;
}

function frameLabel(f: UpstreamFrame): string {
  if (f.type === 'event') return `event:${f.event}`;
  if (f.type === 'res') return `res:${f.id}`;
  return `req:${f.method}`;
}

function parseHelloOk(raw: unknown): UpstreamHelloOk {
  if (typeof raw !== 'object' || raw === null) {
    throw bridgeError('connect.bad-hello', 'HelloOk payload not an object');
  }
  const obj = raw as Record<string, unknown>;
  const auth = (obj['auth'] ?? {}) as Record<string, unknown>;
  return {
    type: 'hello-ok',
    protocol: typeof obj['protocol'] === 'number' ? (obj['protocol'] as number) : 0,
    server:
      typeof obj['server'] === 'object' && obj['server'] !== null
        ? (obj['server'] as { version: string; connId: string })
        : { version: 'unknown', connId: '' },
    features: obj['features'] as UpstreamHelloOk['features'] | undefined,
    snapshot: obj['snapshot'],
    pluginSurfaceUrls: obj['pluginSurfaceUrls'] as Record<string, string> | undefined,
    auth: {
      deviceToken:
        typeof auth['deviceToken'] === 'string' ? (auth['deviceToken'] as string) : undefined,
      role: typeof auth['role'] === 'string' ? (auth['role'] as string) : 'node',
      scopes: Array.isArray(auth['scopes']) ? (auth['scopes'] as string[]) : [],
      issuedAtMs:
        typeof auth['issuedAtMs'] === 'number' ? (auth['issuedAtMs'] as number) : undefined,
    },
    policy: obj['policy'] as UpstreamHelloOk['policy'] | undefined,
  };
}

/** Internal error type with a stable `code` for translator + logging. */
export interface BridgeError extends Error {
  code: string;
}

export function bridgeError(code: string, message: string): BridgeError {
  const err = new Error(message) as BridgeError;
  err.code = code;
  return err;
}
