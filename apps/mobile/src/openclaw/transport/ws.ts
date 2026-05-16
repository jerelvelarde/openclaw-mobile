// Authenticated WebSocket client.
//
// Opens `ws://host:18789/ws` with an `Authorization: Bearer <token>` header
// (the same token returned by the pairing flow). The wire format is the
// envelope from `@openclaw/protocol` — every send/receive goes through
// `encode`/`decode` so the protocol package owns validation.
//
// `RealGateway` composes this with `ReconnectController` (`reconnect.ts`) so
// transient drops swap the underlying socket without re-pairing. Per the
// plan: tokens are device-bound, not network-bound — moving from LAN ↔
// Tailscale ↔ cellular reuses the same token.
//
// WebSocket header handling is platform-split:
//
//   - On React Native (iOS/Android), the `WebSocket` constructor accepts a
//     headers object as the third argument. This is the supported way to
//     send `Authorization`.
//   - On RN Web (and any browser), the `WebSocket` constructor accepts no
//     header object, so we fall back to a `?token=…` query parameter. The
//     P04B desktop WS endpoint will need to accept either form; we leave a
//     TODO referencing that.

import { Platform } from 'react-native';

import { encode, decode, type Envelope } from '@openclaw/protocol';

/**
 * Local mirror of zod's `ZodType` shape — we only call `.parse(unknown)` on it.
 * Defined here so the mobile package doesn't have to add `zod` to its own
 * dependency tree; the schemas the desktop / protocol package hand us
 * already satisfy this minimal surface.
 */
export interface ZodLikeSchema<T> {
  parse(input: unknown): T;
}

/**
 * Minimal interface we exercise from a `WebSocket` instance. Re-stated so
 * tests can pass a fake without an `as unknown as WebSocket` cast.
 */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

/** `WebSocket.readyState` constants — re-stated to keep the interface light. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

/**
 * Factory the controller uses to create a socket. Production wires this to
 * RN's global `WebSocket` (which on native accepts a headers object as the
 * third arg); tests inject a stub that records the URL + headers.
 */
export type WebSocketFactory = (
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string> | undefined,
) => WebSocketLike;

/**
 * Default factory. Splits between native + web because the constructor
 * signature differs. Don't reach into `globalThis` from elsewhere — go
 * through this factory so the platform fork stays in one place.
 */
const defaultFactory: WebSocketFactory = (url, _protocols, headers) => {
  if (Platform.OS === 'web') {
    // Browsers reject the headers argument; we already encoded the token
    // into the URL by the time we reach here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (globalThis as any).WebSocket(url) as WebSocketLike;
  }
  // React Native's WebSocket accepts options as the 3rd ctor arg:
  // `new WebSocket(url, protocols, options)` where `options.headers` is
  // forwarded to the underlying native socket.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (globalThis as any).WebSocket(url, undefined, { headers }) as WebSocketLike;
};

/** Options handed to `openSocket`. */
export interface OpenSocketOptions {
  /** Base URL — `http(s)://host:port` or `ws(s)://host:port`. We rewrite the scheme. */
  httpBase: string;
  /** Bearer token from the pairing flow. */
  token: string;
  /** WebSocket path. Mirrors the documented `/ws` from `desktop-app.md` §5. */
  path?: string;
  /** Injection seam — defaults to `globalThis.WebSocket`. */
  factory?: WebSocketFactory;
}

/**
 * Coerce an `http(s)://` base to `ws(s)://` so we can keep one base URL
 * across the pairing and WS code paths.
 */
