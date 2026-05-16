// Handshake unit tests for the real-gateway bridge.
//
// We mock the upstream JSON-RPC peer with an in-memory `HandshakeTransport`
// and assert that:
//
//   - First-time connect: signed device payload echoes the server nonce,
//     auth.bootstrapToken is present, and the returned deviceToken is
//     surfaced + persisted via `persistBridgeDeviceToken`.
//   - Reconnect: with a deviceToken cached and no bootstrapToken, the
//     handshake still completes (uses auth.deviceToken).
//   - The signature is verifiable with the matching public key (so we
//     know we're signing the right canonical buffer).
//   - Protocol-version mismatch and explicit error envelopes throw with
//     stable codes.
//
// We don't spawn a real daemon. Per the P10A scope, live tests are P10C.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { openKeystore, type Keystore } from '../../pair/keystore';
import {
  BRIDGE_CLIENT_ID,
  BRIDGE_DEVICE_TOKEN_ACCOUNT,
  BRIDGE_KEY_ACCOUNT,
  BRIDGE_PROTOCOL_VERSION,
  loadOrCreateBridgeIdentity,
  performConnect,
  persistBridgeDeviceToken,
  signDevicePayload,
  type BridgeIdentity,
  type HandshakeTransport,
  type UpstreamFrame,
} from '../openclaw-bridge-handshake';

interface Peer {
  transport: HandshakeTransport;
  sent: UpstreamFrame[];
  /** Push an inbound frame the bridge will see on its next `recv()`. */
  push(frame: UpstreamFrame): void;
  /** Close the simulated socket (recv returns null). */
  close(): void;
}

function mockPeer(): Peer {
  const sent: UpstreamFrame[] = [];
  const inbound: UpstreamFrame[] = [];
  const waiters: Array<(frame: UpstreamFrame | null) => void> = [];
  let closed = false;
  return {
    sent,
    push(frame) {
      const w = waiters.shift();
      if (w) {
        w(frame);
      } else {
        inbound.push(frame);
      }
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.(null);
      }
    },
    transport: {
      send(frame) {
        sent.push(frame);
      },
      recv() {
        const q = inbound.shift();
        if (q) return Promise.resolve(q);
        if (closed) return Promise.resolve(null);
        return new Promise<UpstreamFrame | null>((resolve) => {
          waiters.push(resolve);
        });
      },
    },
  };
}

let tmp: string;
let keystore: Keystore;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'openclaw-bridge-handshake-'));
  keystore = await openKeystore(tmp, 'dev.openclaw.bridge.test');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadOrCreateBridgeIdentity', () => {
  it('creates + persists a key on first call, reuses it on second', async () => {
    const a = await loadOrCreateBridgeIdentity(keystore);
    const b = await loadOrCreateBridgeIdentity(keystore);
    expect(a.publicKeyB64u).toBe(b.publicKeyB64u);
    expect(a.deviceId).toBe(b.deviceId);
    expect(await keystore.getSecret(BRIDGE_KEY_ACCOUNT)).not.toBeNull();
    expect(a.deviceToken).toBeNull();
  });

  it('surfaces a previously-persisted deviceToken', async () => {
    await loadOrCreateBridgeIdentity(keystore);
    await persistBridgeDeviceToken(keystore, 'tok-cached');
    const reloaded = await loadOrCreateBridgeIdentity(keystore);
    expect(reloaded.deviceToken).toBe('tok-cached');
  });
});

