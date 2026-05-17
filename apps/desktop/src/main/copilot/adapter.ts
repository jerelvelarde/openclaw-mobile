// Translates CopilotKit runtime requests ↔ gateway router envelopes.
//
// Per P05C step 3: this is the protocol shim. It:
//
//   1. Takes a CopilotKit `RunAgentInput` (the JSON body of a
//      `POST /copilot/runtime/agent/:agentId/run`) and synthesises a
//      gateway `threads.post` envelope, publishing it through the
//      `Router` from `transport/router.ts`. The shape of `threads.post`
//      mirrors what the stub gateway in `gateway/stub.ts` already
//      accepts, so the same in-process bus serves both mobile WS clients
//      and CopilotKit HTTP clients.
//   2. Subscribes to the `threads.event` topic before publishing and
//      translates each emitted `ThreadEvent` (`message` / `token` /
//      `tool_call` / `done`) into AG-UI events (`RUN_STARTED`,
//      `TEXT_MESSAGE_START`/`_CONTENT`/`_END`, `TOOL_CALL_START`/
//      `_ARGS`/`_END`, `RUN_FINISHED` / `RUN_ERROR`) which the
//      caller writes out to the SSE stream.
//   3. Cleans up the subscription on `done`, error, or client abort.
//
// The adapter is **stateless per request** — every call to `runAdapter`
// builds a fresh subscription against the router. Conversation state
// lives in the gateway. We never cache messages here.
//
// Tool-call translation: gateway `tool_call` ThreadEvents map to a
// triple of AG-UI `TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`
// events. Args are emitted as a single JSON string chunk (CopilotKit
// streams them as a delta but the stub gateway only emits the final
// args object). The reverse direction — CopilotKit "actions" (tools the
// client side defines) flowing back to the gateway as tool *results* —
// is **not yet implemented**. See `open-questions.md` #27 and the
// `TODO(tool-results)` note below.

import { randomUUID } from 'node:crypto';
import { encode, type ThreadEvent } from '@openclaw/protocol';
import type { InboundFrame, Router } from '../transport/router';
import type { SseWriter } from './stream';
import { type RunAgentInput, type AGUIEvent, AGUI_EVENT_TYPE } from './agui-types';

/** Topic the stub gateway (and the future real bridge) listens on. */
const THREADS_POST_TOPIC = 'threads.post';
/**
 * Type field the gateway uses for streamed chunks. The router's
 * `ctx.reply()` infers `topic = 'threads'` for type `threads.event` (it
 * drops the last segment, see `router.ts` line 98), so subscribing here
 * with topic `threads` is what actually catches the stub gateway's
 * reply frames. We additionally guard against non-event types in the
 * handler so e.g. `threads.list.response` doesn't get translated.
 */
const THREADS_TOPIC = 'threads';
const THREAD_EVENT_TYPE = 'threads.event';
/**
 * Topic on which a real gateway / future tooling might publish error
 * envelopes. We listen for both `threads.error` and `system.error` so
 * either layer can surface a fatal condition.
 */
const ERROR_TOPICS = new Set(['threads.error', 'system.error']);

/** Inputs `runAdapter` needs to translate one request. */
export interface RunAdapterOptions {
  /** The router shared with the WS server + stub gateway. */
  router: Router;
  /** The CopilotKit request body (already JSON-parsed + validated). */
  input: RunAgentInput;
  /** Which agent the client targeted (from the URL `/agent/:agentId/run`). */
  agentId: string;
  /** Bearer-token-derived device id. Used to scope publishes so other phones don't see this thread. */
  deviceId: string;
  /** The SSE writer to push events into. */
  writer: SseWriter;
  /**
   * Abort signal from the underlying request. We unsubscribe + close the
   * writer when the client hangs up.
   */
  signal?: AbortSignal;
  /**
   * Time after which we consider the run hung and emit `RUN_ERROR`. The
   * stub gateway replies in ~50ms; a real bridge may take longer. Default
   * 60s — long enough for a real LLM, short enough that a totally-dead
   * gateway doesn't pin an SSE connection forever.
   */
  timeoutMs?: number;
  /** Clock injection for tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  /** Mirror of `setTimeout` for cleanup. */
  clearTimeout?: (handle: unknown) => void;
}

/** Default run timeout (ms). */
export const DEFAULT_RUN_TIMEOUT_MS = 60_000;

/**
 * Run the adapter for a single request. Resolves once `RUN_FINISHED` /
 * `RUN_ERROR` has been emitted and the writer closed. Caller is
 * responsible for setting SSE headers + creating the writer.
 */
