// Integration tests for the CopilotKit runtime fastify route.
//
// Wires up a real router + the stub gateway + the runtime route on a
// fresh fastify, then uses `fastify.inject` to round-trip CopilotKit
// requests. We assert:
//   - Missing / bad token → 401.
//   - Bad body shape → 400.
//   - A real run end-to-end through the stub returns the expected
//     AG-UI event sequence over SSE.
//   - The healthz subpath exposes the pinned package version.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateSigningKey, type SigningKey } from '../../pair/keypair';
import { issueToken } from '../../pair/token';
import { createRouter, type InboundFrame, type Router } from '../../transport/router';
import { attachStubGateway, type StubGateway } from '../../gateway/__fixtures__/stub';
import { registerCopilotRuntime } from '../runtime';
import { encode } from '@openclaw/protocol';

interface Harness {
  fastify: FastifyInstance;
  router: Router;
  stub: StubGateway;
  signingKey: SigningKey;
  tmp: string;
  goodToken: string;
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'openclaw-cop-'));
  const signingKey = await loadOrCreateSigningKey(tmp, 'dev.openclaw.desktop.copilot-test');
  const fastify = Fastify({ logger: false });
  const router = createRouter();
  // Wire the router's broadcaster: we don't have a WS server here, but
  // the adapter doesn't need one — it subscribes directly. The
  // broadcaster is what the stub gateway's `ctx.reply` ultimately calls,
  // and *that* needs to fan back to the router subscribers too. The
  // router only feeds the broadcaster; subscribers fire via
  // `dispatchRaw`. So for the adapter we synthesise an in-process
  // "loopback" broadcaster that re-injects published frames as inbound
  // frames so the stub gateway's `reply()` reaches the adapter's
  // subscription.
  router.setBroadcaster((frame: InboundFrame, target) => {
    // Re-dispatch each broadcast frame back through the router so
    // subscribers on the same topic (the adapter) receive it. We
    // tag the deviceId on the inbound context.
    if (!target?.deviceId) return;
    router.dispatchRaw(encode(frame), { deviceId: target.deviceId });
  });
  const stub = attachStubGateway(router, { replyDelayMs: 0 });
  registerCopilotRuntime({
    fastify,
    publicKey: signingKey.publicKey,
    router,
    runTimeoutMs: 2_000,
    sseOptions: { heartbeatMs: 0 },
  });
  await fastify.ready();

  const goodToken = issueToken(signingKey.privateKey, {
    device_id: 'dev-1',
    device_name: 'Tester',
    gateway_id: 'gw-test',
    ttlMs: 60_000,
  });

  return { fastify, router, stub, signingKey, tmp, goodToken };
}

describe('POST /copilot/runtime/agent/:agentId/run', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });
  afterEach(async () => {
    h.stub.detach();
    await h.fastify.close();
    rmSync(h.tmp, { recursive: true, force: true });
  });

  it('returns 401 when no Authorization header is present', async () => {
    const res = await h.fastify.inject({
      method: 'POST',
      url: '/copilot/runtime/agent/openclaw.default/run',
      payload: {
        threadId: 't1',
        runId: 'r1',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/token/i) });
  });

  it('returns 401 for a malformed bearer token', async () => {
    const res = await h.fastify.inject({
      method: 'POST',
      url: '/copilot/runtime/agent/openclaw.default/run',
      headers: { Authorization: 'Bearer not.a.real.token' },
      payload: {
        threadId: 't1',
        runId: 'r1',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when the body fails RunAgentInput validation', async () => {
    const res = await h.fastify.inject({
      method: 'POST',
      url: '/copilot/runtime/agent/openclaw.default/run',
      headers: { Authorization: `Bearer ${h.goodToken}` },
      payload: { not: 'a run request' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('streams an AG-UI event sequence end-to-end through the stub gateway', async () => {
    const res = await h.fastify.inject({
      method: 'POST',
      url: '/copilot/runtime/agent/openclaw.default/run',
      headers: { Authorization: `Bearer ${h.goodToken}` },
      payload: {
        threadId: 't-int',
        runId: 'r-int',
        messages: [{ id: 'u1', role: 'user', content: 'hello' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);

    // Parse the SSE body back into individual events.
    const frames = res.body
      .split('\n\n')
      .map((f) => f.trim())
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.replace(/^data: /, '')) as { type: string });
    const types = frames.map((f) => f.type);

    expect(types[0]).toBe('RUN_STARTED');
    expect(types[types.length - 1]).toBe('RUN_FINISHED');
    expect(types).toContain('TEXT_MESSAGE_START');
    expect(types).toContain('TEXT_MESSAGE_CONTENT');
    expect(types).toContain('TEXT_MESSAGE_END');
    expect(types).toContain('TOOL_CALL_START');
    expect(types).toContain('TOOL_CALL_ARGS');
    expect(types).toContain('TOOL_CALL_END');
  });

  it('also accepts the token via ?token= query for clients that cannot set headers', async () => {
    const res = await h.fastify.inject({
      method: 'POST',
      url: `/copilot/runtime/agent/openclaw.default/run?token=${encodeURIComponent(h.goodToken)}`,
      payload: {
        threadId: 't-q',
        runId: 'r-q',
        messages: [{ id: 'u1', role: 'user', content: 'q' }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('healthz reports the pinned runtime version', async () => {
    const res = await h.fastify.inject({
      method: 'GET',
      url: '/copilot/runtime/healthz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, runtime: 'copilotkit', version: '1.57.1' });
  });
});