export function toWsBase(httpBase: string): string {
  const trimmed = httpBase.replace(/\/+$/, '');
  if (/^https:\/\//.test(trimmed)) return trimmed.replace(/^https:\/\//, 'wss://');
  if (/^http:\/\//.test(trimmed)) return trimmed.replace(/^http:\/\//, 'ws://');
  if (/^wss?:\/\//.test(trimmed)) return trimmed;
  return `ws://${trimmed}`;
}

/**
 * Build the final WS URL. On web we append `?token=…` because the browser
 * `WebSocket` ctor doesn't take headers; on native the token rides in the
 * `Authorization` header instead and the URL stays clean.
 */
export function buildWsUrl(httpBase: string, token: string, path = '/ws'): string {
  const base = `${toWsBase(httpBase)}${path.startsWith('/') ? path : `/${path}`}`;
  if (Platform.OS === 'web') {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}token=${encodeURIComponent(token)}`;
  }
  return base;
}

/**
 * Heartbeat config. The protocol surface (`.chalk/desktop-app.md` §5) calls
 * for `30s ping/pong`; we treat 90s without a pong as a dead socket. Real
 * pong handling lives at the envelope level (we send a `{type:'ping'}`
 * frame and expect a `pong` frame back) because RN's `WebSocket` doesn't
 * expose the protocol-level ping primitive.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 90_000;

/** Reason strings emitted on `onClose` so callers can switch on them. */
export type CloseReason =
  | 'remote_close'
  | 'heartbeat_timeout'
  | 'manual_close'
  | 'open_failed'
  | 'auth_failed'
  | 'send_error';

/** Callbacks the controller wires for one socket lifetime. */
export interface SocketHandlers {
  onOpen?: () => void;
  onMessage?: (raw: string) => void;
  onError?: (err: Error) => void;
  onClose?: (info: { reason: CloseReason; code?: number; detail?: string }) => void;
}

/** Returned handle for a live socket. */
export interface SocketHandle {
  /** Underlying socket. Exposed for tests; production code should use `send`. */
  socket: WebSocketLike;
  /** Send a raw frame string. Throws if the socket isn't open. */
  send(raw: string): void;
  /** Close the socket. Emits `onClose` with reason `manual_close`. */
  close(code?: number, reason?: string): void;
  /** True while the socket is `OPEN`. */
  isOpen(): boolean;
}

/**
 * Open a single WebSocket against the gateway. The caller owns lifecycle —
 * reconnect logic lives in `reconnect.ts`. This function only does the
 * one-shot wiring.
 */
export function openSocket(opts: OpenSocketOptions, handlers: SocketHandlers = {}): SocketHandle {
  const url = buildWsUrl(opts.httpBase, opts.token, opts.path);
  const factory = opts.factory ?? defaultFactory;
  // On native we send the token as a header; on web we already embedded it
  // in the query string, but we still set the header for any non-browser
  // runtime that respects it.
  const headers = Platform.OS === 'web' ? undefined : { Authorization: `Bearer ${opts.token}` };
  const socket = factory(url, undefined, headers);
  let closedFor: CloseReason | null = null;

  // Heartbeat state. We send a ping every 30s; if no message arrives for
  // 90s we treat the socket as dead and close with `heartbeat_timeout`.
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimers = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    heartbeatTimer = null;
    deadlineTimer = null;
  };

  const armDeadline = (): void => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(() => {
      if (closedFor) return;
      closedFor = 'heartbeat_timeout';
      try {
        socket.close(4000, 'heartbeat_timeout');
      } catch {
        // Closing twice — fine.
      }
    }, HEARTBEAT_TIMEOUT_MS);
  };

  const scheduleHeartbeat = (): void => {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (socket.readyState !== WS_OPEN) return;
      try {
        const frame: Envelope<Record<string, never>> = {
          id: `ping_${Date.now()}`,
          topic: 'system',
          type: 'ping',
          payload: {},
          ts: Date.now(),
        };
        socket.send(encode(frame));
        scheduleHeartbeat();
      } catch (err) {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }, HEARTBEAT_INTERVAL_MS);
  };

  socket.onopen = () => {
    armDeadline();
    scheduleHeartbeat();
    handlers.onOpen?.();
  };
  socket.onmessage = (ev) => {
    armDeadline();
    handlers.onMessage?.(ev.data);
  };
  socket.onerror = (ev) => {
    const err = ev instanceof Error ? ev : new Error('WebSocket error');
    handlers.onError?.(err);
  };
  socket.onclose = (ev) => {
    clearTimers();
    const reason = closedFor ?? 'remote_close';
    handlers.onClose?.({
      reason,
      code: typeof ev?.code === 'number' ? ev.code : undefined,
      detail: typeof ev?.reason === 'string' ? ev.reason : undefined,
    });
  };

  return {
    socket,
    send(raw: string) {
      if (socket.readyState !== WS_OPEN) {
        throw new Error(`WebSocket not open (readyState=${socket.readyState})`);
      }
      socket.send(raw);
    },
    close(code?: number, reason?: string) {
      if (closedFor) return;
      closedFor = 'manual_close';
      try {
        socket.close(code, reason);
      } catch {
        // close-after-close is a no-op.
      }
    },
    isOpen() {
      return socket.readyState === WS_OPEN;
    },
  };
}

/**
 * Decode an incoming frame string into a validated `Envelope<T>`. Thin
 * wrapper that re-throws with a friendly message — `RealGateway` uses
 * this to surface `ZodError`s as gateway-level events.
 *
 * The schema parameter is typed via `ZodLikeSchema` so this module doesn't
 * have to add `zod` as a direct dependency; the schemas from
 * `@openclaw/protocol` are zod schemas at runtime, but structurally we only
 * need `.parse()`.
 */
export function decodeFrame<T>(raw: string, payloadSchema: ZodLikeSchema<T>): Envelope<T> {
  try {
    // `decode` accepts any zod-style schema; cast through `unknown` so the
    // mobile package can pass our local `ZodLikeSchema` without pulling
    // zod's full type graph into its own deps.
    return decode(raw, payloadSchema as unknown as Parameters<typeof decode>[1]) as Envelope<T>;
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`Malformed JSON frame: ${err.message}`);
    throw err;
  }
}
