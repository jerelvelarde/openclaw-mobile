// Run the CopilotKit runtime adapter from the mobile app.
//
// `runAgent(...)` POSTs a `RunAgentInput` to the desktop's
// `/copilot/runtime/agent/:agentId/run` endpoint and pumps the SSE
// response into structured callbacks. The caller (the chat surface)
// renders message bubbles + a tool-call inspector from those callbacks.
//
// We keep this module transport-thin: it only knows about AG-UI events.
// Gateway-level reconnect / token state lives in `RealGateway`.
//
// Why a custom client instead of `@copilotkit/react-native`:
//   - The RN package re-exports `react-core/v2/*` hooks (`useFrontendTool`,
//     `useAgentContext`) whose names don't match the plan's references
//     (`useCopilotAction`, `useCopilotReadable`). We'd be writing a
//     wrapper either way.
//   - `@copilotkit/react-core` pulls Radix, Katex, react-markdown, Lit,
//     and a sandbox iframe lib — all DOM-only and ~100MB of transitive
//     deps that Metro would try to crawl. The `v2/*` subpaths are
//     RN-safe, but the resolver would still need to install everything.
//   - Our adapter is hand-rolled with a documented, pinned wire format
//     (see `apps/desktop/src/main/copilot/runtime.ts`); a small
//     mirror-side client is straightforward.
// See P05A's "CopilotKit RN package decision" report for the rationale.

import {
  buildRunUrl,
  buildRuntimeHeaders,
  resolveRuntimeRequest,
  type RuntimeMode,
} from './runtimeUrl';
import { readSseFromResponse, type ParsedSseFrame, type ReadSseOptions } from './sse';
import { AGUI_EVENT_TYPE, type AGUIEvent, type RunAgentInput } from './types';

/** Generated id used when callers don't pass an explicit run/message id. */
function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a fresh `runId`. Exposed for tests to assert deterministic ids. */
export function newRunId(): string {
  return rid('run');
}

/** Build a fresh `messageId` (used for user messages we synthesize). */
export function newUserMessageId(): string {
  return rid('msg');
}

/** A tool call assembled from a sequence of TOOL_CALL_{START,ARGS,END} events. */
export interface AggregatedToolCall {
  id: string;
  name: string;
  /** Accumulated `delta`s from `TOOL_CALL_ARGS`. JSON string by spec. */
  argsBuffer: string;
  /** Parent message id (CopilotKit doesn't always set this). */
  parentMessageId: string | undefined;
  /** True once the matching `TOOL_CALL_END` arrived. */
  closed: boolean;
}

/** A streaming assistant message — text + tool calls. */
export interface AggregatedAssistantMessage {
  id: string;
  /** Accumulated text content (concatenated `TEXT_MESSAGE_CONTENT.delta`s). */
  content: string;
  /** Tool calls observed on this message, keyed by `toolCallId`, insertion order. */
  toolCalls: AggregatedToolCall[];
  /** True once the matching `TEXT_MESSAGE_END` arrived. */
  closed: boolean;
}

/** High-level callbacks the chat surface wires up. */
export interface RunAgentHandlers {
  /** RUN_STARTED arrived; the run id is bound. */
  onRunStarted?: (e: { threadId: string; runId: string }) => void;
  /** A new assistant message opened. */
  onMessageStart?: (msg: AggregatedAssistantMessage) => void;
  /** A delta extended an open message. The mutated message is passed back. */
  onMessageDelta?: (msg: AggregatedAssistantMessage, delta: string) => void;
  /** TEXT_MESSAGE_END arrived for `msg`. */
  onMessageEnd?: (msg: AggregatedAssistantMessage) => void;
  /** A new tool call opened on `msg`. */
  onToolCall?: (msg: AggregatedAssistantMessage, call: AggregatedToolCall) => void;
  /** A tool call's args buffer grew by `delta`. */
  onToolCallArgs?: (
    msg: AggregatedAssistantMessage,
    call: AggregatedToolCall,
    delta: string,
  ) => void;
  /** Tool call closed (final args available in `call.argsBuffer`). */
  onToolCallEnd?: (msg: AggregatedAssistantMessage, call: AggregatedToolCall) => void;
  /** RUN_FINISHED arrived — the stream is done. */
  onRunFinished?: (e: { threadId: string; runId: string; result?: unknown }) => void;
  /** RUN_ERROR arrived. The caller should surface this to the UI. */
  onRunError?: (e: { message: string; code?: string }) => void;
  /** Raw event tap — useful for tests + diagnostics. */
  onRawEvent?: (frame: ParsedSseFrame) => void;
}