export async function runAdapter(opts: RunAdapterOptions): Promise<void> {
  const { router, input, agentId, deviceId, writer } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const setTimeoutImpl = opts.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutImpl = opts.clearTimeout ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  // Correlate gateway responses with this request. The stub gateway
  // (and the real one per `desktop-app.md` §5) preserves the inbound
  // frame `id` on the immediate ack reply via `ctx.reply(..., { id })`.
  // We don't actually require that to wire things up — we filter by
  // `deviceId` + `threadId` instead — but having a stable correlation
  // id helps debugging.
  const correlationId = `cop_${randomUUID()}`;
  const threadId = input.threadId;
  const messageId = `msg_${randomUUID()}`;

  // ---- AG-UI: RUN_STARTED -----------------------------------------------
  writer.event({
    type: AGUI_EVENT_TYPE.RUN_STARTED,
    threadId,
    runId: input.runId,
    timestamp: Date.now(),
  } satisfies AGUIEvent);

  // Pull the most recent *user* message — the only thing the stub
  // gateway's `threads.post` needs (it ignores history beyond the
  // current ping). Real bridges will read the full message array off
  // the envelope payload.
  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === 'user');
  const userContent =
    lastUserMessage && typeof lastUserMessage.content === 'string' ? lastUserMessage.content : '';

  // ---- Subscribe before publish ----------------------------------------
  // It's important to subscribe *before* publish so we don't miss the
  // synchronous ack the stub gateway emits inside `threads.post`. We
  // narrow to events whose payload threadId matches ours so concurrent
  // requests don't cross-talk.
  let textStarted = false;
  let runSettled = false;

  // Track open tool calls so we can emit a matching TOOL_CALL_END.
  // ThreadEvent.tool_call is one-shot (no streaming delta) but AG-UI
  // splits start/args/end — we synthesise all three off the single
  // gateway event. Map: toolCallId → toolName (kept for symmetric
  // future-proofing if we ever stream args).
  const openToolCalls = new Map<string, string>();

  let timeoutHandle: unknown = null;
  let unsubscribeThreads: (() => void) | null = null;
  let unsubscribeError: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let settledResolve: (() => void) | null = null;

  const settled = new Promise<void>((resolve) => {
    settledResolve = resolve;
  });

  function cleanup(): void {
    if (timeoutHandle) {
      clearTimeoutImpl(timeoutHandle);
      timeoutHandle = null;
    }
    unsubscribeThreads?.();
    unsubscribeThreads = null;
    unsubscribeError?.();
    unsubscribeError = null;
    if (onAbort && opts.signal) {
      opts.signal.removeEventListener('abort', onAbort);
    }
    onAbort = null;
  }

  function finishWith(event: AGUIEvent): void {
    if (runSettled) return;
    runSettled = true;
    // If a text message is still open (no `done` arrived), close it so
    // CopilotKit clients don't see a dangling message.
    if (textStarted) {
      writer.event({
        type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END,
        messageId,
        timestamp: Date.now(),
      } satisfies AGUIEvent);
      textStarted = false;
    }
    writer.event(event);
    cleanup();
    writer.close();
    settledResolve?.();
  }

  function emitRunFinished(): void {
    finishWith({
      type: AGUI_EVENT_TYPE.RUN_FINISHED,
      threadId,
      runId: input.runId,
      timestamp: Date.now(),
    } satisfies AGUIEvent);
  }

  function emitRunError(message: string, code?: string): void {
    finishWith({
      type: AGUI_EVENT_TYPE.RUN_ERROR,
      message,
      ...(code ? { code } : {}),
      timestamp: Date.now(),
    } satisfies AGUIEvent);
  }

  function handleThreadEvent(frame: InboundFrame): void {
    if (runSettled) return;
    // Only react to frames the gateway tagged with our threadId.
    const event = frame.payload as ThreadEvent | undefined;
    if (!event || typeof event !== 'object') return;
    // The stub gateway sends the ack with `type: 'message'` and a
    // `message.threadId`; downstream tokens / tool_calls reference the
    // assistant `messageId` but no longer carry threadId. The router
    // already scopes deliveries by `target.deviceId` so for now we
    // accept every threads.event frame that arrives at this subscriber
    // and rely on the deviceId scoping. (If we ever multiplex multiple
    // threads per device this needs sharpening; see open-questions.)
    switch (event.type) {
      case 'message': {
        // The first `message` is the user-message ack — we don't need to
        // forward it (CopilotKit already has the user message). The
        // *second* `message` is the assistant reply; treat it as the
        // signal to open a text message stream tagged with our
        // synthesised `messageId`. We match on role.
        if (event.message.role === 'assistant' && !textStarted) {
          writer.event({
            type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START,
            messageId,
            role: 'assistant',
            timestamp: Date.now(),
          } satisfies AGUIEvent);
          textStarted = true;
          // If the assistant message arrives with a non-empty `content`
          // (the stub gateway does this), forward it as a single delta
          // so non-streaming gateways still produce visible text.
          if (typeof event.message.content === 'string' && event.message.content.length > 0) {
            writer.event({
              type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: event.message.content,
              timestamp: Date.now(),
            } satisfies AGUIEvent);
          }
        }
        return;
      }
      case 'token': {
        if (!textStarted) {
          writer.event({
            type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START,
            messageId,
            role: 'assistant',
            timestamp: Date.now(),
          } satisfies AGUIEvent);
          textStarted = true;
        }
        writer.event({
          type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT,
          messageId,
          delta: event.delta,
          timestamp: Date.now(),
        } satisfies AGUIEvent);
        return;
      }
      case 'tool_call': {
        // TODO(tool-results): we forward the gateway's tool_call as an
        // AG-UI TOOL_CALL_START/_ARGS/_END triple, but we do not
        // currently round-trip the *result* a CopilotKit client would
        // post back as a `tool` role message. Once mobile (P05A) starts
        // using CopilotKit-defined actions for things the agent calls
        // into, we need to: (a) translate inbound `RunAgentInput` tool
        // results into a `threads.toolResult` envelope, (b) ack on the
        // gateway side. Tracked in open-questions #27.
        const toolCallId = `tc_${randomUUID()}`;
        openToolCalls.set(toolCallId, event.toolName);
        writer.event({
          type: AGUI_EVENT_TYPE.TOOL_CALL_START,
          toolCallId,
          toolCallName: event.toolName,
          parentMessageId: messageId,
          timestamp: Date.now(),
        } satisfies AGUIEvent);
        writer.event({
          type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS,
          toolCallId,
          delta: JSON.stringify(event.args ?? {}),
          timestamp: Date.now(),
        } satisfies AGUIEvent);
        writer.event({
          type: AGUI_EVENT_TYPE.TOOL_CALL_END,
          toolCallId,
          timestamp: Date.now(),
        } satisfies AGUIEvent);
        openToolCalls.delete(toolCallId);
        return;
      }
      case 'done': {
        emitRunFinished();
        return;
      }
      default: {
        // Future ThreadEvent variants — be permissive, just ignore.
        return;
      }
    }
  }

  function handleErrorEvent(frame: InboundFrame): void {
    if (runSettled) return;
    const payload = frame.payload as { message?: unknown; code?: unknown } | undefined;
    const message =
      payload && typeof payload.message === 'string' && payload.message.length > 0
        ? payload.message
        : `gateway error (${frame.type})`;
    const code =
      payload && typeof payload.code === 'string' && payload.code.length > 0
        ? payload.code
        : undefined;
    emitRunError(message, code);
  }

  unsubscribeThreads = router.subscribe(THREADS_TOPIC, (frame, ctx) => {
    // Filter for *our* device: in the live WS topology the broadcaster
    // fans frames out to every session for a deviceId, but the
    // subscriber here runs in-process before that scoping. In tests
    // (and a future router widening) frames for unrelated devices can
    // reach this handler — drop them to avoid cross-talk.
    if (ctx.deviceId !== deviceId) return;
    // We only translate streamed `threads.event` frames; other
    // `threads.*` types (e.g. `threads.list.response`) belong to other
    // request flows and are ignored.
    if (frame.type !== THREAD_EVENT_TYPE) return;
    handleThreadEvent(frame);
  });

  // Subscribe to each known error topic separately so we don't have to
  // teach the router about wildcards beyond its current prefix model.
  const errorUnsubs: Array<() => void> = [];
  for (const topic of ERROR_TOPICS) {
    errorUnsubs.push(
      router.subscribe(topic, (frame, ctx) => {
        if (ctx.deviceId !== deviceId) return;
        handleErrorEvent(frame);
      }),
    );
  }
  unsubscribeError = () => {
    for (const off of errorUnsubs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
  };

  // ---- Inject the gateway request --------------------------------------
  // The router separates `publish` (broadcast-only — goes to the WS
  // broadcaster) from `dispatchRaw` (fires in-process handlers). The
  // stub gateway subscribes via `router.subscribe('threads.post', ...)`
  // — so to wake it up we need to dispatch a frame, not publish one.
  // We synthesise an envelope exactly as a WS client would have sent
  // it: encode → dispatchRaw, scoped to the caller's deviceId so the
  // handler's `ctx.reply` fans back to the right session (and, in our
  // test loopback, only to the right subscriber).
  const inboundEnvelope: InboundFrame = {
    id: correlationId,
    topic: THREADS_POST_TOPIC,
    type: THREADS_POST_TOPIC,
    payload: {
      threadId,
      content: userContent,
      agentId,
    },
    ts: Date.now(),
  };
  const dispatchErr = router.dispatchRaw(encode(inboundEnvelope), { deviceId });
  if (dispatchErr) {
    emitRunError(`failed to dispatch threads.post: ${dispatchErr}`, 'dispatch_error');
    return;
  }

  // ---- Timeout safety net -----------------------------------------------
  timeoutHandle = setTimeoutImpl(() => {
    emitRunError(`run timed out after ${timeoutMs}ms`, 'timeout');
  }, timeoutMs);

  // ---- Abort handling ---------------------------------------------------
  if (opts.signal) {
    if (opts.signal.aborted) {
      emitRunError('client aborted', 'aborted');
    } else {
      onAbort = (): void => {
        emitRunError('client aborted', 'aborted');
      };
      opts.signal.addEventListener('abort', onAbort);
    }
  }

  await settled;
}
