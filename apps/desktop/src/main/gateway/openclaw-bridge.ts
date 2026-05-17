// Real-gateway bridge — translates our `Router`-shaped API into the
// upstream OpenClaw daemon's JSON-RPC `req`/`res`/`event` framing over
// WebSocket. Chat-only happy path per `.chalk/openclaw-upstream.md` and
// `.chalk/openclaw-deltas.md`.
//
// What this module owns:
//
//   - The lifecycle of a single WebSocket connection to a real
//     `openclaw gateway` daemon (default `ws://127.0.0.1:18789/`), with
//     a small reconnect loop on socket close.
//   - The pairing / connect handshake (delegated to
//     `openclaw-bridge-handshake.ts`).
//   - A tiny in-process `JsonRpcClient` that correlates `req` ids with
//     `res` frames and exposes an event stream for server-initiated
//     `event` frames.
//   - The translation table from our `Router` topics → upstream
//     `method`s/events, scoped to the chat-only surface:
//        * `agents.list`   ↔ upstream `agents.list`
//        * `threads.post`  ↔ upstream `chat.send` + a streamed reply
//          via `sessions.messages.subscribe` and the `chat.delta` /
//          `chat.final` / `chat.aborted` / `chat.error` events.
//   - A clear `unsupportedInRealMode` error envelope for canvas / voice
//     / `agents.setActive`, so apps that hit those surfaces in
//     real-gateway mode fail loud rather than silently dropping frames.
//
// What this module does NOT own (out of scope for P10A per the plan):
//
//   - Canvas / voice / push translation. Those need their own follow-up
//     plans once the translator pattern is proven.
//   - Spawning / supervising the daemon process. The bridge assumes
//     someone else (a human, launchd, systemd) keeps the daemon
//     running on the configured host:port. The reconnect loop will keep
//     trying until it succeeds.
//   - 6-digit pairing UX. The bridge consumes a `bootstrapToken` that
//     gets handed to it out of band (typed into Settings / pulled from
//     a QR scan); minting bootstrap tokens is the desktop daemon's job.

import { WebSocket } from 'ws';
import type { CanvasSurface, Message, ThreadEvent } from '@openclaw/protocol';
import { randomUUID } from 'node:crypto';
import type { Keystore } from '../pair/keystore';
import type { Router } from '../transport/router';
import {
  loadOrCreateBridgeIdentity,
  performConnect,
  persistBridgeDeviceToken,
  type BridgeIdentity,
  type HandshakeTransport,
  type UpstreamFrame,
  type UpstreamHelloOk,
} from './openclaw-bridge-handshake';

/** Error envelope returned to mobile when a feature isn't implemented in real mode. */
export interface UnsupportedInRealModeError {
  ok: false;
  reason: 'unsupportedInRealMode';
  feature: string;
  detail: string;
}

const UNSUPPORTED_FEATURES = {
  canvas: 'Canvas surfaces are not supported by the real-gateway bridge yet (P10A scope).',
  voice: 'Voice sessions are not supported by the real-gateway bridge yet (P10A scope).',
  agentsSetActive:
    'setActiveAgent is not supported upstream; pick an agent per thread instead (P10A scope).',
} as const;

function unsupported(feature: keyof typeof UNSUPPORTED_FEATURES): UnsupportedInRealModeError {
  return {
    ok: false,
    reason: 'unsupportedInRealMode',
    feature,
    detail: UNSUPPORTED_FEATURES[feature],
  };
}

/** Public surface of an attached bridge — mirrors `StubGateway` for index.ts symmetry. */
export interface OpenClawBridge {
  /** Tear down every router subscription + close the upstream WS. */
  detach(): Promise<void>;
  /** Last `HelloOk` we received. `null` until the first successful connect. */
  readonly hello: UpstreamHelloOk | null;
  /** Current connection state, for diagnostics + Settings UI. */
  readonly state: BridgeState;
}

export type BridgeState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Tunable knobs — exposed so tests can inject fakes and shrink delays. */
export interface OpenClawBridgeOptions {
  /** Router our subscriptions attach to. */
  router: Router;
  /** Keystore used for the per-bridge Ed25519 keypair + persisted deviceToken. */
  keystore: Keystore;
  /** ws:// or wss:// URL of the upstream daemon. Default `ws://127.0.0.1:18789/`. */
  upstreamUrl?: string;
  /** Optional pairing token if we haven't been issued a deviceToken yet. */
  bootstrapToken?: string;
  /**
   * Factory for the underlying WebSocket. Tests inject a fake; production
   * uses the `ws` library directly.
   */
  socketFactory?: (url: string) => UpstreamSocket;
  /** Backoff floor for the reconnect loop, in ms. Default 500. */
  reconnectMinMs?: number;
  /** Backoff ceiling for the reconnect loop, in ms. Default 30_000. */
  reconnectMaxMs?: number;
  /**
   * When true the bridge does not attempt reconnects after a disconnect
   * (useful for tests). Default false.
   */
  noReconnect?: boolean;
  /**
   * Pre-loaded `BridgeIdentity` (skip the keystore load). Tests use this
   * to seed deterministic keys without touching disk.
   */
  identity?: BridgeIdentity;
}

