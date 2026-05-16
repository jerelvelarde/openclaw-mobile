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

  // ── Agents & routing (P04B WS topics) ─────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    // TODO(P04B): once the desktop exposes the `agents.list` WS topic, send
    // an envelope frame and resolve with the response. Returning an empty
    // list keeps the agents screen renderable without throwing.
    return [];
  }

  async setActiveAgent(_agentId: string): Promise<void> {
    throw new Error('setActiveAgent() requires the WS agents.* topics (P04B)');
  }

  // ── Threads / messages (P04B WS topics) ───────────────────────────────────

  async listThreads(): Promise<Thread[]> {
    // TODO(P04B): mirror `listAgents` — proxy to `threads.list` once it lands.
    return [];
  }

  async postMessage(_threadId: string, _input: MessageInput): Promise<void> {
    throw new Error('postMessage() requires the WS threads.* topics (P04B)');
  }

  streamThread(_threadId: string, _onEvent: (e: ThreadEvent) => void): Unsubscribe {
    // No-op subscription until P04B; returning a sane `Unsubscribe` keeps
    // existing call sites from null-checking.
    return () => {
      /* no-op */
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
}
