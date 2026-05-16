// The `GatewayClient` interface — the single seam between the apps' UIs and
// whatever is on the other end (real gateway WS, in-memory mock, or a
// future test double). See `.chalk/plan.md` §7 for the canonical sketch.
//
// All UI code talks to this interface; nothing else (no `fetch`, no
// `WebSocket`). That means transports (P04A/P04B) can swap underneath
// without UI churn, and tests can drop in `InMemoryMockGateway` for free.

import type {
  Agent,
  MessageInput,
  PairingApproved,
  PairingRequest,
  Thread,
  ThreadEvent,
  Token,
  VoiceOpts,
  VoiceSession,
} from './types';
import type { CanvasPatch, CanvasSurface } from './canvas';

/** Removes a previously-registered listener. */
export type Unsubscribe = () => void;

/**
 * Coarse connection-level events. Renderers wire these to status badges,
 * reconnect banners, and pairing-expiry toasts.
 */
export type GatewayEvent = 'connected' | 'disconnected' | 'error' | 'token_expired';

/** Payload passed to `GatewayClient.on` handlers, keyed by event. */
export interface GatewayEventPayload {
  connected: { gatewayId: string };
  disconnected: { reason: string };
  error: { error: Error };
  token_expired: Record<string, never>;
}

/**
 * The pairing handshake response is returned by `requestPairing`. The
 * mobile app shows `code` to the user; the desktop app prompts the user
 * to confirm; when confirmed `awaitPaired` resolves with the bearer token.
 */
export interface PairingHandshake {
  code: string;
  expiresAt: number;
}

/**
 * Single transport seam used by every UI in both apps. All concrete
 * implementations (LAN WS, Tailscale WS, relay, in-memory mock) must
 * satisfy this interface without `// @ts-expect-error`.
 */
export interface GatewayClient {
  // ── Pairing ─────────────────────────────────────────────────────────────

  /** Ask the desktop to start a pairing flow; returns the code to display. */
  requestPairing(input: PairingRequest): Promise<PairingHandshake>;

  /**
   * Resolves when the desktop approves the pairing request (i.e. when the
   * user clicked "Approve" in the menu-bar UI). Returns the bearer token
   * the mobile app should store in secure storage.
   */
  awaitPaired(): Promise<{ token: Token; approved: PairingApproved }>;

  // ── Connection ──────────────────────────────────────────────────────────

  /** Upgrade to an authenticated session using a previously-issued token. */
  connect(token: string): Promise<void>;

  /** Subscribe to a connection-level event. */
  on<E extends GatewayEvent>(
    event: E,
    handler: (payload: GatewayEventPayload[E]) => void,
  ): Unsubscribe;

  // ── Agents & routing ────────────────────────────────────────────────────

  /** All agents the gateway currently exposes. */
  listAgents(): Promise<Agent[]>;

  /** Pick which agent this device routes to by default. */
  setActiveAgent(agentId: string): Promise<void>;

  // ── Threads / messages ──────────────────────────────────────────────────

  /** Existing threads, newest first. */
  listThreads(): Promise<Thread[]>;

  /** Post a user message into a thread. Server-side reply streams via `streamThread`. */
  postMessage(threadId: string, input: MessageInput): Promise<void>;

  /** Subscribe to streamed `ThreadEvent`s for a thread. */
  streamThread(threadId: string, onEvent: (e: ThreadEvent) => void): Unsubscribe;

  // ── Canvas ──────────────────────────────────────────────────────────────

  /** Fetch the current snapshot of a Canvas surface. */
  getCanvas(surfaceId: string): Promise<CanvasSurface>;

  /** Subscribe to incremental updates for a Canvas surface. */
  onCanvasUpdate(surfaceId: string, handler: (patch: CanvasPatch) => void): Unsubscribe;

  // ── Voice ───────────────────────────────────────────────────────────────

  /** Open a voice session. Returns a handle for sending/receiving frames. */
  openVoice(opts: VoiceOpts): Promise<VoiceSession>;
}