/** Minimal subset of the `ws` WebSocket surface we actually use. */
export interface UpstreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
}

/**
 * In-process JSON-RPC client for the upstream framing. Correlates `req`
 * ids with `res` frames, surfaces `event` frames through `onEvent`, and
 * exposes a `next()` for the handshake's `recv()` need (so the handshake
 * can read frames before the dispatcher loop owns them).
 */
export interface JsonRpcClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  onEvent(handler: (event: string, payload: unknown) => void): () => void;
  send(frame: UpstreamFrame): void;
  /** Resolve with the next inbound frame; used during the handshake only. */
  next(): Promise<UpstreamFrame | null>;
  /** Start the dispatcher loop. Until called, frames queue into `next()`. */
  start(): void;
  close(): void;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Build the JSON-RPC client around a single (already-opened) upstream
 * socket. Errors that propagate up here close the socket and reject
 * every outstanding request.
 */
export function createJsonRpcClient(socket: UpstreamSocket): JsonRpcClient {
  const pending = new Map<string, PendingRequest>();
  const eventHandlers = new Set<(event: string, payload: unknown) => void>();
  const recvQueue: UpstreamFrame[] = [];
  const recvWaiters: Array<(frame: UpstreamFrame | null) => void> = [];
  let started = false;
  let closed = false;

  function deliverNext(frame: UpstreamFrame | null): void {
    const waiter = recvWaiters.shift();
    if (waiter) {
      waiter(frame);
    } else if (frame) {
      recvQueue.push(frame);
    }
  }

  function dispatch(frame: UpstreamFrame): void {
    if (frame.type === 'res') {
      const p = pending.get(frame.id);
      if (!p) return; // late / unknown id — drop quietly.
      pending.delete(frame.id);
      if (p.timer) clearTimeout(p.timer);
      if (frame.ok) {
        p.resolve(frame.payload);
      } else {
        const code = frame.error?.code ?? 'upstream.error';
        const msg = frame.error?.message ?? 'upstream returned ok:false';
        const err = new Error(msg);
        (err as Error & { code: string }).code = code;
        p.reject(err);
      }
      return;
    }
    if (frame.type === 'event') {
      for (const h of [...eventHandlers]) {
        try {
          h(frame.event, frame.payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[openclaw] bridge event handler error:', err);
        }
      }
      return;
    }
    // req from server — not used in the chat-only happy path.
  }

  socket.on('message', (data) => {
    let parsed: UpstreamFrame;
    try {
      parsed = JSON.parse(data.toString()) as UpstreamFrame;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[openclaw] bridge: malformed JSON from upstream');
      return;
    }
    if (!started) {
      deliverNext(parsed);
      return;
    }
    dispatch(parsed);
  });

  socket.on('close', () => {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('upstream socket closed'));
    }
    pending.clear();
    while (recvWaiters.length > 0) {
      const w = recvWaiters.shift();
      w?.(null);
    }
  });

  socket.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn('[openclaw] bridge upstream socket error:', err.message);
  });

  return {
    request(method, params, timeoutMs = 30_000) {
      if (closed) {
        return Promise.reject(new Error('upstream socket closed'));
      }
      const id = randomUUID();
      return new Promise<unknown>((resolve, reject) => {
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                pending.delete(id);
                reject(new Error(`upstream request ${method} timed out after ${timeoutMs}ms`));
              }, timeoutMs)
            : null;
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'req', id, method, params }));
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    send(frame) {
      socket.send(JSON.stringify(frame));
    },
    next() {
      const queued = recvQueue.shift();
      if (queued) return Promise.resolve(queued);
      if (closed) return Promise.resolve(null);
      return new Promise<UpstreamFrame | null>((resolve) => {
        recvWaiters.push(resolve);
      });
    },
    start() {
      started = true;
      // Drain anything queued during handshake into the dispatcher.
      while (recvQueue.length > 0) {
        const f = recvQueue.shift();
        if (f) dispatch(f);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
    },
  };
}

