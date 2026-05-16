// `RealGateway` — the production `GatewayClient` implementation.
//
// Composes the three transports (`bonjour.ts`, `http.ts`, `ws.ts`) plus the
// reconnect controller (`reconnect.ts`) into one object that satisfies the
// shared `GatewayClient` interface from `@openclaw/protocol`. Once a
// pairing token exists the `PairingProvider` swaps the `InMemoryMockGateway`
// for an instance of this class; the screens are unchanged.
//
// What's covered here:
//
//   - Pairing: `requestPairing` + `awaitPaired` proxy to the HTTP module.
//   - Connection: `connect(token)` opens a WS and wires the reconnect loop.
//   - Heartbeat-aware event dispatch (`connected`, `disconnected`, `error`,
//     `token_expired`).
//
// What's deliberately deferred — see TODO markers:
//
//   - `listAgents` / `listThreads` / `postMessage` / `streamThread`: P04B
//     lands the matching WS topics on the desktop side, so the mobile
//     calls would never resolve today. We expose typed stubs that throw a
//     well-known error string the UI surfaces.
//   - Canvas + voice: their schemas land in P06/P07.
//
// The plan's Success criteria mention `listAgents()` returning the
// desktop's list "if the WS protocol isn't implemented yet on the desktop
// side, leave a TODO for P04B and mock the WS response in dev". We do the
// TODO route — the in-memory mock remains available behind a constructor
// flag for dev iteration.

import type {
  Agent,
  CanvasPatch,
  CanvasSurface,
  Envelope,
  GatewayClient,
  GatewayEvent,
  GatewayEventPayload,
  MessageInput,
  PairingApproved,
  PairingHandshake,
  PairingRequest,
  Thread,
  ThreadEvent,
  Token,
  Unsubscribe,
  VoiceOpts,
  VoiceSession,
} from '@openclaw/protocol';
import { encode } from '@openclaw/protocol';

import { resolveHttpBase, startPairingFlow, type FetchLike } from './http';
import { ReconnectController, type ReconnectListener, type ReconnectState } from './reconnect';
import { openSocket, type SocketHandle, type WebSocketFactory } from './ws';

/** Constructor options for `RealGateway`. */
export interface RealGatewayOptions {
  /**
   * HTTP base of the desktop server. Either a host:port from Bonjour or a
   * pasted URL. Required for the pairing flow; reconnect uses the same
   * value (host swap on transport change is deferred to a follow-up).
   */
  httpBase: string;
  /**
   * Human-readable name surfaced in the desktop's approval modal.
   * Required so the desktop can show "Pair iPhone (Jerel)?".
   */
  deviceName: string;
  /**
   * Base64 Ed25519 public key. We send a placeholder for P04A — the
   * desktop accepts it opaquely. P05A starts using the key to sign
   * reconnect challenges.
   */
  publicKey?: string;
  /** Override `globalThis.fetch` — primarily for tests. */
  fetchImpl?: FetchLike;
  /** Override the WS factory — primarily for tests. */
  webSocketFactory?: WebSocketFactory;
}

/** Default placeholder public key — see `RealGatewayOptions.publicKey`. */
export const PLACEHOLDER_PUBLIC_KEY = 'placeholder-mobile-public-key-base64-p04a';

/**
 * The `GatewayClient` implementation that goes over the wire. Composes the
 * three transports + reconnect controller. Owns no mutable UI state; the
 * `PairingProvider` reducer + the discover screen drive it.
 */
export class RealGateway implements GatewayClient {
  private readonly httpBase: string;
  private readonly deviceName: string;
  private readonly publicKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly webSocketFactory?: WebSocketFactory;

  /** Resolves with the token once `awaitPaired` is invoked. */
  private pairedDeferred: Promise<{ token: Token; approved: PairingApproved }> | null = null;
  /** Synchronous handshake the caller already received. */
  private handshake: PairingHandshake | null = null;

  /** Reconnect controller; instantiated by `connect`. */
  private reconnect: ReconnectController | null = null;
  /** Live socket handle. Null until first `connect()` resolves. */
  private socket: SocketHandle | null = null;
  /** Token currently being used by the live socket. */
  private currentToken: string | null = null;

  /** Event listeners by event name. Same shape as `InMemoryMockGateway`. */
  private eventListeners: {
    [E in GatewayEvent]: Set<(payload: GatewayEventPayload[E]) => void>;
  } = {
    connected: new Set(),
    disconnected: new Set(),
    error: new Set(),
    token_expired: new Set(),
  };

  /** Reconnect-state subscribers (used by the global banner). */
  private reconnectListeners = new Set<ReconnectListener>();

