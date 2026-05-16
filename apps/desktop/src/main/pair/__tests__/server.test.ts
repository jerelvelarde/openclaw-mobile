// Pairing server integration tests via fastify's `inject` — no live HTTP
// listener needed, which keeps the test suite runnable in the Linux dev
// container (no port allocation, no firewall surprises).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey } from '../keypair';
import { DeviceStore } from '../store';
import { buildPairingServer, PairingServer, RUNTIME_URL_PLACEHOLDER } from '../server';
import { verifyToken } from '../token';

interface Harness {
  server: PairingServer;
  deviceStore: DeviceStore;
  publicKey: import('node:crypto').KeyObject;
  gatewayId: string;
  tmp: string;
  pendingCalls: number;
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'openclaw-server-'));
  const signingKey = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.server-test');
  const deviceStore = new DeviceStore(tmp);
  const gatewayId = 'gw-test-1';
  let pendingCalls = 0;
  const server = buildPairingServer({
    signingKey,
    gatewayId,
    deviceStore,
    version: '0.0.0-test',
    onPendingPair: () => {
      pendingCalls += 1;
    },
  });
  return {
    server,
    deviceStore,
    publicKey: signingKey.publicKey,
    gatewayId,
    tmp,
    get pendingCalls() {
      return pendingCalls;
    },
  };
}

describe('pairing server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.server.fastify.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('GET /healthz returns gateway metadata', async () => {
    const res = await h.server.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      gateway_id: h.gatewayId,
      version: '0.0.0-test',
    });
  });

  it('POST /pair/request returns a code + pair_id and fires onPendingPair', async () => {
    const res = await h.server.fastify.inject({
      method: 'POST',
      url: '/pair/request',
      payload: { device_name: 'Test Phone', public_key: 'BASE64=KEY' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pair_id: string; code: string; expires_at: number };
    expect(body.pair_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.expires_at).toBeGreaterThan(Date.now());
    expect(h.pendingCalls).toBe(1);
  });

  it('POST /pair/request rejects missing fields with 400', async () => {
    const res = await h.server.fastify.inject({
      method: 'POST',
      url: '/pair/request',
      payload: { device_name: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /pair/status returns pending then approved with token + runtime_url', async () => {
    const create = await h.server.fastify.inject({
      method: 'POST',
      url: '/pair/request',
      payload: { device_name: 'Phone B', public_key: 'pk-b' },
    });
    const { pair_id } = create.json() as { pair_id: string };

    const pending = await h.server.fastify.inject({
      method: 'GET',
      url: `/pair/status?pair_id=${encodeURIComponent(pair_id)}`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({ status: 'pending' });

    const approved = h.server.approve(pair_id);
    expect(approved?.status).toBe('approved');

    const post = await h.server.fastify.inject({
      method: 'GET',
      url: `/pair/status?pair_id=${encodeURIComponent(pair_id)}`,
    });
    expect(post.statusCode).toBe(200);
    const body = post.json() as { status: string; token: string; runtime_url: string };
    expect(body.status).toBe('approved');
    expect(body.runtime_url).toBe(RUNTIME_URL_PLACEHOLDER);
    const claim = verifyToken(h.publicKey, body.token);
    expect(claim?.device_name).toBe('Phone B');
    expect(claim?.gateway_id).toBe(h.gatewayId);
    expect(h.deviceStore.listDevices()).toHaveLength(1);
    expect(h.deviceStore.listDevices()[0]?.device_name).toBe('Phone B');
  });

  it('GET /pair/status reports denied after server.deny()', async () => {
    const create = await h.server.fastify.inject({
      method: 'POST',
      url: '/pair/request',
      payload: { device_name: 'Phone C', public_key: 'pk-c' },
    });
    const { pair_id } = create.json() as { pair_id: string };
    expect(h.server.deny(pair_id)).not.toBeNull();
    const res = await h.server.fastify.inject({
      method: 'GET',
      url: `/pair/status?pair_id=${encodeURIComponent(pair_id)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'denied' });
  });

  it('GET /pair/status returns 404 for unknown pair_id', async () => {
    const res = await h.server.fastify.inject({
      method: 'GET',
      url: '/pair/status?pair_id=does-not-exist',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /pair/status requires the pair_id query', async () => {
    const res = await h.server.fastify.inject({ method: 'GET', url: '/pair/status' });
    expect(res.statusCode).toBe(400);
  });

  it('approve() is a no-op on an unknown pair_id', () => {
    expect(h.server.approve('does-not-exist')).toBeNull();
  });
});
