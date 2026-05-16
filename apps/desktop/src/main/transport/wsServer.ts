// Authenticated WebSocket transport.
//
// Per P04B step 3: attach a `ws.WebSocketServer` to the same fastify
// HTTP server P03B already booted, validate bearer tokens against the
// per-gateway Ed25519 public key, and route every frame through the
// shared `Router`. The WS path is `/ws`.
//
// Auth model:
//   - Mobile clients pass `Authorization: Bearer <token>` on the HTTP
//     upgrade request.
//   - Web clients that can't set headers may pass `?token=…` instead.
//   - Either way the token is the compact `claim.signature` string
//     issued by `pair/token.ts`. We call `verifyToken(publicKey, token)`
//     and reject 401 if it fails.
//
// Heartbeat: 30 s ping. If a socket misses a pong for 90 s we close it.
// (Mobile + the future renderer chat surface will reconnect.)
//
// Session bookkeeping: every authenticated socket is tracked in a
// `Map<sessionId, Session>` keyed by a uuid; we also index by
// `deviceId` so `router.publish({ target: { deviceId } })` can fan out
// to all sessions for one device (a phone may have multiple tabs/apps).

import { randomUUID, type KeyObject } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { encode } from '@openclaw/protocol';
import { verifyToken, type PairingClaim } from '../pair/token';
import type { InboundFrame, Router } from './router';

/** Default WS path mounted on the shared HTTP server. */
export const WS_PATH = '/ws';
/** How often we send a ping frame. */
export const PING_INTERVAL_MS = 30_000;
/** How long we wait for a pong before closing a stale socket. */
export const PONG_TIMEOUT_MS = 90_000;

/** One authenticated client session. */
export interface Session {
  id: string;
  deviceId: string;
  deviceName: string;
  socket: WebSocket;
  /** Last time we received a pong (or, on connect, the connect time). */
  lastPongAt: number;
}

/** Public surface returned by `attachWsServer`. */
export interface WsTransport {
  /** Underlying `ws.WebSocketServer` (exposed for tests). */
  server: WebSocketServer;
  /** Live session map keyed by session id. */
  sessions: Map<string, Session>;
  /** Drop a session by id. Closes the socket. */
  closeSession(sessionId: string, code?: number, reason?: string): void;
  /** Stop the heartbeat loop + close every socket. */
  close(): Promise<void>;
  /** Test-only: return the deviceIds currently connected. */
  _deviceIds(): string[];
}

export interface AttachWsOptions {
  /** Fastify instance whose underlying http.Server we attach to. */
  fastify: FastifyInstance;
  /** Per-gateway signing key — only the public half is used here. */
  publicKey: KeyObject;
  /** The router whose `dispatchRaw` we feed every incoming frame into. */
  router: Router;
  /** Override the WS mount path. Defaults to `/ws`. */
  path?: string;
  /** Override the ping interval (ms). Used by tests. */
  pingIntervalMs?: number;
  /** Override the pong timeout (ms). Used by tests. */
  pongTimeoutMs?: number;
}

interface TokenExtractResult {
  token: string | null;
  /** Where the token came from — for debug logging. */
  source: 'header' | 'query' | 'none';
}

function extractToken(req: IncomingMessage): TokenExtractResult {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (m) {
      return { token: m[1] ?? '', source: 'header' };
    }
  }
  if (req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = url.searchParams.get('token');
      if (q) return { token: q, source: 'query' };
    } catch {
      // Unparsable URL — fall through to 'none'.
    }
  }
  return { token: null, source: 'none' };
}

