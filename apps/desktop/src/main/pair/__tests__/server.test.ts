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

  // Q46: in clawg-ui mode the main process passes `clawgUiBaseUrl` to
  // `buildPairingServer` and the desktop must echo it back in
  // /pair/status's approval payload so mobile can route real-mode chat
  // at `<clawgUiBaseUrl>/v1/clawg-ui`. In stub mode (no option passed)
  // the field is intentionally omitted — older mobile builds don't know
  // how to interpret it.
  it('echoes clawg_ui_base_url in /pair/status when desktop is in clawg-ui mode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'openclaw-server-q46-'));
    const signingKey = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.server-test-q46');
    const deviceStore = new DeviceStore(tmp);
    const server = buildPairingServer({
      signingKey,
      gatewayId: 'gw-q46',
      deviceStore,
      version: '0.0.0-test',
      clawgUiBaseUrl: 'http://192.168.1.42:18789',
    });
    try {
      const create = await server.fastify.inject({
        method: 'POST',
        url: '/pair/request',
        payload: { device_name: 'Phone Q46', public_key: 'pk-q46' },
      });
      const { pair_id } = create.json() as { pair_id: string };
      server.approve(pair_id);
      const status = await server.fastify.inject({
        method: 'GET',
        url: `/pair/status?pair_id=${encodeURIComponent(pair_id)}`,
      });
      const body = status.json() as { clawg_ui_base_url?: string };
      expect(body.clawg_ui_base_url).toBe('http://192.168.1.42:18789');
    } finally {
      await server.fastify.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('omits clawg_ui_base_url in /pair/status when not provided (stub mode)', async () => {
    // Reuse the default harness — `buildHarness()` doesn't pass
    // `clawgUiBaseUrl`, modelling stub mode.
    const create = await h.server.fastify.inject({
      method: 'POST',
      url: '/pair/request',
      payload: { device_name: 'Phone Stub', public_key: 'pk-stub' },
    });
    const { pair_id } = create.json() as { pair_id: string };
    h.server.approve(pair_id);
    const status = await h.server.fastify.inject({
      method: 'GET',
      url: `/pair/status?pair_id=${encodeURIComponent(pair_id)}`,
    });
    const body = status.json() as Record<string, unknown>;
    expect('clawg_ui_base_url' in body).toBe(false);
  });

  // P08B: /devices/:id/push-token route. After a phone pairs it POSTs
  // its Expo push token; the desktop persists it on the PairedDevice
  // record so the dispatcher can later look it up.
  describe('POST /devices/:id/push-token', () => {
    interface Approved {
      deviceId: string;
      token: string;
    }

    async function pairAndApprove(name: string): Promise<Approved> {
      const create = await h.server.fastify.inject({
        method: 'POST',
        url: '/pair/request',
        payload: { device_name: name, public_key: `pk-${name}` },
      });
      const { pair_id } = create.json() as { pair_id: string };
      const approved = h.server.approve(pair_id);
      if (!approved?.token || !approved.device_id) {
        throw new Error('failed to approve fixture');
      }
      return { deviceId: approved.device_id, token: approved.token };
    }

    it('persists a token for an authenticated device', async () => {
      const a = await pairAndApprove('Phone A');
      const res = await h.server.fastify.inject({
        method: 'POST',
        url: `/devices/${a.deviceId}/push-token`,
        headers: { Authorization: `Bearer ${a.token}` },
        payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const listed = h.deviceStore.listDevices().find((d) => d.device_id === a.deviceId);
      expect(listed?.pushToken).toBe('ExponentPushToken[abc]');
      expect(listed?.pushPlatform).toBe('ios');
    });

    it('rejects an unauthenticated request with 401', async () => {
      const a = await pairAndApprove('Phone A');
      const res = await h.server.fastify.inject({
        method: 'POST',
        url: `/devices/${a.deviceId}/push-token`,
        payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a request whose token belongs to a different device with 403', async () => {
      const a = await pairAndApprove('Phone A');
      const b = await pairAndApprove('Phone B');
      const res = await h.server.fastify.inject({
        method: 'POST',
        url: `/devices/${a.deviceId}/push-token`,
        headers: { Authorization: `Bearer ${b.token}` },
        payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a malformed body with 400', async () => {
      const a = await pairAndApprove('Phone A');
      const missing = await h.server.fastify.inject({
        method: 'POST',
        url: `/devices/${a.deviceId}/push-token`,
        headers: { Authorization: `Bearer ${a.token}` },
        payload: { platform: 'ios' },
      });
      expect(missing.statusCode).toBe(400);

      const badPlatform = await h.server.fastify.inject({
        method: 'POST',
        url: `/devices/${a.deviceId}/push-token`,
        headers: { Authorization: `Bearer ${a.token}` },
        payload: { token: 'ExponentPushToken[abc]', platform: 'web' },
      });
      expect(badPlatform.statusCode).toBe(400);
    });
  });
});
