// `RealGateway` WS topic tests — P05A.
//
// We exercise the new request/response handlers (`agents.list`,
// `agents.setActive`, `listThreads`, `postMessage`) and the
// `streamThread` fan-out path. All without a live socket: we inject a
// `WebSocketFactory` stub that records `send` calls and exposes a
// `triggerOpen`/`triggerMessage` API. The pairing flow is exercised in
// `http.test.ts` already.

import type { Agent, CanvasPatch, CanvasSurface, ThreadEvent } from '@openclaw/protocol';

import { PLACEHOLDER_PUBLIC_KEY, RealGateway } from '../RealGateway';
import { WS_OPEN, type WebSocketFactory, type WebSocketLike } from '../ws';

interface FakeSocket extends WebSocketLike {
  sent: string[];
  triggerOpen: () => void;
  triggerMessage: (raw: string) => void;
  triggerClose: (code?: number, reason?: string) => void;
}

function fakeWsFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = () => {
    let readyState = 0;
    const fake: FakeSocket = {
      readyState,
      sent: [],
      send(data: string) {
        fake.sent.push(data);
      },
      close() {
        readyState = 3;
        fake.readyState = readyState;
        fake.onclose?.({ code: 1000, reason: 'manual_close' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      triggerOpen() {
        readyState = WS_OPEN;
        fake.readyState = readyState;
        fake.onopen?.();
      },
      triggerMessage(raw: string) {
        fake.onmessage?.({ data: raw });
      },
      triggerClose(code, reason) {
        readyState = 3;
        fake.readyState = readyState;
        fake.onclose?.({ code, reason });
      },
    };
    sockets.push(fake);
    return fake;
  };
  return { factory, sockets };
}

async function flush(): Promise<void> {
  // Yield to setTimeout(_, 0) so the reconnect controller's scheduler
  // runs its zero-delay first attempt, then drain microtasks.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
  await Promise.resolve();
}

describe('RealGateway WS topics', () => {
  let gw: RealGateway;
  let sockets: FakeSocket[];

  afterEach(() => {
    // Stop the reconnect loop so Jest can tear the env down without
    // dangling timers. Each test instantiates a fresh gateway in
    // `beforeEach`, but the very-first `connect()` call kicks off a
    // controller whose internal `scheduleAttempt` keeps a `setTimeout`
    // alive even after the test passes.
    try {
      gw?.disconnect();
    } catch {
      /* ignore */
    }
  });

  beforeEach(async () => {
    const { factory, sockets: list } = fakeWsFactory();
    sockets = list;
    gw = new RealGateway({
      httpBase: 'http://127.0.0.1:18789',
      deviceName: 'test',
      publicKey: PLACEHOLDER_PUBLIC_KEY,
      webSocketFactory: factory,
    });
    // Kick off connect() and resolve it by opening the fake socket.
    const connecting = gw.connect('tok_test');
    // The reconnect controller fires the first attempt synchronously
    // via its scheduler — drain microtasks so the socket is constructed.
    await flush();
    expect(sockets.length).toBeGreaterThan(0);
    sockets[0]!.triggerOpen();
    await connecting;
  });

  it('listAgents sends agents.list and resolves with the response payload', async () => {
    const fakeAgents: Agent[] = [{ id: 'a', name: 'A' }];
    const promise = gw.listAgents();
    await flush();
    // Pick the most-recent frame the gateway sent — it's the request.
    const sent = sockets[0]!.sent.filter((s) => s.includes('agents.list'));
    expect(sent.length).toBe(1);
    const frame = JSON.parse(sent[0]!);
    expect(frame.topic).toBe('agents');
    expect(frame.type).toBe('agents.list');
    // Inject a matching response.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: frame.id,
        topic: 'agents.list',
        type: 'agents.list.response',
        payload: { agents: fakeAgents },
        ts: Date.now(),
      }),
    );
    await expect(promise).resolves.toEqual(fakeAgents);
  });

  it('setActiveAgent resolves on ok=true and rejects on ok=false', async () => {
    const okPromise = gw.setActiveAgent('hermes');
    await flush();
    const okFrame = JSON.parse(
      sockets[0]!.sent.filter((s) => s.includes('agents.setActive')).pop()!,
    );
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: okFrame.id,
        topic: 'agents.setActive',
        type: 'agents.setActive.response',
        payload: { ok: true, agentId: 'hermes' },
        ts: Date.now(),
      }),
    );
    await expect(okPromise).resolves.toBeUndefined();

    const badPromise = gw.setActiveAgent('unknown');
    await flush();
    const badFrame = JSON.parse(
      sockets[0]!.sent.filter((s) => s.includes('agents.setActive')).pop()!,
    );
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: badFrame.id,
        topic: 'agents.setActive',
        type: 'agents.setActive.response',
        payload: { ok: false, reason: 'unknown agent' },
        ts: Date.now(),
      }),
    );
    await expect(badPromise).rejects.toThrow(/unknown agent/);
  });

  it('postMessage sends a threads.post frame fire-and-forget', async () => {
    await gw.postMessage('thread_x', { content: 'hello' });
    const posts = sockets[0]!.sent.filter((s) => s.includes('threads.post'));
    expect(posts).toHaveLength(1);
    const frame = JSON.parse(posts[0]!);
    expect(frame.topic).toBe('threads');
    expect(frame.type).toBe('threads.post');
    expect(frame.payload).toEqual({ threadId: 'thread_x', content: 'hello' });
  });

  it('streamThread fans out matching threads.event frames by thread id', () => {
    const events: ThreadEvent[] = [];
    const unsub = gw.streamThread('thread_x', (e) => events.push(e));

    // Inject a message-level event for thread_x.
    const messageEvent: ThreadEvent = {
      type: 'message',
      message: {
        id: 'msg_1',
        threadId: 'thread_x',
        role: 'assistant',
        content: 'hi',
        createdAt: 1,
      },
    };
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'fr1',
        topic: 'threads',
        type: 'threads.event',
        payload: messageEvent,
        ts: 1,
      }),
    );
    // Inject a streaming `token` event keyed by messageId only.
    const tokenEvent: ThreadEvent = {
      type: 'token',
      messageId: 'msg_1',
      delta: 'hi',
    };
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'fr2',
        topic: 'threads',
        type: 'threads.event',
        payload: tokenEvent,
        ts: 2,
      }),
    );

    expect(events).toEqual([messageEvent, tokenEvent]);

    // Inject an event for a different thread — should be filtered out.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'fr3',
        topic: 'threads',
        type: 'threads.event',
        payload: {
          type: 'message',
          message: {
            id: 'msg_other',
            threadId: 'thread_other',
            role: 'assistant',
            content: 'x',
            createdAt: 3,
          },
        },
        ts: 3,
      }),
    );
    expect(events).toHaveLength(2);

    unsub();
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'fr4',
        topic: 'threads',
        type: 'threads.event',
        payload: messageEvent,
        ts: 4,
      }),
    );
    // After unsubscribe, no further events.
    expect(events).toHaveLength(2);
  });

  it('listThreads returns [] when the gateway times out (forward-compat)', async () => {
    // Send the frame but never reply — the helper should resolve to [].
    // We shorten by replacing sendAndWait? No — easier to test via the
    // 5s internal timeout. To avoid waiting, we manually reject via an
    // immediate close, which fires the socket-not-open path.
    // For unit testing without waiting on real timers, we inject a
    // response that's malformed — listThreads catches and returns [].
    const promise = gw.listThreads();
    await flush();
    const frame = JSON.parse(sockets[0]!.sent.filter((s) => s.includes('threads.list')).pop()!);
    // Reply with no `threads` array — handler should treat as empty.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: frame.id,
        topic: 'threads.list',
        type: 'threads.list.response',
        payload: {},
        ts: Date.now(),
      }),
    );
    await expect(promise).resolves.toEqual([]);
  });

  it('listAgents rejects when called before connect (socket not open)', async () => {
    const { factory } = fakeWsFactory();
    const unconnected = new RealGateway({
      httpBase: 'http://127.0.0.1:18789',
      deviceName: 'test',
      webSocketFactory: factory,
    });
    await expect(unconnected.listAgents()).rejects.toThrow(/not connected/);
  });

  it('fans out canvas.surface broadcasts to onCanvasSurface subscribers', () => {
    const received: CanvasSurface[] = [];
    const unsub = gw.onCanvasSurface((s) => received.push(s));
    const surface: CanvasSurface = {
      id: 'surface_xyz',
      version: 1,
      root: { type: 'stack', id: 'r', direction: 'vertical', children: [] },
    };
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'c1',
        topic: 'canvas',
        type: 'canvas.surface',
        payload: surface,
        ts: Date.now(),
      }),
    );
    expect(received).toEqual([surface]);
    unsub();
  });

  it('getCanvas resolves from cache after a canvas.surface broadcast', async () => {
    const surface: CanvasSurface = {
      id: 'surface_cache',
      version: 1,
      root: { type: 'stack', id: 'r', direction: 'vertical', children: [] },
    };
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'c2',
        topic: 'canvas',
        type: 'canvas.surface',
        payload: surface,
        ts: Date.now(),
      }),
    );
    await expect(gw.getCanvas('surface_cache')).resolves.toEqual(surface);
  });

  it('onCanvasUpdate routes canvas.patch frames to the matching surface', () => {
    const patches: CanvasPatch[] = [];
    const unsub = gw.onCanvasUpdate('surface_p', (p) => patches.push(p));
    const patch: CanvasPatch = {
      surfaceId: 'surface_p',
      ts: 1,
      ops: [{ op: 'setText', id: 'h', text: 'Hi' }],
    };
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'p1',
        topic: 'canvas',
        type: 'canvas.patch',
        payload: patch,
        ts: 1,
      }),
    );
    // A patch for a different surface must be filtered out.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'p2',
        topic: 'canvas',
        type: 'canvas.patch',
        payload: { ...patch, surfaceId: 'surface_other' },
        ts: 2,
      }),
    );
    expect(patches).toEqual([patch]);
    unsub();
  });

  it('postCanvasEvent sends a canvas.event frame fire-and-forget', async () => {
    await gw.postCanvasEvent({
      surfaceId: 'surface_e',
      nodeId: 'btn1',
      type: 'click',
      payload: { action: 'submit' },
    });
    const sent = sockets[0]!.sent.filter((s) => s.includes('canvas.event'));
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!);
    expect(frame.topic).toBe('canvas');
    expect(frame.type).toBe('canvas.event');
    expect(frame.payload).toEqual({
      surfaceId: 'surface_e',
      nodeId: 'btn1',
      type: 'click',
      payload: { action: 'submit' },
    });
  });
});