/** Options for `runAgent`. */
export interface RunAgentOptions {
  /** Pre-built runtime URL (per `runtimeUrl.ts#resolveRuntimeUrl`). */
  runtimeUrl: string;
  /** Agent to address (`openclaw.default`, `hermes`, …). */
  agentId: string;
  /** Bearer token from the pairing flow. */
  token: string;
  /** The body to POST. Caller assembles `messages`, `tools`, `context`. */
  input: RunAgentInput;
  /** Hooks the chat UI subscribes to. */
  handlers?: RunAgentHandlers;
  /** Abort signal — cancel the in-flight run. */
  signal?: AbortSignal;
  /**
   * Inject the `fetch` implementation. Production passes `globalThis.fetch`;
   * tests pass a stub that returns a fabricated `Response` whose body
   * yields synthetic SSE frames.
   */
  fetchImpl?: typeof fetch;
  /** Inject the SSE reader (testing). */
  readerFactory?: ReadSseOptions['readerFactory'];
  /**
   * Which wire format to use (P11A). Defaults to `"p05c"` — today's
   * desktop adapter URL + bearer token. Set to `"clawg-ui"` when the
   * desktop is in `gateway_mode: "clawg-ui"` and the pairing handshake
   * gave us a clawg-ui device token + base URL.
   *
   * In `"clawg-ui"` mode, `runtimeUrl` is interpreted as the daemon
   * BASE URL (e.g. `http://192.168.1.42:18789`) and `token` is the
   * clawg-ui device token. The agent id moves from the URL path to the
   * `X-OpenClaw-Agent-Id` header per the plugin's convention.
   */
  mode?: RuntimeMode;
  /**
   * Optional session-key partition. Only honoured in `"clawg-ui"` mode
   * and only when the value matches the plugin's validation regex (see
   * `clawgUiUrl.ts#SESSION_KEY_RE`).
   */
  sessionKey?: string;
}

/**
 * POST the `RunAgentInput` and pump SSE events into the handlers. Resolves
 * when the stream ends (success path). Rejects on HTTP/transport errors;
 * AG-UI `RUN_ERROR` events surface via `onRunError` and resolve normally
 * (they're a successful HTTP transaction with an error event in the body).
 */
export async function runAgent(opts: RunAgentOptions): Promise<void> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const mode: RuntimeMode = opts.mode ?? 'p05c';
  // Two modes share the same SSE pump but differ in URL + header shape.
  // We resolve both through one helper so the call site stays uniform
  // and `runAgent` itself doesn't grow per-mode branches.
  let url: string;
  let headers: Record<string, string>;
  if (mode === 'clawg-ui') {
    const resolved = resolveRuntimeRequest({
      mode: 'clawg-ui',
      agentId: opts.agentId,
      clawgUiBaseUrl: opts.runtimeUrl,
      clawgUiDeviceToken: opts.token,
      ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    });
    url = resolved.url;
    headers = resolved.headers;
  } else {
    // P05C — keep the explicit `buildRunUrl` + `buildRuntimeHeaders`
    // calls so the stub-mode wire format is unchanged + the existing
    // test assertions stay valid.
    url = buildRunUrl(opts.runtimeUrl, opts.agentId);
    headers = buildRuntimeHeaders(opts.token);
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.input),
    signal: opts.signal,
  });
  if (!res.ok) {
    // The adapter returns 400 for malformed body and 401 for bad auth as
    // plain JSON. Try to surface the inner `error` string if it's there.
    let detail = '';
    try {
      const body = (await res.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string') detail = `: ${body.error}`;
    } catch {
      /* not JSON — keep detail empty */
    }
    throw new Error(`Copilot runtime HTTP ${res.status}${detail}`);
  }
  await pumpEvents(res, opts);
}