/** Default factory that wraps `ws.WebSocket` into our minimal `UpstreamSocket` shape. */
export function defaultSocketFactory(url: string): UpstreamSocket {
  const ws = new WebSocket(url);
  // The `ws` library already matches the shape we want. The `data`
  // listener argument is typed loosely (it can be Buffer, ArrayBuffer,
  // …); we normalise to a stringifiable in `createJsonRpcClient`.
  return ws as unknown as UpstreamSocket;
}

/**
 * Attach the real-gateway bridge to the given router. Returns a handle
 * whose `detach()` tears down the WS connection + every subscription.
 *
 * This is the entry point `apps/desktop/src/main/index.ts` calls when
 * `settings.gateway_mode === "real"`.
 */
export async function attachOpenClawBridge(opts: OpenClawBridgeOptions): Promise<OpenClawBridge> {
  const upstreamUrl = opts.upstreamUrl ?? 'ws://127.0.0.1:18789/';
  const socketFactory = opts.socketFactory ?? defaultSocketFactory;
  const reconnectMinMs = opts.reconnectMinMs ?? 500;
  const reconnectMaxMs = opts.reconnectMaxMs ?? 30_000;
  const noReconnect = opts.noReconnect ?? false;

  const identity = opts.identity ?? (await loadOrCreateBridgeIdentity(opts.keystore));

  const state = {
    value: 'idle' as BridgeState,
    hello: null as UpstreamHelloOk | null,
    client: null as JsonRpcClient | null,
    deviceToken: identity.deviceToken,
    detached: false,
    reconnectAttempt: 0,
  };

  // Map of upstream `sessionKey` (== our `threadId`) → unsubscribe fn for
  // the per-thread `sessions.messages.subscribe`. Lets us idempotently
  // subscribe and tear down on detach. Currently we never tear down a
  // per-thread subscription mid-life: once mobile asks to post to a
  // thread we keep streaming events from that session until the bridge
  // itself closes. That mirrors the stub's "thread.event keeps firing
  // forever" contract.
  const subscribedSessions = new Set<string>();

  // Subscribe handles owned by attach() itself (for router cleanup).
  const routerUnsubs: Array<() => void> = [];

  // ---- Router subscriptions (translator) ---------------------------------
  // These attach immediately so even if the upstream socket isn't open
  // yet, the apps still see structured "not ready" / "unsupported"
  // replies instead of dropped frames. The chat path waits for the
  // socket and replays; the unsupported surfaces short-circuit synchronously.

  routerUnsubs.push(
    opts.router.subscribe('agents.list', async (frame, ctx) => {
      if (!state.client) {
        ctx.reply(
          'agents.list.response',
          { ok: false, reason: 'gateway-not-ready', agents: [] },
          { id: frame.id },
        );
        return;
      }
      try {
        const result = await state.client.request('agents.list', {});
        const agents = normaliseAgentsListResult(result);
        ctx.reply('agents.list.response', { agents }, { id: frame.id });
      } catch (err) {
        ctx.reply(
          'agents.list.response',
          {
            ok: false,
            reason: 'upstream-error',
            error: errorToWire(err),
            agents: [],
          },
          { id: frame.id },
        );
      }
    }),
  );

  routerUnsubs.push(
    opts.router.subscribe('agents.setActive', (frame, ctx) => {
      ctx.reply('agents.setActive.response', unsupported('agentsSetActive'), { id: frame.id });
    }),
  );

  routerUnsubs.push(
    opts.router.subscribe('threads.post', async (frame, ctx) => {
      const payload = (frame.payload ?? {}) as {
        threadId?: unknown;
        content?: unknown;
        agentId?: unknown;
      };
      const threadId = asString(payload.threadId) ?? `thread_${randomUUID()}`;
      const content = asString(payload.content) ?? '';
      // 1. Ack the user message immediately — same shape the stub returns.
      const userMessage: Message = {
        id: `msg_${randomUUID()}`,
        threadId,
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      ctx.reply('threads.event', { type: 'message', message: userMessage } satisfies ThreadEvent, {
        id: frame.id,
      });

      if (!state.client) {
        ctx.reply('threads.event', {
          type: 'done',
          messageId: userMessage.id,
        } satisfies ThreadEvent);
        ctx.reply(
          'threads.event.error',
          { ok: false, reason: 'gateway-not-ready' },
          { topic: 'threads.event' },
        );
        return;
      }

      // 2. Ensure the per-session stream subscription is in place. The
      //    subscription only needs to land once per (bridge, sessionKey).
      if (!subscribedSessions.has(threadId)) {
        subscribedSessions.add(threadId);
        try {
          await state.client.request('sessions.messages.subscribe', {
            sessionKey: threadId,
          });
        } catch (err) {
          subscribedSessions.delete(threadId);
          // eslint-disable-next-line no-console
          console.warn(
            '[openclaw] sessions.messages.subscribe failed for',
            threadId,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // 3. Fire chat.send. Idempotency key is required by upstream; we
      //    mint one per post so retries from mobile collapse server-side.
      try {
        await state.client.request('chat.send', {
          sessionKey: threadId,
          message: content,
          idempotencyKey: randomUUID(),
        });
      } catch (err) {
        ctx.reply('threads.event', {
          type: 'done',
          messageId: userMessage.id,
        } satisfies ThreadEvent);
        ctx.reply(
          'threads.event.error',
          { ok: false, reason: 'upstream-error', error: errorToWire(err) },
          { topic: 'threads.event' },
        );
      }
      // Streamed reply lands via the chat.delta / chat.final event
      // handler installed in onUpstreamEvent() below — it correlates by
      // sessionKey and emits our ThreadEvent shapes on `threads.event`.
    }),
  );

  // Canvas + voice — short-circuit every topic with the unsupported error.
  // We cover the same topic prefixes the stub did so apps that route by
  // prefix still get the typed error. Mobile + desktop chat UI today
  // ignore `canvas.*` / `voice.*` frames they don't subscribe to, so the
  // error materialises as a single envelope drop on the originating
  // device (visible in dev tools / logs but invisible in production UI).
  routerUnsubs.push(
    opts.router.subscribe('canvas', (frame, ctx) => {
      ctx.reply('canvas.error', unsupported('canvas'), { id: frame.id });
    }),
  );
  routerUnsubs.push(
    opts.router.subscribe('voice', (frame, ctx) => {
      ctx.reply('voice.error', unsupported('voice'), { id: frame.id });
    }),
  );

  // ---- Connection lifecycle ---------------------------------------------

  function onUpstreamEvent(event: string, payload: unknown): void {
    // chat.delta / chat.final / chat.aborted / chat.error → our
    // `threads.event` discriminated union, addressed by sessionKey.
    if (
      event === 'chat.delta' ||
      event === 'chat.final' ||
      event === 'chat.aborted' ||
      event === 'chat.error'
    ) {
      translateChatEvent(event, payload, opts.router);
      return;
    }
    if (event === 'shutdown') {
      // eslint-disable-next-line no-console
      console.warn('[openclaw] upstream gateway sent shutdown event:', payload);
      // The socket close that follows will trigger the reconnect loop.
    }
    // tick / others — drop. We don't need to do anything in the bridge.
  }

  function scheduleReconnect(): void {
    if (state.detached || noReconnect) {
      state.value = 'closed';
      return;
    }
    state.value = 'reconnecting';
    state.reconnectAttempt += 1;
    const delay = Math.min(
      reconnectMaxMs,
      reconnectMinMs * 2 ** Math.min(state.reconnectAttempt - 1, 6),
    );
    setTimeout(() => {
      void connectOnce();
    }, delay).unref?.();
  }

  async function connectOnce(): Promise<void> {
    if (state.detached) return;
    state.value = 'connecting';
    let socket: UpstreamSocket;
    try {
      socket = socketFactory(upstreamUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[openclaw] bridge: socketFactory threw:', err);
      scheduleReconnect();
      return;
    }

    // Wait for the socket to open before reading the challenge.
    const opened = await waitForOpen(socket);
    if (!opened) {
      scheduleReconnect();
      return;
    }

    const client = createJsonRpcClient(socket);
    const transport: HandshakeTransport = {
      send: (frame) => client.send(frame),
      recv: () => client.next(),
    };
    try {
      const result = await performConnect({
        transport,
        identity: { ...identity, deviceToken: state.deviceToken },
        ...(opts.bootstrapToken ? { bootstrapToken: opts.bootstrapToken } : {}),
      });
      state.hello = result.hello;
      // Persist any newly-issued deviceToken so we can skip the
      // bootstrapToken path on reconnects.
      if (result.deviceToken && result.deviceToken !== state.deviceToken) {
        state.deviceToken = result.deviceToken;
        try {
          await persistBridgeDeviceToken(opts.keystore, result.deviceToken);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            '[openclaw] bridge: failed to persist deviceToken:',
            err instanceof Error ? err.message : err,
          );
        }
      }
      state.client = client;
      state.reconnectAttempt = 0;
      state.value = 'open';
      client.onEvent(onUpstreamEvent);
      client.start();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[openclaw] bridge handshake failed:', err instanceof Error ? err.message : err);
      client.close();
      scheduleReconnect();
      return;
    }

    socket.on('close', () => {
      state.client = null;
      state.hello = null;
      // Force re-subscribe on the next connect.
      subscribedSessions.clear();
      scheduleReconnect();
    });
  }

  // Kick off the first connection. We don't `await` here so the bridge
  // attach() resolves quickly and the apps don't block startup on the
  // daemon being up — the router subscriptions are already live.
  void connectOnce();

  return {
    get hello() {
      return state.hello;
    },
    get state() {
      return state.value;
    },
    async detach(): Promise<void> {
      state.detached = true;
      state.value = 'closed';
      for (const off of routerUnsubs) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      routerUnsubs.length = 0;
      state.client?.close();
      state.client = null;
    },
  };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function errorToWire(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code ?? 'upstream.error';
    return { code, message: err.message };
  }
  return { code: 'upstream.error', message: String(err) };
}

/** Coerce upstream `AgentsListResult` shapes to our flat `Agent[]`. */
function normaliseAgentsListResult(result: unknown): Array<{
  id: string;
  name: string;
  description?: string;
}> {
  if (typeof result !== 'object' || result === null) return [];
  const rec = result as Record<string, unknown>;
  const list = Array.isArray(rec.agents) ? rec.agents : [];
  const out: Array<{ id: string; name: string; description?: string }> = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = asString(r['id']);
    if (!id) continue;
    const name = asString(r['name']) ?? asString(r['displayName']) ?? asString(r['id']) ?? id;
    const desc = asString(r['description']);
    out.push(desc ? { id, name, description: desc } : { id, name });
  }
  return out;
}

/**
 * Translate one upstream chat event into our `ThreadEvent` shape and
 * publish it on `threads.event` for the originating device. Upstream
 * carries `sessionKey` on every event; we use it as our `threadId`.
 *
 * `chat.delta` → `{ type:"token", messageId:runId, delta:deltaText }`
 * `chat.final` → optional `{ type:"message", message }` then
 *                 `{ type:"done", messageId:runId }`
 * `chat.aborted` / `chat.error` → `{ type:"done", messageId:runId }`
 */
function translateChatEvent(event: string, payload: unknown, router: Router): void {
  if (typeof payload !== 'object' || payload === null) return;
  const rec = payload as Record<string, unknown>;
  const sessionKey = asString(rec['sessionKey']);
  const runId = asString(rec['runId']);
  if (!sessionKey || !runId) return;
  const messageId = runId;
  if (event === 'chat.delta') {
    const delta = asString(rec['deltaText']) ?? '';
    if (!delta) return;
    router.publish('threads.event', 'threads.event', {
      type: 'token',
      messageId,
      delta,
    } satisfies ThreadEvent);
    return;
  }
  if (event === 'chat.final') {
    const upstreamMessage = rec['message'];
    if (upstreamMessage && typeof upstreamMessage === 'object') {
      const msg = normaliseAssistantMessage(upstreamMessage, sessionKey, runId);
      if (msg) {
        router.publish('threads.event', 'threads.event', {
          type: 'message',
          message: msg,
        } satisfies ThreadEvent);
      }
    }
    router.publish('threads.event', 'threads.event', {
      type: 'done',
      messageId,
    } satisfies ThreadEvent);
    return;
  }
  if (event === 'chat.aborted' || event === 'chat.error') {
    router.publish('threads.event', 'threads.event', {
      type: 'done',
      messageId,
    } satisfies ThreadEvent);
  }
}

function normaliseAssistantMessage(raw: unknown, threadId: string, runId: string): Message | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const content = asString(r['content']) ?? asString(r['text']) ?? asString(r['body']);
  if (content === null) return null;
  return {
    id: asString(r['id']) ?? `msg_${runId}`,
    threadId,
    role: 'assistant',
    content,
    createdAt: typeof r['createdAt'] === 'number' ? (r['createdAt'] as number) : Date.now(),
  };
}

/** Resolve once the socket fires `open`, or `false` on error/close first. */
function waitForOpen(socket: UpstreamSocket): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    socket.on('open', () => {
      if (settled) return;
      settled = true;
      resolve(true);
    });
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
  });
}

// `CanvasSurface` is imported only for the type discriminator in the
// unsupported envelopes (so future callers grep cleanly). Keep the
// reference alive for typecheck without leaking into runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _canvasTypeProbe: CanvasSurface | undefined = undefined;