describe('signDevicePayload', () => {
  it('produces a signature verifiable with the matching public key', async () => {
    const id = await loadOrCreateBridgeIdentity(keystore);
    const privateKey = await keyFromIdentity(id);
    const signed = signDevicePayload({
      deviceId: id.deviceId,
      publicKeyB64u: id.publicKeyB64u,
      privateKey,
      nonce: 'nonce-abc',
      signedAt: 12345,
    });
    expect(signed.nonce).toBe('nonce-abc');
    expect(signed.publicKey).toBe(id.publicKeyB64u);

    const canonical = JSON.stringify({
      id: id.deviceId,
      publicKey: id.publicKeyB64u,
      signedAt: 12345,
      nonce: 'nonce-abc',
    });
    const sigBuf = Buffer.from(signed.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const publicKey = createPublicKey(privateKey);
    expect(cryptoVerify(null, Buffer.from(canonical, 'utf8'), publicKey, sigBuf)).toBe(true);
  });
});

describe('performConnect', () => {
  it('first-time pair: sends bootstrapToken, persists issued deviceToken', async () => {
    const id = await loadOrCreateBridgeIdentity(keystore);
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-1' } });

    const handshake = performConnect({
      transport: peer.transport,
      identity: id,
      bootstrapToken: 'boot-1',
      now: () => 999_000,
    });

    // Allow the handshake to consume the challenge + emit its connect req.
    await Promise.resolve();
    await Promise.resolve();

    expect(peer.sent).toHaveLength(1);
    const req = peer.sent[0]!;
    expect(req.type).toBe('req');
    if (req.type !== 'req') throw new Error('unreachable');
    expect(req.method).toBe('connect');
    const params = req.params as Record<string, unknown>;
    expect((params['client'] as { id: string }).id).toBe(BRIDGE_CLIENT_ID);
    const device = params['device'] as { nonce: string; signedAt: number; publicKey: string };
    expect(device.nonce).toBe('n-1');
    expect(device.signedAt).toBe(999_000);
    expect(device.publicKey).toBe(id.publicKeyB64u);
    expect((params['auth'] as { bootstrapToken?: string }).bootstrapToken).toBe('boot-1');
    expect((params['auth'] as { deviceToken?: string }).deviceToken).toBeUndefined();

    // Server responds with HelloOk + a fresh deviceToken.
    peer.push({
      type: 'res',
      id: req.id,
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: BRIDGE_PROTOCOL_VERSION,
        server: { version: '1.0.0', connId: 'c1' },
        features: { methods: ['agents.list', 'chat.send'], events: ['chat.delta'] },
        auth: { deviceToken: 'tok-fresh', role: 'node', scopes: ['operator.read'] },
      },
    });

    const result = await handshake;
    expect(result.deviceToken).toBe('tok-fresh');
    expect(result.hello.auth.deviceToken).toBe('tok-fresh');
    expect(result.hello.features?.methods).toContain('chat.send');

    await persistBridgeDeviceToken(keystore, result.deviceToken);
    expect(await keystore.getSecret(BRIDGE_DEVICE_TOKEN_ACCOUNT)).toBe('tok-fresh');
  });

  it('reconnect: uses cached deviceToken, no bootstrapToken needed', async () => {
    const base = await loadOrCreateBridgeIdentity(keystore);
    const id: BridgeIdentity = { ...base, deviceToken: 'tok-cached' };
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-2' } });

    const handshake = performConnect({ transport: peer.transport, identity: id });
    await Promise.resolve();
    await Promise.resolve();

    const req = peer.sent[0]!;
    if (req.type !== 'req') throw new Error('unreachable');
    const params = req.params as Record<string, unknown>;
    const auth = params['auth'] as { bootstrapToken?: string; deviceToken?: string };
    expect(auth.deviceToken).toBe('tok-cached');
    expect(auth.bootstrapToken).toBeUndefined();

    peer.push({
      type: 'res',
      id: req.id,
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: BRIDGE_PROTOCOL_VERSION,
        server: { version: '1.0.0', connId: 'c2' },
        auth: { role: 'node', scopes: ['operator.read'] },
      },
    });

    const result = await handshake;
    // No new deviceToken issued — we fall back to the cached one.
    expect(result.deviceToken).toBe('tok-cached');
  });

  it('throws when neither bootstrapToken nor deviceToken is available', async () => {
    const base = await loadOrCreateBridgeIdentity(keystore);
    const id: BridgeIdentity = { ...base, deviceToken: null };
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-3' } });
    await expect(performConnect({ transport: peer.transport, identity: id })).rejects.toMatchObject(
      { code: 'connect.no-credentials' },
    );
  });

  it('rejects with a stable code on bad challenge frame', async () => {
    const id = await loadOrCreateBridgeIdentity(keystore);
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'tick', payload: { ts: 1 } });
    await expect(
      performConnect({
        transport: peer.transport,
        identity: id,
        bootstrapToken: 'boot',
      }),
    ).rejects.toMatchObject({ code: 'connect.unexpected-frame' });
  });

  it('throws on a protocol-version mismatch in HelloOk', async () => {
    const id = await loadOrCreateBridgeIdentity(keystore);
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-4' } });
    const handshake = performConnect({
      transport: peer.transport,
      identity: id,
      bootstrapToken: 'boot',
    });
    await Promise.resolve();
    await Promise.resolve();
    const req = peer.sent[0]!;
    if (req.type !== 'req') throw new Error('unreachable');
    peer.push({
      type: 'res',
      id: req.id,
      ok: true,
      payload: {
        type: 'hello-ok',
        protocol: 99,
        server: { version: 'old', connId: 'c-old' },
        auth: { deviceToken: 't', role: 'node', scopes: [] },
      },
    });
    await expect(handshake).rejects.toMatchObject({ code: 'connect.protocol-mismatch' });
  });

  it('surfaces upstream-error code on ok:false connect response', async () => {
    const id = await loadOrCreateBridgeIdentity(keystore);
    const peer = mockPeer();
    peer.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-5' } });
    const handshake = performConnect({
      transport: peer.transport,
      identity: id,
      bootstrapToken: 'boot',
    });
    await Promise.resolve();
    await Promise.resolve();
    const req = peer.sent[0]!;
    if (req.type !== 'req') throw new Error('unreachable');
    peer.push({
      type: 'res',
      id: req.id,
      ok: false,
      error: { code: 'auth.bad-bootstrap', message: 'bootstrap token expired' },
    });
    await expect(handshake).rejects.toMatchObject({ code: 'auth.bad-bootstrap' });
  });
});

async function keyFromIdentity(id: BridgeIdentity) {
  const { createPrivateKey } = await import('node:crypto');
  return createPrivateKey({ key: id.privateKeyPem, format: 'pem' });
}
