// useGateway — renderer-side hook that mirrors mobile's `GatewayClient`
// surface but speaks directly to the same-process WS server.
//
// Per P05B step 3:
//   - Opens `ws://127.0.0.1:18789/ws` with the self-token issued by
//     main (fetched via `window.api.system.getSelfToken()`).
//   - Sends `agents.list` once after connecting to populate the agent
//     pill + Agents page.
//   - Sends `threads.post` on `postMessage(content)`. The stub gateway
//     (P04B) replies with a `threads.event` stream — we collapse those
//     into a flat list of `Message`s (and a separate per-message
//     ToolCall list) that the UI renders.
//
// Why we don't import `GatewayClient` from `@openclaw/protocol`:
// `GatewayClient` is a *transport-agnostic* facade — it assumes you
// already paired and stashed a token. Here we're driving the WS
// directly because we hold the bearer credential up front (the self
// token) and don't need any of the pairing machinery. We do re-use
// `@openclaw/protocol`'s `encode` + `envelopeSchema` for wire-format
// fidelity.
//
// Reconnect strategy: backoff jittered up to 30 s. Each socket
// instance is owned by a single `connect()` call; the hook only opens
// one at a time. We don't attempt resume / replay — re-issuing a
// `threads.post` would duplicate messages.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Message, ThreadEvent } from '@openclaw/protocol';
import { encode } from '@openclaw/protocol';

/** One tool-call surfaced inline below an assistant message. */
export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Optional result payload once the tool returns. The stub gateway never sets this. */
  result?: unknown;
}

/** A chat message plus optional tool-call attachments. */
export interface ChatMessage extends Message {
  /** Tool calls observed for this assistant message. */
  toolCalls?: ToolCallView[];
  /** True while the gateway is still streaming `token` events into `content`. */
  streaming?: boolean;
}

/** Connection-state enum surfaced to the UI for the status pill. */
export type GatewayConnectionStatus =
  | 'idle' // before first connect attempt
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

/** Tunables consumed by tests (real callers should leave them defaults). */
export interface UseGatewayOptions {
  /** Inject a `WebSocket`-compatible constructor. Defaults to `globalThis.WebSocket`. */
  WebSocketCtor?: typeof WebSocket;
  /**
   * Inject the `getSelfToken` resolver. Defaults to `window.api.system.getSelfToken`.
   * Returning `null` from this resolver disables the WS connection — used by
   * the jsdom smoke path where the preload bridge is absent.
   */
  getSelfToken?: () => Promise<{ token: string; ws_url: string } | null>;
  /** Override the auto-connect behaviour. Defaults to `true`. */
  autoConnect?: boolean;
  /** Override the initial thread id. Defaults to `thread_default`. */
  initialThreadId?: string;
  /** Override the reconnect backoff. Defaults to exponential up to 30 s. */
  computeBackoffMs?: (attempt: number) => number;
  /** Override `setTimeout`. Tests pass a fake. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Mirror of `setTimeout`. */
  clearTimeout?: (handle: unknown) => void;
}

/** Public surface returned by `useGateway`. */
export interface GatewayHandle {
  /** Connection status — drives the "connected" pill. */
  status: GatewayConnectionStatus;
  /** Last error message (if any). Cleared on the next successful open. */
  lastError: string | null;
  /** Agents reported by the gateway. Initially `[]` until the first response. */
  agents: Agent[];
  /** Active agent id; defaults to the first agent in `agents`. */
  activeAgent: string | null;
  /** Switch the active agent locally + send `agents.setActive` to the gateway. */
  setActiveAgent: (agentId: string) => void;
  /** Active thread id (single thread for v1; multi-thread lands later). */
  activeThread: string;
  /** All messages observed for the active thread, oldest-first. */
  messages: ChatMessage[];
  /** Post a new user message; updates state optimistically then dispatches. */
  postMessage: (content: string) => void;
  /** Force-disconnect (tests). */
  disconnect: () => void;
}

interface AgentsListResponse {
  agents?: Agent[];
}

