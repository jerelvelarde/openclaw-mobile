// Bridge translator unit tests.
//
// Asserts that the `OpenClawBridge` correctly maps our router-shaped
// topics into upstream JSON-RPC methods + events for the chat-only
// happy path:
//
//   - `agents.list` → upstream `agents.list` method → `agents.list.response`.
//   - `threads.post` → upstream `sessions.messages.subscribe` + `chat.send`,
//     then an inbound `event: "chat.delta"` lands as our
//     `threads.event { type:"token" }`, and `event: "chat.final"` lands
//     as `threads.event { type:"message" }` + `{ type:"done" }`.
//   - `canvas.*` / `voice.*` / `agents.setActive` short-circuit with an
//     `unsupportedInRealMode` payload.
//
// We inject a fake `socketFactory` so the test owns both ends of the
// "wire" without spawning a real WS server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '@openclaw/protocol';
import { openKeystore, type Keystore } from '../../pair/keystore';
import { createRouter, type InboundFrame, type Router } from '../../transport/router';
import { attachOpenClawBridge, type OpenClawBridge, type UpstreamSocket } from '../openclaw-bridge';
import {
  BRIDGE_PROTOCOL_VERSION,
  loadOrCreateBridgeIdentity,
  type BridgeIdentity,
  type UpstreamFrame,
} from '../openclaw-bridge-handshake';

interface FakeSocket extends UpstreamSocket {
  /** Frames the bridge sent us (text-serialised at send time). */
  sentRaw: string[];
  /** Convenience: parsed frames. */
  sent(): UpstreamFrame[];
  /** Fire an inbound frame at the bridge. */
  push(frame: UpstreamFrame): void;
  /** Trigger the `open` event listener that the bridge installed. */
  emitOpen(): void;
  /** Trigger the `close` event listener. */
  emitClose(code?: number): void;
}

function fakeSocket(): FakeSocket {
  type AnyListener = (...args: unknown[]) => void;
  const listeners: Record<string, AnyListener[]> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };
  const sentRaw: string[] = [];

  const socket: FakeSocket = {
    sentRaw,
    sent(): UpstreamFrame[] {
      return sentRaw.map((r) => JSON.parse(r) as UpstreamFrame);
    },
    push(frame: UpstreamFrame) {
      const text = JSON.stringify(frame);
      const ls = listeners['message'] ?? [];
      for (const l of [...ls]) l(text);
    },
    emitOpen() {
      const ls = listeners['open'] ?? [];
      for (const l of [...ls]) l();
    },
    emitClose(code = 1000) {
      const ls = listeners['close'] ?? [];
      for (const l of [...ls]) l(code, Buffer.alloc(0));
    },
    send(data: string) {
      sentRaw.push(data);
    },
    close() {
      socket.emitClose();
    },
    on(event: string, listener: (frame: unknown) => void) {
      (listeners[event] ?? []).push(listener as AnyListener);
    },
  } as unknown as FakeSocket;
  return socket;
}

interface Harness {
  router: Router;
  bridge: OpenClawBridge;
  socket: FakeSocket;
  captured: InboundFrame[];
  identity: BridgeIdentity;
}

let tmp: string;
let keystore: Keystore;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'openclaw-bridge-'));
  keystore = await openKeystore(tmp, 'dev.openclaw.bridge.test');
  // Silence the P11A deprecation warning emitted by `attachOpenClawBridge`
  // so the test output stays clean. The bridge itself still functions; we
  // only suppress the noisy console.warn the deprecation hook emits.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Stand up a bridge attached to a router whose outbound broadcaster
 * just captures frames, with a fake socket already opened + the
 * handshake completed (HelloOk acknowledged).
 */