function reject(socket: NodeJS.WritableStream, code: number, statusText: string): void {
  // 'socket' is the raw `net.Socket` from the upgrade event. Writing
  // an HTTP response by hand is gross but mandatory: `ws` expects us
  // to either call `handleUpgrade` or close the socket ourselves.
  try {
    socket.write(
      `HTTP/1.1 ${code} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    // socket may already be dead; ignore.
  }
  // node sockets have .destroy; the WritableStream typing doesn't include it.
  (socket as unknown as { destroy?: () => void }).destroy?.();
}

/**
 * Attach a WebSocket server to the fastify HTTP server. Returns the
 * transport handle the main process holds onto so it can close on quit.
 */
export function attachWsServer(opts: AttachWsOptions): WsTransport {
  const path = opts.path ?? WS_PATH;
  const pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;

  const httpServer = opts.fastify.server as HttpServer;
  // `noServer: true` keeps `ws` out of fastify's request path; we drive
  // upgrades manually below so the auth check runs before
  // `handleUpgrade` lets the socket through.
  const server = new WebSocketServer({ noServer: true });
  const sessions = new Map<string, Session>();

  // ---- Broadcaster wiring -----------------------------------------------
  // The router calls this whenever an in-process handler publishes a
  // frame. We serialise once and write the same string to every matching
  // session — cheap enough at small fan-out and avoids per-socket JSON.
  opts.router.setBroadcaster((frame: InboundFrame, target) => {
    const encoded = encode(frame);
    for (const session of sessions.values()) {
      if (target?.deviceId && session.deviceId !== target.deviceId) continue;
      if (session.socket.readyState === WebSocket.OPEN) {
        try {
          session.socket.send(encoded);
        } catch {
          // best-effort; the heartbeat will GC dead sockets.
        }
      }
    }
  });

  // ---- Upgrade handshake -------------------------------------------------
  httpServer.on('upgrade', (req, socket, head) => {
    // Only handle our path; let other upgrade handlers (none yet) deal
    // with the rest.
    const url = req.url ? new URL(req.url, 'http://localhost') : null;
    if (!url || url.pathname !== path) {
      // Not for us — leave the socket alone for any other upgrade handler.
      // If nothing claims it, node will eventually time it out.
      return;
    }
    const { token } = extractToken(req);
    if (!token) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    const claim: PairingClaim | null = verifyToken(opts.publicKey, token);
    if (!claim) {
      reject(socket, 401, 'Unauthorized');
      return;
    }
    server.handleUpgrade(req, socket, head, (ws) => {
      onAuthedConnection(ws, claim);
    });
  });

  function onAuthedConnection(ws: WebSocket, claim: PairingClaim): void {
    const session: Session = {
      id: randomUUID(),
      deviceId: claim.device_id,
      deviceName: claim.device_name,
      socket: ws,
      lastPongAt: Date.now(),
    };
    sessions.set(session.id, session);

    ws.on('message', (data) => {
      let raw: string;
      if (typeof data === 'string') {
        raw = data;
      } else if (Buffer.isBuffer(data)) {
        raw = data.toString('utf8');
      } else if (Array.isArray(data)) {
        raw = Buffer.concat(data).toString('utf8');
      } else {
        // ArrayBuffer / similar — coerce defensively.
        raw = Buffer.from(data as ArrayBuffer).toString('utf8');
      }
      const err = opts.router.dispatchRaw(raw, { deviceId: session.deviceId });
      if (err) {
        // eslint-disable-next-line no-console
        console.warn('[openclaw] dropping malformed frame:', err);
      }
    });

    ws.on('pong', () => {
      session.lastPongAt = Date.now();
    });

    ws.on('close', () => {
      sessions.delete(session.id);
    });

    ws.on('error', () => {
      // The 'close' handler will run too; nothing to do beyond surface log.
    });
  }

  // ---- Heartbeat loop ----------------------------------------------------
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (now - session.lastPongAt > pongTimeoutMs) {
        try {
          session.socket.terminate();
        } catch {
          // ignore
        }
        sessions.delete(session.id);
        continue;
      }
      if (session.socket.readyState === WebSocket.OPEN) {
        try {
          session.socket.ping();
        } catch {
          // ignore
        }
      }
    }
  }, pingIntervalMs);
  // Don't keep the event loop alive just for the heartbeat.
  heartbeat.unref?.();

  return {
    server,
    sessions,
    closeSession(sessionId, code, reason) {
      const session = sessions.get(sessionId);
      if (!session) return;
      try {
        session.socket.close(code, reason);
      } catch {
        // ignore
      }
      sessions.delete(sessionId);
    },
    async close() {
      clearInterval(heartbeat);
      for (const session of sessions.values()) {
        try {
          session.socket.terminate();
        } catch {
          // ignore
        }
      }
      sessions.clear();
      opts.router.setBroadcaster(null);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    _deviceIds() {
      return [...sessions.values()].map((s) => s.deviceId);
    },
  };
}
