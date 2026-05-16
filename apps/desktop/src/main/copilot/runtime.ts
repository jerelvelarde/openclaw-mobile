// CopilotKit runtime adapter — fastify route + auth.
//
// =====================================================================
// PINNED CopilotKit runtime spec version
// =====================================================================
// Package: @copilotkit/runtime
// Version: 1.57.1  (npm dist-tag `latest` as of 2026-05-16)
// Wire-protocol shape we target (v2, multi-route mode):
//
//   Request:  POST  <basePath>/agent/:agentId/run
//   Headers:  Authorization: Bearer <openclaw pairing token>
//             Content-Type: application/json
//   Body:     `RunAgentInput` per @ag-ui/core@0.0.53 — see
//             `agui-types.ts#RunAgentInputSchema`. Concretely:
//               {
//                 threadId: string,
//                 runId:    string,
//                 messages: Array<{ id, role, content, ... }>,
//                 tools?:   Array<{ name, description, parameters }>,
//                 context?: Array<{ description, value }>,
//                 state?:   unknown,
//               }
//
//   Response: 200 text/event-stream
//             Body: a sequence of `data: <JSON>\n\n` SSE frames where
//             each `<JSON>` is an AG-UI BaseEvent — see
//             `agui-types.ts#AGUIEvent`. Concrete event sequence for
//             the streamed-text + tool-call case:
//               { type: "RUN_STARTED", threadId, runId, ... }
//               { type: "TEXT_MESSAGE_START",   messageId, role: "assistant" }
//               { type: "TEXT_MESSAGE_CONTENT", messageId, delta }
//               …
//               { type: "TEXT_MESSAGE_END",     messageId }
//               { type: "TOOL_CALL_START",  toolCallId, toolCallName }
//               { type: "TOOL_CALL_ARGS",   toolCallId, delta }
//               { type: "TOOL_CALL_END",    toolCallId }
//               { type: "RUN_FINISHED", threadId, runId, ... }
//             Error variant emits `{ type: "RUN_ERROR", message, code? }`
//             in place of `RUN_FINISHED`.
//
// References (read in `/tmp/cpk-probe/` when authoring):
//   @copilotkit/runtime/v2/src/runtime/endpoints/node.ts (createCopilotNodeListener)
//   @copilotkit/runtime/v2/src/runtime/core/fetch-router.ts (URL pattern table)
//   @copilotkit/runtime/v2/src/runtime/handlers/sse/run.ts (handleSseRun)
//   @copilotkit/runtime/v2/src/runtime/handlers/shared/sse-response.ts (createSseEventResponse)
//   @ag-ui/encoder@0.0.53 (EventEncoder.encodeSSE -> `data: ${JSON.stringify(event)}\n\n`)
//   @ag-ui/core@0.0.53 (EventType enum, BaseEventSchema, RunAgentInputSchema)
//
// =====================================================================
// Why we hand-roll vs. use the @copilotkit/runtime Node helper
// =====================================================================
// `createCopilotNodeListener` from `@copilotkit/runtime/v2/node` wants a
// fully-constructed `CopilotRuntime` whose `agents` are `AbstractAgent`
// instances from `@ag-ui/client`. Building one would mean (a) wrapping
// each gateway agent in an `AbstractAgent` adapter (subclass with a
// custom `run()` method emitting RxJS `Observable<BaseEvent>`), and (b)
// pulling in the runtime's transitive deps (graphql-yoga, langchain
// peer deps, openai SDK, hono, express, pino-pretty, remix's
// node-fetch-server, scarf telemetry, …) into the Electron main
// process. That's roughly +40 MB of node_modules and a large attack
// surface for what is, fundamentally, a JSON↔JSON translator. The wire
// format itself is documented and stable in v2 (SSE `data: <JSON>\n\n`
// + `@ag-ui/core` EventType enum), so we mirror it directly. See the
// plan's "Critical constraints" — we hand-roll because the helper's
// shape pulls the whole runtime in even though we only want the
// listener half.
//
// =====================================================================
// Auth model
// =====================================================================
// Same as the WS server (`pair/server.ts` + `transport/wsServer.ts`):
// `Authorization: Bearer <token>` where `<token>` is the compact
// `claim.signature` issued at pairing time. We call `verifyToken(...)`
// from `pair/token.ts`; bad / missing / expired → 401.
// =====================================================================

import type { KeyObject } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyToken, type PairingClaim } from '../pair/token';
import type { Router } from '../transport/router';
import { runAdapter } from './adapter';
import { RunAgentInputSchema } from './agui-types';
import { createSseWriter, type SseSink, type SseWriterOptions } from './stream';

/** Default URL prefix mounted on the existing fastify server. */
export const DEFAULT_COPILOT_BASE_PATH = '/copilot/runtime';

