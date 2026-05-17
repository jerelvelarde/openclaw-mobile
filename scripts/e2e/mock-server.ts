// Mocked HTTP/SSE peer for the E2E driver (P11E).
//
// Stands up a tiny `node:http` server that mimics the surface of
// `vendor/clawg-ui/src/http-handler.ts` precisely enough for
// `driver.ts` to exercise its full scenario:
//
//   - First unauthenticated POST to `/v1/clawg-ui` → 403 with the
//     `pairing_pending` envelope (matching the shape at
//     `vendor/clawg-ui/src/http-handler.ts:294-307`).
//   - `approveCode(code)` flips an in-process flag.
//   - Second POST (with `Authorization: Bearer <token>`) → 200
//     text/event-stream emitting the full AG-UI sequence.
//
// This is deliberately a hand-rolled fake, NOT a full reimplementation
// of clawg-ui. The point is to prove that the driver logic and SSE
// parser handle the documented happy path; the real wire shape is
// asserted in CI by running the same driver against the actual Docker
// container.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface MockServerHandle {
  baseUrl: string;
  port: number;
  approve: (code: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Last pairing code the server emitted, if any. */
  lastPairingCode: () => string | undefined;
  close: () => Promise<void>;
}

export interface MockServerOptions {
  /**
   * When the second POST arrives, how many `TEXT_MESSAGE_CONTENT`
   * frames to emit. Defaults to `2` so the driver's "≥1 chunk"
   * assertion has slack.
   */
  contentChunks?: number;
  /** Override the prefix that goes into TEXT_MESSAGE_CONTENT.delta. */
  echoPrefix?: string;
  /**
   * If set, the server will skip the `RUN_FINISHED` event. Used by the
   * negative-case smoke check inside `validate-driver.ts` to confirm
   * the driver reports the missing event as a failed assertion.
   */
  omitRunFinished?: boolean;
}

interface PendingPairing {
  code: string;
  token: string;
  approved: boolean;
}

export function startMockServer(opts: MockServerOptions = {}): Promise<MockServerHandle> {
  const contentChunks = Math.max(1, opts.contentChunks ?? 2);
  const echoPrefix = opts.echoPrefix ?? 'echo: ';
  // We track at most one pending pairing per server — that's all the
  // driver needs.
  let pending: PendingPairing | null = null;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/clawg-ui')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = req.headers['authorization'];
    if (!auth) {
      // Issue a fresh pairing on every unauthenticated request, matching
      // clawg-ui's behaviour at `vendor/clawg-ui/src/http-handler.ts:267-307`.
      const code = randomBytes(4).toString('hex').toUpperCase();
      const token = `${randomBytes(8).toString('base64url')}.${randomBytes(16).toString('hex')}`;
      pending = { code, token, approved: false };
      const body = {
        pairing_code: code,
        bearer_token: token,
        error: {
          type: 'pairing_pending',
          message: 'Device pending approval',
          pairing: {
            pairingCode: code,
            token,
            instructions: `Save this token for use as a Bearer token and ask the owner to approve: openclaw pairing approve clawg-ui ${code}`,
          },
        },
      };
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
      return;
    }

    // Authorized path. Validate the token + approval state.
    const bearer = String(auth).replace(/^Bearer\s+/i, '');
    if (!pending || pending.token !== bearer) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { type: 'unauthorized', message: 'Invalid token' } }));
      return;
    }
    if (!pending.approved) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: { type: 'pairing_pending', message: 'Awaiting owner approval' },
        }),
      );
      return;
    }

    // Drain the request body (we don't really parse it; the driver
    // tests assert on the response shape, not on what we received).
    let received = '';
    req.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf-8');
    });
    req.on('end', () => {
      // Begin the SSE response.
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const threadId = pickStringField(received, 'threadId') ?? 'mock-thread';
      const runId = pickStringField(received, 'runId') ?? 'mock-run';
      const messageId = `msg-${randomBytes(4).toString('hex')}`;

      writeSse(res, { type: 'RUN_STARTED', threadId, runId });
      writeSse(res, { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
      for (let i = 0; i < contentChunks; i++) {
        writeSse(res, {
          type: 'TEXT_MESSAGE_CONTENT',
          messageId,
          delta: i === 0 ? echoPrefix : `chunk-${i}`,
        });
      }
      writeSse(res, { type: 'TEXT_MESSAGE_END', messageId });
      if (!opts.omitRunFinished) {
        writeSse(res, { type: 'RUN_FINISHED', threadId, runId });
      }
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      const handle: MockServerHandle = {
        baseUrl,
        port,
        approve: async (code: string) => {
          if (!pending) return { ok: false, detail: 'no pending pairing' };
          if (pending.code !== code) {
            return { ok: false, detail: `code mismatch (got ${code}, expected ${pending.code})` };
          }
          pending.approved = true;
          return { ok: true };
        },
        lastPairingCode: () => pending?.code,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      };
      resolve(handle);
    });
  });
}

function writeSse(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Cheap field extractor — avoids pulling in a full JSON parse just for
 * the mock's diagnostic echo. Returns the first matching string field
 * or undefined.
 */
function pickStringField(body: string, key: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const val = parsed[key];
    return typeof val === 'string' ? val : undefined;
  } catch {
    return undefined;
  }
}

// Suppress an unused-import warning by re-exporting the http types we
// referenced only for documentation.
export type { IncomingMessage, ServerResponse };