async function pumpEvents(res: Response, opts: RunAgentOptions): Promise<void> {
  const messages = new Map<string, AggregatedAssistantMessage>();
  const toolCalls = new Map<
    string,
    { call: AggregatedToolCall; msg: AggregatedAssistantMessage }
  >();
  let currentMessage: AggregatedAssistantMessage | null = null;

  const onEvent = (frame: ParsedSseFrame): void => {
    opts.handlers?.onRawEvent?.(frame);
    const e: AGUIEvent = frame.event;
    switch (e.type) {
      case AGUI_EVENT_TYPE.RUN_STARTED: {
        opts.handlers?.onRunStarted?.({ threadId: e.threadId, runId: e.runId });
        break;
      }
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_START: {
        const msg: AggregatedAssistantMessage = {
          id: e.messageId,
          content: '',
          toolCalls: [],
          closed: false,
        };
        messages.set(e.messageId, msg);
        currentMessage = msg;
        opts.handlers?.onMessageStart?.(msg);
        break;
      }
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT: {
        const msg = messages.get(e.messageId);
        if (!msg) break;
        msg.content += e.delta;
        opts.handlers?.onMessageDelta?.(msg, e.delta);
        break;
      }
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_END: {
        const msg = messages.get(e.messageId);
        if (!msg) break;
        msg.closed = true;
        opts.handlers?.onMessageEnd?.(msg);
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_START: {
        // `parentMessageId` is optional — fall back to the message we last
        // saw so the inspector still groups under the right bubble.
        const explicitParent = e.parentMessageId ? messages.get(e.parentMessageId) : undefined;
        const parent: AggregatedAssistantMessage | null = explicitParent ?? currentMessage;
        // If no message is open at all, synthesize a phantom one so the
        // tool call has a parent in the UI. This shouldn't happen in
        // practice but keeps the renderer simple.
        let msg: AggregatedAssistantMessage;
        if (parent) {
          msg = parent;
        } else {
          msg = {
            id: `synth_${e.toolCallId}`,
            content: '',
            toolCalls: [],
            closed: false,
          };
          messages.set(msg.id, msg);
        }
        const call: AggregatedToolCall = {
          id: e.toolCallId,
          name: e.toolCallName,
          argsBuffer: '',
          parentMessageId: e.parentMessageId,
          closed: false,
        };
        msg.toolCalls.push(call);
        toolCalls.set(e.toolCallId, { call, msg });
        opts.handlers?.onToolCall?.(msg, call);
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_ARGS: {
        const entry = toolCalls.get(e.toolCallId);
        if (!entry) break;
        entry.call.argsBuffer += e.delta;
        opts.handlers?.onToolCallArgs?.(entry.msg, entry.call, e.delta);
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_END: {
        const entry = toolCalls.get(e.toolCallId);
        if (!entry) break;
        entry.call.closed = true;
        opts.handlers?.onToolCallEnd?.(entry.msg, entry.call);
        break;
      }
      case AGUI_EVENT_TYPE.RUN_FINISHED: {
        opts.handlers?.onRunFinished?.({
          threadId: e.threadId,
          runId: e.runId,
          result: e.result,
        });
        break;
      }
      case AGUI_EVENT_TYPE.RUN_ERROR: {
        opts.handlers?.onRunError?.({ message: e.message, code: e.code });
        break;
      }
      default: {
        // Forward-compat: unknown events are silently ignored. The raw
        // event still fires via `onRawEvent` for diagnostics.
        break;
      }
    }
  };

  await readSseFromResponse(res, {
    onEvent,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.readerFactory ? { readerFactory: opts.readerFactory } : {}),
  });
}