/** Inputs needed to register the route. */
export interface RegisterCopilotRuntimeOptions {
  /** The fastify server P03B/P04B booted — we add a route, no second listener. */
  fastify: FastifyInstance;
  /** Per-gateway signing keypair — only the public half is used here. */
  publicKey: KeyObject;
  /** The router shared with the WS server + stub gateway. */
  router: Router;
  /** Override the base path. Default: `/copilot/runtime`. */
  basePath?: string;
  /**
   * Heartbeat / SSE writer tuning. Tests use this to short-circuit
   * timers + inject a non-`setInterval` clock.
   */
  sseOptions?: SseWriterOptions;
  /**
   * Override the run timeout. Tests can shorten this so a misbehaving
   * gateway doesn't hold the suite for 60s.
   */
  runTimeoutMs?: number;
  /** Test-only setTimeout / clearTimeout for the run timeout. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface AgentParams {
  agentId: string;
}

interface BearerExtract {
  token: string | null;
  source: 'header' | 'query' | 'none';
}

function extractBearer(req: FastifyRequest): BearerExtract {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (m) return { token: m[1] ?? '', source: 'header' };
  }
  // CopilotKit clients can't always set headers (e.g. EventSource in the
  // browser), so we also accept `?token=…`. Mirrors the WS server.
  const query = req.query as Record<string, unknown> | undefined;
  const q = query?.['token'];
  if (typeof q === 'string' && q.length > 0) {
    return { token: q, source: 'query' };
  }
  return { token: null, source: 'none' };
}

/**
 * Register the CopilotKit runtime route on the given fastify instance.
 * Mounts `POST <basePath>/agent/:agentId/run`. The fastify server is
 * **not** started here — the caller already booted it in
 * `pair/server.ts`. We just add a route handler.
 */
export function registerCopilotRuntime(opts: RegisterCopilotRuntimeOptions): void {
  const basePath = opts.basePath ?? DEFAULT_COPILOT_BASE_PATH;
  const runUrl = `${basePath}/agent/:agentId/run`;

  opts.fastify.post<{ Params: AgentParams }>(runUrl, async (req, reply) => {
    // ---- Auth ---------------------------------------------------------
    const { token } = extractBearer(req);
    if (!token) {
      void reply.code(401);
      return { error: 'missing bearer token' };
    }
    const claim: PairingClaim | null = verifyToken(opts.publicKey, token);
    if (!claim) {
      void reply.code(401);
      return { error: 'invalid token' };
    }

    // ---- Body validation ---------------------------------------------
    const parsed = RunAgentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      void reply.code(400);
      return {
        error: 'invalid run request body',
        details: parsed.error.issues[0]?.message ?? 'validation failed',
      };
    }

    // ---- SSE response ------------------------------------------------
    // Fastify exposes the raw http.ServerResponse via `reply.raw`; we
    // bypass fastify's reply serialiser entirely so we can stream.
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    // SSE-over-HTTP requires no `Transfer-Encoding: chunked` header
    // manipulation — Node's http server adds it automatically when no
    // content-length is set. We also disable buffering for proxies that
    // honour it (nginx, traefik); harmless when absent.
    raw.setHeader('X-Accel-Buffering', 'no');
    // Flush headers immediately so the client begins parsing events
    // before the gateway emits the first one.
    raw.flushHeaders?.();

    const sink: SseSink = {
      write(chunk) {
        return raw.write(chunk);
      },
      end() {
        try {
          raw.end();
        } catch {
          // ignore — already ended
        }
      },
      on(event, listener) {
        return raw.on(event, listener);
      },
    };
    const writer = createSseWriter(sink, opts.sseOptions ?? {});

    // ---- Run the adapter --------------------------------------------
    // `req.raw` is the underlying http.IncomingMessage. We don't get an
    // `AbortSignal` automatically from fastify, so we wire one up from
    // the request's `close` event.
    const abort = new AbortController();
    req.raw.on('close', () => {
      if (!writer.closed) {
        abort.abort();
      }
    });

    try {
      await runAdapter({
        router: opts.router,
        input: parsed.data,
        agentId: req.params.agentId,
        deviceId: claim.device_id,
        writer,
        signal: abort.signal,
        ...(opts.runTimeoutMs !== undefined ? { timeoutMs: opts.runTimeoutMs } : {}),
        ...(opts.setTimeout ? { setTimeout: opts.setTimeout } : {}),
        ...(opts.clearTimeout ? { clearTimeout: opts.clearTimeout } : {}),
      });
    } catch (err) {
      // The adapter handles its own errors via RUN_ERROR events. If
      // something escapes (e.g. a bug in the translator) we still need
      // to close the SSE stream to free the socket.
      // eslint-disable-next-line no-console
      console.error('[openclaw] copilot runtime adapter crashed:', err);
      if (!writer.closed) {
        writer.close();
      }
    }
    // We've already ended the response; tell fastify not to send a body.
    return reply;
  });

  // Healthcheck on the runtime path so curl-based smoke tests confirm
  // the route is mounted without needing a paired device. Returns a
  // tiny JSON shape; no auth required (matches `/healthz`).
  opts.fastify.get(`${basePath}/healthz`, async () => {
    return { ok: true, runtime: 'copilotkit', version: '1.57.1' };
  });
}

/** Re-export the validation schema so tests can build well-formed bodies. */
export { RunAgentInputSchema } from './agui-types';

/**
 * Build the headers + body shape an AG-UI / CopilotKit client would
 * send. Exposed for ergonomic test setup — the real schema is the
 * canonical contract.
 */
export interface CopilotRequestPreview {
  url: string;
  body: unknown;
}
export function buildPreview(input: {
  basePath?: string;
  agentId: string;
  threadId: string;
  runId: string;
  userText: string;
}): CopilotRequestPreview {
  const basePath = input.basePath ?? DEFAULT_COPILOT_BASE_PATH;
  return {
    url: `${basePath}/agent/${encodeURIComponent(input.agentId)}/run`,
    body: {
      threadId: input.threadId,
      runId: input.runId,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: input.userText,
        },
      ],
    },
  };
}