async function buildHarness(): Promise<Harness> {
  const router = createRouter();
  const captured: InboundFrame[] = [];
  router.setBroadcaster((f) => {
    captured.push(f);
  });

  const socket = fakeSocket();
  const identity: BridgeIdentity = {
    ...(await loadOrCreateBridgeIdentity(keystore)),
    deviceToken: 'tok-test', // skip the bootstrap flow.
  };

  const bridge = await attachOpenClawBridge({
    router,
    keystore,
    identity,
    socketFactory: () => socket,
    noReconnect: true,
  });

  // The bridge's connectOnce() runs async; let it install its socket
  // listeners before we drive the handshake.
  await flushMicrotasks();
  socket.emitOpen();
  await flushMicrotasks();
  // Server emits the challenge.
  socket.push({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-test' } });
  await flushMicrotasks();
  // The bridge should now have sent a connect req. Resolve it.
  const sent = socket.sent();
  const connectReq = sent.find((f) => f.type === 'req' && f.method === 'connect');
  if (!connectReq || connectReq.type !== 'req') {
    throw new Error(`expected connect req from bridge, got: ${JSON.stringify(sent)}`);
  }
  socket.push({
    type: 'res',
    id: connectReq.id,
    ok: true,
    payload: {
      type: 'hello-ok',
      protocol: BRIDGE_PROTOCOL_VERSION,
      server: { version: '1.0.0', connId: 'c-test' },
      features: { methods: ['agents.list', 'chat.send'], events: ['chat.delta'] },
      auth: { deviceToken: 'tok-fresh', role: 'node', scopes: ['operator.read'] },
    },
  });
  await flushMicrotasks();
  // After the handshake completes the bridge transitions to 'open'.
  expect(bridge.state).toBe('open');
  // Drain the captured frames produced during handshake (none expected,
  // but be defensive — the router only sees frames from `ctx.reply`
  // and `router.publish`, neither of which the handshake calls).
  captured.length = 0;
  // Clear what the bridge sent during handshake so per-test asserts
  // only see what's emitted next.
  socket.sentRaw.length = 0;
  return { router, bridge, socket, captured, identity };
}

function flushMicrotasks(): Promise<void> {
  return new Promise<void>((r) => setImmediate(r));
}

function feedRouter(router: Router, topic: string, type: string, payload: unknown): void {
  router.dispatchRaw(encode<unknown>({ id: `t_${topic}_${type}`, topic, type, payload, ts: 1 }), {
    deviceId: 'phone-1',
  });
}

describe('OpenClawBridge — agents.list', () => {
  it('round-trips agents.list through upstream agents.list', async () => {
    const { router, socket, captured, bridge } = await buildHarness();

    feedRouter(router, 'agents.list', 'agents.list', {});
    await flushMicrotasks();

    const sent = socket.sent();
    const req = sent.find((f) => f.type === 'req' && f.method === 'agents.list');
    expect(req).toBeDefined();
    if (!req || req.type !== 'req') throw new Error('unreachable');

    socket.push({
      type: 'res',
      id: req.id,
      ok: true,
      payload: {
        agents: [
          { id: 'openclaw.default', name: 'OpenClaw', description: 'Default skill' },
          { id: 'hermes', displayName: 'Hermes' },
        ],
      },
    });
    await flushMicrotasks();

    const reply = captured.find((f) => f.type === 'agents.list.response');
    expect(reply).toBeDefined();
    const p = reply!.payload as { agents: Array<{ id: string; name: string }> };
    expect(p.agents).toHaveLength(2);
    expect(p.agents.map((a) => a.id)).toEqual(['openclaw.default', 'hermes']);
    // displayName falls back to `name` when the canonical `name` is absent.
    expect(p.agents[1]!.name).toBe('Hermes');
    await bridge.detach();
  });

  it('returns gateway-not-ready when the upstream is not connected', async () => {
    const router = createRouter();
    const captured: InboundFrame[] = [];
    router.setBroadcaster((f) => captured.push(f));
    const socket = fakeSocket();
    const identity: BridgeIdentity = {
      ...(await loadOrCreateBridgeIdentity(keystore)),
      deviceToken: 'tok-test',
    };
    const bridge = await attachOpenClawBridge({
      router,
      keystore,
      identity,
      socketFactory: () => socket,
      noReconnect: true,
    });
    // Don't drive the handshake — bridge stays in 'connecting'/'idle'.
    await flushMicrotasks();
    feedRouter(router, 'agents.list', 'agents.list', {});
    await flushMicrotasks();
    const reply = captured.find((f) => f.type === 'agents.list.response');
    expect(reply).toBeDefined();
    expect(reply!.payload).toMatchObject({ ok: false, reason: 'gateway-not-ready' });
    await bridge.detach();
  });
});

describe('OpenClawBridge — threads.post', () => {
  it('subscribes once + fires chat.send, then streams chat.delta + chat.final', async () => {
    const { router, socket, captured, bridge } = await buildHarness();

    feedRouter(router, 'threads.post', 'threads.post', {
      threadId: 't-1',
      content: 'hello',
    });
    await flushMicrotasks();

    // The user-message ack lands synchronously on `threads.event`.
    const ack = captured.find(
      (f) => f.type === 'threads.event' && (f.payload as { type: string }).type === 'message',
    );
    expect(ack).toBeDefined();
    const ackMsg = (ack!.payload as { message: { role: string; content: string } }).message;
    expect(ackMsg.role).toBe('user');
    expect(ackMsg.content).toBe('hello');

    // The bridge subscribes to the per-session event stream first, then
    // fires chat.send only after the subscribe round-trip — we drive
    // them in order.
    const subscribe = socket
      .sent()
      .find((f) => f.type === 'req' && f.method === 'sessions.messages.subscribe');
    expect(subscribe).toBeDefined();
    if (!subscribe || subscribe.type !== 'req') throw new Error('unreachable');
    expect((subscribe.params as { sessionKey: string }).sessionKey).toBe('t-1');
    socket.push({ type: 'res', id: subscribe.id, ok: true, payload: { ok: true } });
    await flushMicrotasks();

    const send = socket.sent().find((f) => f.type === 'req' && f.method === 'chat.send');
    expect(send).toBeDefined();
    if (!send || send.type !== 'req') throw new Error('unreachable');
    expect((send.params as { sessionKey: string; message: string }).sessionKey).toBe('t-1');
    expect((send.params as { message: string }).message).toBe('hello');
    expect((send.params as { idempotencyKey?: string }).idempotencyKey).toBeDefined();
    socket.push({ type: 'res', id: send.id, ok: true, payload: { runId: 'run-xyz' } });
    await flushMicrotasks();

    // Now stream an inbound chat.delta — should land as `token`.
    socket.push({
      type: 'event',
      event: 'chat.delta',
      payload: {
        sessionKey: 't-1',
        runId: 'run-xyz',
        seq: 0,
        deltaText: 'Hello',
      },
    });
    await flushMicrotasks();
    const tokenEvt = captured.find(
      (f) => f.type === 'threads.event' && (f.payload as { type: string }).type === 'token',
    );
    expect(tokenEvt).toBeDefined();
    const tokenPayload = tokenEvt!.payload as { messageId: string; delta: string };
    expect(tokenPayload.messageId).toBe('run-xyz');
    expect(tokenPayload.delta).toBe('Hello');

    // chat.final → `message` + `done`.
    socket.push({
      type: 'event',
      event: 'chat.final',
      payload: {
        sessionKey: 't-1',
        runId: 'run-xyz',
        seq: 1,
        message: { id: 'm-final', content: 'Hello world', createdAt: 42 },
      },
    });
    await flushMicrotasks();

    const finalMsg = captured.find(
      (f) =>
        f.type === 'threads.event' &&
        (f.payload as { type: string; message?: { id?: string } }).type === 'message' &&
        (f.payload as { message: { id: string } }).message.id === 'm-final',
    );
    expect(finalMsg).toBeDefined();
    expect((finalMsg!.payload as { message: { content: string } }).message.content).toBe(
      'Hello world',
    );

    const done = captured.find(
      (f) => f.type === 'threads.event' && (f.payload as { type: string }).type === 'done',
    );
    expect(done).toBeDefined();
    expect((done!.payload as { messageId: string }).messageId).toBe('run-xyz');

    // A second post to the same thread should NOT re-subscribe.
    socket.sentRaw.length = 0;
    feedRouter(router, 'threads.post', 'threads.post', {
      threadId: 't-1',
      content: 'follow-up',
    });
    await flushMicrotasks();
    const sent2 = socket.sent();
    expect(
      sent2.find((f) => f.type === 'req' && f.method === 'sessions.messages.subscribe'),
    ).toBeUndefined();
    expect(sent2.find((f) => f.type === 'req' && f.method === 'chat.send')).toBeDefined();

    await bridge.detach();
  });

  it('chat.aborted lands as a `done` event with the runId messageId', async () => {
    const { router, socket, captured, bridge } = await buildHarness();
    feedRouter(router, 'threads.post', 'threads.post', { threadId: 't-2', content: 'x' });
    await flushMicrotasks();
    // Resolve the subscribe so the bridge moves on to chat.send.
    const sub = socket
      .sent()
      .find((f) => f.type === 'req' && f.method === 'sessions.messages.subscribe');
    if (sub && sub.type === 'req') {
      socket.push({ type: 'res', id: sub.id, ok: true, payload: {} });
    }
    await flushMicrotasks();
    const send = socket.sent().find((f) => f.type === 'req' && f.method === 'chat.send');
    if (send && send.type === 'req') {
      socket.push({ type: 'res', id: send.id, ok: true, payload: { runId: 'run-abort' } });
    }
    await flushMicrotasks();
    captured.length = 0;

    socket.push({
      type: 'event',
      event: 'chat.aborted',
      payload: { sessionKey: 't-2', runId: 'run-abort', seq: 0 },
    });
    await flushMicrotasks();
    const done = captured.find(
      (f) => f.type === 'threads.event' && (f.payload as { type: string }).type === 'done',
    );
    expect(done).toBeDefined();
    expect((done!.payload as { messageId: string }).messageId).toBe('run-abort');
    await bridge.detach();
  });
});

describe('OpenClawBridge — unsupportedInRealMode', () => {
  it('canvas.* returns the typed unsupported error', async () => {
    const { router, captured, bridge } = await buildHarness();
    feedRouter(router, 'canvas.surface.get', 'canvas.surface.get', { surfaceId: 's-1' });
    await flushMicrotasks();
    const err = captured.find((f) => f.type === 'canvas.error');
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({
      ok: false,
      reason: 'unsupportedInRealMode',
      feature: 'canvas',
    });
    await bridge.detach();
  });

  it('voice.* returns the typed unsupported error', async () => {
    const { router, captured, bridge } = await buildHarness();
    feedRouter(router, 'voice.s1.signal', 'voice.signal', { type: 'offer' });
    await flushMicrotasks();
    const err = captured.find((f) => f.type === 'voice.error');
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({
      ok: false,
      reason: 'unsupportedInRealMode',
      feature: 'voice',
    });
    await bridge.detach();
  });

  it('agents.setActive returns the typed unsupported error', async () => {
    const { router, captured, bridge } = await buildHarness();
    feedRouter(router, 'agents.setActive', 'agents.setActive', { agentId: 'hermes' });
    await flushMicrotasks();
    const err = captured.find((f) => f.type === 'agents.setActive.response');
    expect(err).toBeDefined();
    expect(err!.payload).toMatchObject({
      ok: false,
      reason: 'unsupportedInRealMode',
      feature: 'agentsSetActive',
    });
    await bridge.detach();
  });
});

describe('OpenClawBridge — lifecycle', () => {
  it('detach() removes router subscriptions + closes the upstream socket', async () => {
    const { router, bridge } = await buildHarness();
    expect(router._topics().length).toBeGreaterThan(0);
    await bridge.detach();
    expect(router._topics()).toHaveLength(0);
    expect(bridge.state).toBe('closed');
  });
});