  /**
   * Pending request → response correlations, keyed by frame `id`. P05A
   * uses this for `agents.list` / `agents.setActive` / `threads.list`
   * round-trips: send a frame with an id, store the resolver, and the
   * inbound `onMessage` handler fans out by id.
   */
  private pendingRequests = new Map<
    string,
    {
      resolve: (frame: Envelope<unknown>) => void;
      reject: (err: Error) => void;
      /** Timer handle for the per-request timeout. */
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();

  /**
   * Per-thread subscribers. Multiple screens (chat + canvas + an
   * inspector) may want to follow the same thread, so we fan-out by id.
   * The desktop's `threads.event` frames carry `payload.message.threadId`
   * (or `payload.messageId` for stream-only deltas) — we use that to
   * route.
   */
  private threadSubscribers = new Map<string, Set<(e: ThreadEvent) => void>>();

  /**
   * Map of `messageId` → `threadId` populated when a `message` event
   * arrives. Used to route subsequent stream events (`token` /
   * `tool_call` / `done`) which only carry `messageId`. We keep at most
   * 128 entries (FIFO) so the map can't grow unbounded; replays older
   * than that fall through silently, which is acceptable for v1.
   */
  private messageThreadMap = new Map<string, string>();
  /** FIFO key order for `messageThreadMap` so we can evict cheaply. */
  private messageThreadOrder: string[] = [];
  /** Soft cap so the map can't grow without bound. */
  private readonly MESSAGE_MAP_LIMIT = 128;

  constructor(opts: RealGatewayOptions) {
    this.httpBase = resolveHttpBase(opts.httpBase);
    this.deviceName = opts.deviceName;
    this.publicKey = opts.publicKey ?? PLACEHOLDER_PUBLIC_KEY;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.webSocketFactory = opts.webSocketFactory;
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  async requestPairing(_input: PairingRequest): Promise<PairingHandshake> {
    // The `PairingRequest` from `@openclaw/protocol` carries `deviceName`,
    // but we already have it on the constructor — we trust the caller to
    // have set both to the same value at provider-construction time.
    // (Future cleanup: drop `deviceName` from the constructor and read it
    // from the call site only.)
    const flow = await startPairingFlow(
      this.httpBase,
      {
        device_name: this.deviceName,
        public_key: this.publicKey,
      },
      { fetchImpl: this.fetchImpl },
    );
    this.handshake = { code: flow.handshake.code, expiresAt: flow.handshake.expires_at };
    this.pairedDeferred = flow.paired;
    return this.handshake;
  }

  awaitPaired(): Promise<{ token: Token; approved: PairingApproved }> {
    if (!this.pairedDeferred) {
      return Promise.reject(new Error('awaitPaired() called before requestPairing()'));
    }
    return this.pairedDeferred;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    if (!token) throw new Error('connect() requires a non-empty token');
    this.currentToken = token;
    // The reconnect controller owns retry logic; `attempt` returns a promise
    // that resolves on first `onopen`. We wire `onclose` to
    // `notifyDisconnected` so the loop can decide whether to retry.
    return new Promise<void>((resolveConnect, rejectConnect) => {
      let firstConnect = true;
      this.reconnect = new ReconnectController({
        attempt: (signal) =>
          new Promise<void>((resolveAttempt, rejectAttempt) => {
            // Tear down any previous socket before opening a new one.
            this.closeSocket();
            const handle = openSocket(
              {
                httpBase: this.httpBase,
                token,
                factory: this.webSocketFactory,
              },
              {
                onOpen: () => {
                  if (signal.cancelled) {
                    handle.close();
                    return;
                  }
                  this.socket = handle;
                  this.emit('connected', { gatewayId: 'pending-from-handshake' });
                  if (firstConnect) {
                    firstConnect = false;
                    resolveConnect();
                  }
                  resolveAttempt();
                },
                onClose: ({ reason, code, detail }) => {
                  this.socket = null;
                  const reasonStr = detail
                    ? `${reason}: ${detail} (${code ?? '—'})`
                    : `${reason}${code ? ` (${code})` : ''}`;
                  this.emit('disconnected', { reason: reasonStr });
                  // 4001 is the WS close code the desktop will use for
                  // "token rejected" (locked in P04B). If we see anything
                  // 4001-4099 we emit `token_expired` so the UI re-pairs.
                  if (typeof code === 'number' && code >= 4001 && code <= 4099) {
                    this.emit('token_expired', {});
                  }
                  this.reconnect?.notifyDisconnected(reasonStr);
                  if (firstConnect) {
                    firstConnect = false;
                    rejectConnect(new Error(`WebSocket failed to open: ${reasonStr}`));
                  } else {
                    rejectAttempt(new Error(reasonStr));
                  }
                },
                onError: (err) => {
                  this.emit('error', { error: err });
                  // Don't reject the attempt here — `onclose` always follows.
                },
                onMessage: (raw) => {
                  this.handleInboundFrame(raw);
                },
              },
            );
            this.socket = handle;
          }),
      });
      this.reconnect.subscribe((state) => {
        for (const l of this.reconnectListeners) l(state);
      });
      this.reconnect.start();
    });
  }

  on<E extends GatewayEvent>(
    event: E,
    handler: (payload: GatewayEventPayload[E]) => void,
  ): Unsubscribe {
    const set = this.eventListeners[event] as Set<(payload: GatewayEventPayload[E]) => void>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private emit<E extends GatewayEvent>(event: E, payload: GatewayEventPayload[E]): void {
    const set = this.eventListeners[event] as Set<(payload: GatewayEventPayload[E]) => void>;
    for (const h of set) h(payload);
  }

  /**
   * Subscribe to reconnect-controller state. Exposed for the global "Can't
   * reach your Mac" banner — UI code never imports `ReconnectController`
   * directly so the controller stays an implementation detail.
   */
  subscribeReconnect(listener: ReconnectListener): Unsubscribe {
    this.reconnectListeners.add(listener);
    // Replay the current state so the banner can render its initial pass
    // without waiting for a transition.
    const current = this.reconnect?.getState();
    if (current) listener(current);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  /** Current reconnect snapshot, if a session is live. */
  getReconnectState(): ReconnectState | null {
    return this.reconnect?.getState() ?? null;
  }

  /** Tear down the live socket + stop reconnect. Used during re-pair. */
  disconnect(): void {
    this.reconnect?.stop();
    this.reconnect = null;
    this.closeSocket();
    this.currentToken = null;
  }

  private closeSocket(): void {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  // ── Inbound frame routing (P05A) ──────────────────────────────────────────

  /**
   * Dispatch an inbound raw frame to either a pending request (when the
   * frame's `id` matches a stored correlation) or to the thread-event
   * fan-out (`topic === 'threads'` / `type === 'threads.event'`).
   *
   * We do JSON parsing here instead of via `@openclaw/protocol`'s `decode()`
   * because we don't have a single payload schema — different topics carry
   * different shapes. The router on the desktop side already validates
   * outbound payloads, so we trust the structure once `id`/`topic`/`type`
   * are strings.
   */
  private handleInboundFrame(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Heartbeat or malformed frame — log and move on. Spamming
      // `disconnect` for one bad payload would be hostile.
      return;
    }
    if (!isEnvelopeLike(parsed)) return;
    const frame = parsed as Envelope<unknown>;
    // 1. Request/response correlation.
    const pending = this.pendingRequests.get(frame.id);
    if (pending) {
      this.pendingRequests.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(frame);
      // Some response types (notably `threads.event` for posted messages)
      // also need to fan out to thread subscribers; fall through.
    }
    // 2. Thread events (broadcast, not request-scoped).
    if (frame.topic === 'threads' || frame.type === 'threads.event') {
      this.fanOutThreadEvent(frame);
      return;
    }
    // 3. System pong — `ws.ts` schedules the next heartbeat on
    // `onmessage` already, no extra action needed here.
  }

  /**
   * Route a `threads.event` payload to every subscriber for its thread.
   * `message` events carry `threadId` directly; stream events
   * (`token`/`tool_call`/`done`) only carry `messageId`, so we look up
   * the parent thread id in the `messageThreadMap` populated when the
   * matching `message` event arrived.
   */
  private fanOutThreadEvent(frame: Envelope<unknown>): void {
    const payload = frame.payload as ThreadEvent | undefined;
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
    let threadId: string | undefined;
    if (payload.type === 'message') {
      threadId = payload.message.threadId;
      this.rememberMessageThread(payload.message.id, threadId);
    } else if ('messageId' in payload && typeof payload.messageId === 'string') {
      threadId = this.messageThreadMap.get(payload.messageId);
    }
    if (!threadId) return;
    const subs = this.threadSubscribers.get(threadId);
    if (!subs) return;
    for (const sub of [...subs]) {
      try {
        sub(payload);
      } catch (err) {
        // Subscriber errors should not poison the router.
        this.emit('error', { error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
  }

  /** Remember `messageId → threadId` with FIFO eviction. */
  private rememberMessageThread(messageId: string, threadId: string): void {
    if (this.messageThreadMap.has(messageId)) return;
    this.messageThreadMap.set(messageId, threadId);
    this.messageThreadOrder.push(messageId);
    if (this.messageThreadOrder.length > this.MESSAGE_MAP_LIMIT) {
      const evict = this.messageThreadOrder.shift();
      if (evict) this.messageThreadMap.delete(evict);
    }
  }

  /**
   * Send a frame and wait for a response with the same `id`. Resolves with
   * the response frame, or rejects on timeout / socket-not-open. Used by
   * the request/response WS topics (`agents.list`, `agents.setActive`,
   * `threads.list`).
   */
  private async sendAndWait(
    frame: Envelope<unknown>,
    timeoutMs = 10_000,
  ): Promise<Envelope<unknown>> {
    if (!this.socket || !this.socket.isOpen()) {
      throw new Error('Gateway not connected');
    }
    return new Promise<Envelope<unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(frame.id);
        reject(new Error(`Gateway request ${frame.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(frame.id, { resolve, reject, timer });
      try {
        this.socket?.send(encode(frame));
      } catch (err) {
        this.pendingRequests.delete(frame.id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Build a frame skeleton with a fresh `id`. */
  private buildFrame<P>(topic: string, type: string, payload: P): Envelope<P> {
    return {
      id: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      topic,
      type,
      payload,
      ts: Date.now(),
    };
  }

  // ── Agents & routing (P04B WS topics) ─────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    // Topic `agents` — the router fires on prefix `agents.list`. The
    // stub gateway answers with `agents.list.response` carrying `{ agents }`.
    const frame = this.buildFrame<Record<string, never>>('agents', 'agents.list', {});
    const res = await this.sendAndWait(frame);
    const body = (res.payload ?? {}) as { agents?: Agent[] };
    return Array.isArray(body.agents) ? body.agents : [];
  }

  async setActiveAgent(agentId: string): Promise<void> {
    const frame = this.buildFrame('agents', 'agents.setActive', { agentId });
    const res = await this.sendAndWait(frame);
    const body = (res.payload ?? {}) as { ok?: boolean; reason?: string };
    if (body.ok !== true) {
      throw new Error(body.reason ?? `setActiveAgent(${agentId}) rejected by gateway`);
    }
  }

  // ── Threads / messages (P04B WS topics) ───────────────────────────────────

  async listThreads(): Promise<Thread[]> {
    // The stub gateway doesn't yet expose `threads.list` (open question
    // #26 / #28); return [] rather than throwing so callers stay
    // composable. When the desktop grows the topic this will start
    // returning real data without any UI changes.
    if (!this.socket || !this.socket.isOpen()) return [];
    try {
      const frame = this.buildFrame<Record<string, never>>('threads', 'threads.list', {});
      const res = await this.sendAndWait(frame, 5_000);
      const body = (res.payload ?? {}) as { threads?: Thread[] };
      return Array.isArray(body.threads) ? body.threads : [];
    } catch {
      // Treat a missing topic as an empty list rather than a hard error.
      return [];
    }
  }

  async postMessage(threadId: string, input: MessageInput): Promise<void> {
    if (!this.socket || !this.socket.isOpen()) {
      throw new Error('Gateway not connected');
    }
    const frame = this.buildFrame('threads', 'threads.post', {
      threadId,
      content: input.content,
    });
    // `threads.post` doesn't have a synchronous response we wait on — the
    // gateway streams `threads.event` frames as the conversation progresses,
    // which the subscriber consumes. We do a fire-and-forget here.
    this.socket.send(encode(frame));
  }

  streamThread(threadId: string, onEvent: (e: ThreadEvent) => void): Unsubscribe {
    let subs = this.threadSubscribers.get(threadId);
    if (!subs) {
      subs = new Set();
      this.threadSubscribers.set(threadId, subs);
    }
    subs.add(onEvent);
    return () => {
      const set = this.threadSubscribers.get(threadId);
      if (!set) return;
      set.delete(onEvent);
      if (set.size === 0) this.threadSubscribers.delete(threadId);
    };
  }

  // ── Canvas (P06) ──────────────────────────────────────────────────────────

  async getCanvas(_surfaceId: string): Promise<CanvasSurface> {
    throw new Error('getCanvas() requires the Canvas schema (P06)');
  }

  onCanvasUpdate(_surfaceId: string, _handler: (patch: CanvasPatch) => void): Unsubscribe {
    return () => {
      /* no-op */
    };
  }

  // ── Voice (P07) ───────────────────────────────────────────────────────────

  async openVoice(_opts: VoiceOpts): Promise<VoiceSession> {
    throw new Error('openVoice() requires the voice transport (P07)');
  }

  /** Test/debug helper: the token currently bound to the socket, if any. */
  _getCurrentToken(): string | null {
    return this.currentToken;
  }

  /**
   * Test helper: push a raw frame through the inbound router as if it
   * came from the WS. Production code paths never call this; the
   * `__tests__` use it to drive request/response + stream behaviour
   * without a live socket.
   */
  _injectInboundFrame(raw: string): void {
    this.handleInboundFrame(raw);
  }
}

/** Lightweight check that an unknown value has the four envelope fields. */
function isEnvelopeLike(
  v: unknown,
): v is { id: string; topic: string; type: string; payload: unknown } {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { id?: unknown; topic?: unknown; type?: unknown };
  return typeof e.id === 'string' && typeof e.topic === 'string' && typeof e.type === 'string';
}
