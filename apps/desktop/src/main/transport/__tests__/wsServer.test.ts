// Integration tests for the authenticated WS server.
//
// We boot a real fastify HTTP server on a random `127.0.0.1` port,
// attach the WS transport, then drive it with `ws`'s client. Anything
// less wouldn't actually exercise the upgrade handshake (which is
// where the auth check lives).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import { loadOrCreateSigningKey, type SigningKey } from '../../pair/keypair';
import { issueToken } from '../../pair/token';
import { encode } from '@openclaw/protocol';
import { createRouter } from '../router';
import { attachWsServer, type WsTransport } from '../wsServer';

interface Harness {
  fastify: ReturnType<typeof Fastify>;
  ws: WsTransport;
  port: number;
  signingKey: SigningKey;
  validToken: string;
  tmp: string;
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'openclaw-ws-'));
  const signingKey = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.ws-test');
  const fastify = Fastify({ logger: false });
  // Need an actual route so fastify keeps the http server alive.
  fastify.get('/healthz', async () => ({ ok: true }));
  await fastify.listen({ host: '127.0.0.1', port: 0 });
  const address = fastify.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected AddressInfo');
  }
  const router = createRouter();
  const ws = attachWsServer({
    fastify,
    publicKey: signingKey.publicKey,
    router,
    // Short heartbeat so the test doesn't have to wait 90 s for the
    // timeout path; we don't actually exercise pong starvation here.
    pingIntervalMs: 5_000,
    pongTimeoutMs: 90_000,
  });
  // Echo every inbound frame as `system.echo` so we can assert
  // round-trip dispatch.
  router.subscribe('system.echo', (frame, ctx) => {
    ctx.reply('system.echo.reply', frame.payload, { id: frame.id });
  });
  const validToken = issueToken(signingKey.privateKey, {
    device_id: 'd-1',
    device_name: 'Test Phone',
    gateway_id: 'gw-1',
  });
  return { fastify, ws, port: address.port, signingKey, validToken, tmp };
}

describe('WS server upgrade', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    await h.ws.close();
    await h.fastify.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('connects with a valid Bearer token', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, {
      headers: { Authorization: `Bearer ${h.validToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(h.ws._deviceIds()).toContain('d-1');
    socket.close();
  });

  it('accepts a valid token via the ?token=… query param', async () => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${h.port}/ws?token=${encodeURIComponent(h.validToken)}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('rejects 401 when no token is provided', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
    const err = await new Promise<Error>((resolve) => {
      socket.once('error', (e) => resolve(e));
    });
    expect(err.message).toMatch(/401|unauthorized/i);
    expect(h.ws._deviceIds()).toHaveLength(0);
  });

  it('rejects 401 when the bearer token is bogus', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    const err = await new Promise<Error>((resolve) => {
      socket.once('error', (e) => resolve(e));
    });
    expect(err.message).toMatch(/401|unauthorized/i);
    expect(h.ws._deviceIds()).toHaveLength(0);
  });

  it('round-trips a frame through the router', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws`, {
      headers: { Authorization: `Bearer ${h.validToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const reply = new Promise<string>((resolve) => {
      socket.once('message', (data) => resolve(data.toString('utf8')));
    });

    socket.send(
      encode<unknown>({
        id: 'echo-1',
        topic: 'system.echo',
        type: 'system.echo',
        payload: { msg: 'hello' },
        ts: Date.now(),
      }),
    );

    const raw = await reply;
    const parsed = JSON.parse(raw) as { id: string; type: string; payload: { msg: string } };
    expect(parsed.id).toBe('echo-1');
    expect(parsed.type).toBe('system.echo.reply');
    expect(parsed.payload.msg).toBe('hello');
    socket.close();
  });
});