function defaultBackoff(attempt: number): number {
  // 0.5s, 1s, 2s, 4s, 8s, 16s, 30s (cap)
  const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

function makeFrameId(): string {
  // randomUUID is available in modern Electron renderers + jsdom 22+.
  // Fall back to a hand-rolled id so older test environments don't blow up.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

interface OutboundFrame {
  id: string;
  topic: string;
  type: string;
  payload: unknown;
  ts: number;
}

function buildFrame(topic: string, type: string, payload: unknown): OutboundFrame {
  return { id: makeFrameId(), topic, type, payload, ts: Date.now() };
}

/**
 * Resolve the default self-token getter. Splitting this out keeps the
 * hook unit-testable: tests can pass an injected `getSelfToken` that
 * never touches `window.api`.
 */
function defaultGetSelfToken(): Promise<{ token: string; ws_url: string } | null> {
  if (typeof window === 'undefined' || !window.api) {
    return Promise.resolve(null);
  }
  return window.api.system.getSelfToken().then((view) => {
    if (!view.token) return null;
    return { token: view.token, ws_url: view.ws_url };
  });
}

/**
 * Hook that owns the renderer's WS connection + chat state machine.
 *
 * Returns a handle the chat surface uses to render. Internally it
 * spins up exactly one socket per `connect()` cycle and tears it down
 * on unmount. A failed connect schedules a backoff retry; a clean
 * close (peer-initiated 1000) does not — we let the user click into
 * the page again to reconnect.
 */
export function useGateway(opts: UseGatewayOptions = {}): GatewayHandle {
  const WebSocketCtor = opts.WebSocketCtor ?? (typeof WebSocket !== 'undefined' ? WebSocket : null);
  const autoConnect = opts.autoConnect ?? true;
  const initialThreadId = opts.initialThreadId ?? 'thread_default';
  const computeBackoff = opts.computeBackoffMs ?? defaultBackoff;
  const setTimeoutImpl = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutImpl =
    opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const getSelfToken = opts.getSelfToken ?? defaultGetSelfToken;

  const [status, setStatus] = useState<GatewayConnectionStatus>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeAgent, setActiveAgentState] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeThread] = useState<string>(initialThreadId);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectHandleRef = useRef<unknown>(null);
  const attemptRef = useRef<number>(0);
  const unmountedRef = useRef<boolean>(false);
  /** True while a `connect()` call is in flight (between status flip and socket-ready). */
  const connectingRef = useRef<boolean>(false);

  // Track which messages are currently streaming so token events know
  // which message to append to. Map: messageId → array index.
  const messageIndexRef = useRef<Map<string, number>>(new Map());

  // ---- Wire handlers ----------------------------------------------------

  const handleAgentsList = useCallback((payload: AgentsListResponse): void => {
    const list = Array.isArray(payload.agents) ? payload.agents : [];
    setAgents(list);
    setActiveAgentState((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  const handleThreadEvent = useCallback((event: ThreadEvent): void => {
    setMessages((prev) => {
      switch (event.type) {
        case 'message': {
          const idx = prev.findIndex((m) => m.id === event.message.id);
          if (idx >= 0) {
            // Update in place (gateway resent the message with new fields).
            const next = prev.slice();
            next[idx] = { ...prev[idx], ...event.message } as ChatMessage;
            messageIndexRef.current.set(event.message.id, idx);
            return next;
          }
          const fresh: ChatMessage = {
            ...event.message,
            ...(event.message.role === 'assistant' ? { streaming: true } : {}),
          };
          messageIndexRef.current.set(event.message.id, prev.length);
          return [...prev, fresh];
        }
        case 'token': {
          const idx = messageIndexRef.current.get(event.messageId);
          if (idx === undefined || idx >= prev.length) return prev;
          const next = prev.slice();
          const existing = prev[idx];
          if (!existing) return prev;
          next[idx] = {
            ...existing,
            content: `${existing.content}${event.delta}`,
            streaming: true,
          };
          return next;
        }
        case 'tool_call': {
          const idx = messageIndexRef.current.get(event.messageId);
          if (idx === undefined || idx >= prev.length) return prev;
          const next = prev.slice();
          const existing = prev[idx];
          if (!existing) return prev;
          const calls = existing.toolCalls ? existing.toolCalls.slice() : [];
          calls.push({
            toolCallId: `tc_${calls.length}_${event.toolName}`,
            toolName: event.toolName,
            args: event.args,
          });
          next[idx] = { ...existing, toolCalls: calls };
          return next;
        }
        case 'done': {
          const idx = messageIndexRef.current.get(event.messageId);
          if (idx === undefined || idx >= prev.length) return prev;
          const next = prev.slice();
          const existing = prev[idx];
          if (!existing) return prev;
          next[idx] = { ...existing, streaming: false };
          return next;
        }
        default:
          return prev;
      }
    });
  }, []);

  const handleFrame = useCallback(
    (raw: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Server should never send malformed JSON, but ignore quietly.
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const frame = parsed as { topic?: unknown; type?: unknown; payload?: unknown };
      const type = typeof frame.type === 'string' ? frame.type : '';
      const payload = frame.payload;
      if (type === 'agents.list.response') {
        handleAgentsList((payload ?? {}) as AgentsListResponse);
      } else if (type === 'threads.event') {
        handleThreadEvent(payload as ThreadEvent);
      } else if (type === 'agents.setActive.response') {
        // Best-effort: the stub already returns { ok, agentId } — we
        // don't surface failures yet (set in optimistic state below).
      }
    },
    [handleAgentsList, handleThreadEvent],
  );

  // ---- Connect ----------------------------------------------------------

  const send = useCallback((frame: OutboundFrame): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(encode(frame));
      return true;
    } catch {
      return false;
    }
  }, []);

  const requestAgents = useCallback((): void => {
    send(buildFrame('agents.list', 'agents.list', {}));
  }, [send]);

  // Forward declaration so `connect` can reference `scheduleReconnect`.
  // Both useCallback identities are stable across renders thanks to
  // the deps array, so the indirection is fine.
  const scheduleReconnectRef = useRef<(() => void) | null>(null);

  const connect = useCallback(async (): Promise<void> => {
    if (!WebSocketCtor) {
      setStatus('error');
      setLastError('WebSocket is not available in this environment');
      return;
    }
    if (connectingRef.current || socketRef.current) {
      // Another connect is in flight or a socket already exists; bail.
      return;
    }
    connectingRef.current = true;
    setStatus('connecting');
    let resolved: { token: string; ws_url: string } | null;
    try {
      resolved = await getSelfToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(`self-token fetch failed: ${msg}`);
      setStatus('error');
      connectingRef.current = false;
      scheduleReconnectRef.current?.();
      return;
    }
    if (!resolved) {
      setStatus('closed');
      connectingRef.current = false;
      // Don't reconnect; the renderer is in a no-bridge environment.
      return;
    }
    // Pass the token via the documented `?token=...` query param. The
    // header form would be cleaner but browser WebSocket can't set it.
    const url = `${resolved.ws_url}?token=${encodeURIComponent(resolved.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocketCtor(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLastError(`socket construction failed: ${msg}`);
      setStatus('error');
      connectingRef.current = false;
      scheduleReconnectRef.current?.();
      return;
    }
    socketRef.current = ws;
    connectingRef.current = false;

    ws.addEventListener('open', () => {
      if (unmountedRef.current) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        return;
      }
      attemptRef.current = 0;
      setStatus('open');
      setLastError(null);
      requestAgents();
    });

    ws.addEventListener('message', (event: MessageEvent) => {
      const data = event.data;
      if (typeof data === 'string') {
        handleFrame(data);
      } else if (data instanceof ArrayBuffer) {
        handleFrame(new TextDecoder().decode(data));
      }
    });

    ws.addEventListener('error', () => {
      // The `close` handler runs right after; record an error message so
      // the UI can render something useful.
      setLastError('socket error');
      setStatus('error');
    });

    ws.addEventListener('close', () => {
      socketRef.current = null;
      if (unmountedRef.current) return;
      setStatus('closed');
      scheduleReconnectRef.current?.();
    });
  }, [WebSocketCtor, getSelfToken, handleFrame, requestAgents]);

  const scheduleReconnect = useCallback((): void => {
    if (unmountedRef.current) return;
    if (reconnectHandleRef.current) return;
    const attempt = attemptRef.current;
    const ms = computeBackoff(attempt);
    attemptRef.current = attempt + 1;
    reconnectHandleRef.current = setTimeoutImpl(() => {
      reconnectHandleRef.current = null;
      void connect();
    }, ms);
  }, [computeBackoff, setTimeoutImpl, connect]);

  // Wire the ref so `connect` can call `scheduleReconnect` without a
  // forward dep cycle.
  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  // ---- Effects ----------------------------------------------------------

  useEffect(() => {
    unmountedRef.current = false;
    if (!autoConnect) return undefined;
    void connect();
    return (): void => {
      unmountedRef.current = true;
      if (reconnectHandleRef.current) {
        clearTimeoutImpl(reconnectHandleRef.current);
        reconnectHandleRef.current = null;
      }
      const ws = socketRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      socketRef.current = null;
    };
    // We intentionally only run `connect` on mount. The repo doesn't
    // wire up `eslint-plugin-react-hooks` (Wave 6 decision), so we
    // omit `connect` from the deps array on purpose to avoid a
    // re-mount loop when its identity churns.
  }, [autoConnect]);

  // ---- Public actions ---------------------------------------------------

  const postMessage = useCallback(
    (content: string): void => {
      const trimmed = content.trim();
      if (!trimmed) return;
      // Optimistic user-message append. The gateway will ack with its
      // own canonical id; we replace it on receive (by id).
      const localId = `local_${makeFrameId()}`;
      setMessages((prev) => [
        ...prev,
        {
          id: localId,
          threadId: activeThread,
          role: 'user',
          content: trimmed,
          createdAt: Date.now(),
        },
      ]);
      send(
        buildFrame('threads.post', 'threads.post', {
          threadId: activeThread,
          content: trimmed,
          agentId: activeAgent,
        }),
      );
    },
    [activeAgent, activeThread, send],
  );

  const setActiveAgent = useCallback(
    (agentId: string): void => {
      setActiveAgentState(agentId);
      send(buildFrame('agents.setActive', 'agents.setActive', { agentId }));
    },
    [send],
  );

  const disconnect = useCallback((): void => {
    if (reconnectHandleRef.current) {
      clearTimeoutImpl(reconnectHandleRef.current);
      reconnectHandleRef.current = null;
    }
    const ws = socketRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    socketRef.current = null;
    setStatus('closed');
  }, [clearTimeoutImpl]);

  // `threads` is a stretch feature; v1 holds a single thread. We
  // surface it via `activeThread` and consider `messages` the only
  // thread state. Future plans will add a `threads` list + a switcher.
  return useMemo<GatewayHandle>(
    () => ({
      status,
      lastError,
      agents,
      activeAgent,
      setActiveAgent,
      activeThread,
      messages,
      postMessage,
      disconnect,
    }),
    [
      status,
      lastError,
      agents,
      activeAgent,
      setActiveAgent,
      activeThread,
      messages,
      postMessage,
      disconnect,
    ],
  );
}
