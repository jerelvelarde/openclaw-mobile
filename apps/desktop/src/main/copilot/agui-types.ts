// AG-UI protocol shapes — the wire format CopilotKit runtime v2 uses
// for SSE events and the `RunAgentInput` request body.
//
// Source: `@ag-ui/core@0.0.53` (pinned as a peer of `@copilotkit/runtime@1.57.1`)
//   - https://www.npmjs.com/package/@ag-ui/core
//   - https://www.npmjs.com/package/@ag-ui/encoder
//
// We hand-type the small subset we actually translate into. The full
// AG-UI schema includes thinking, reasoning, activity, state delta, and
// multi-modal content events — those aren't emitted by the OpenClaw
// gateway today, so adding them now would be dead code. If/when the
// gateway grows those event kinds (e.g. once Hermes "thinking" surfaces
// land), add their shapes here and a translator branch in `adapter.ts`.
//
// Zod-level validation isn't strictly necessary for the *outbound*
// events we write (we control the shape), but we do validate the
// inbound `RunAgentInput` so a malformed CopilotKit body returns a
// 400 instead of crashing the adapter.

import { z } from 'zod';

// ---- EventType enum ---------------------------------------------------
// Mirrors `@ag-ui/core`'s `EventType` enum. We only enumerate the
// variants we emit; tests + the adapter import these as string literals.
export const AGUI_EVENT_TYPE = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
} as const;
export type AGUIEventType = (typeof AGUI_EVENT_TYPE)[keyof typeof AGUI_EVENT_TYPE];

interface AGUIBaseEvent {
  type: AGUIEventType;
  /** Epoch ms; AG-UI calls this `timestamp` (note: not `ts`). */
  timestamp?: number;
}

/** First event in every successful run. */
export interface RunStartedEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_STARTED;
  threadId: string;
  runId: string;
}

/** Last event in a successful run. */
export interface RunFinishedEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_FINISHED;
  threadId: string;
  runId: string;
  result?: unknown;
}

/** Final event in a failed run. Body becomes the user-visible error toast. */
export interface RunErrorEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_ERROR;
  message: string;
  code?: string;
}

/** Opens a new assistant message; required before any TEXT_MESSAGE_CONTENT. */
export interface TextMessageStartEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_START;
  messageId: string;
  /** Defaults to "assistant" upstream; we always set it explicitly. */
  role: 'developer' | 'system' | 'assistant' | 'user';
}

/** Token / chunk for an open message. `delta` is appended to the message body. */
export interface TextMessageContentEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
}

/** Closes an open message. */
export interface TextMessageEndEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_END;
  messageId: string;
}

/** Opens a tool call. Must be followed by ARGS chunks and an END. */
export interface ToolCallStartEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  /** Which assistant message the tool call belongs to. */
  parentMessageId?: string;
}

/** Streaming chunk of the tool call's argument JSON string. */
export interface ToolCallArgsEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_ARGS;
  toolCallId: string;
  /** Append-to-buffer; CopilotKit reassembles into a JSON string client-side. */
  delta: string;
}

/** Closes a tool call. */
export interface ToolCallEndEvent extends AGUIBaseEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_END;
  toolCallId: string;
}

/** Discriminated union of every AG-UI event the adapter emits. */
export type AGUIEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent;

// ---- RunAgentInput (request body) ------------------------------------
// The shape posted to `POST /copilot/runtime/agent/:agentId/run`.
// Mirrors `RunAgentInputSchema` from `@ag-ui/core`.

const FunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: FunctionCallSchema,
});

const DeveloperMessageSchema = z.object({
  id: z.string(),
  role: z.literal('developer'),
  content: z.string(),
  name: z.string().optional(),
});

const SystemMessageSchema = z.object({
  id: z.string(),
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
});

const UserMessageSchema = z.object({
  id: z.string(),
  role: z.literal('user'),
  content: z.string(),
  name: z.string().optional(),
});

const AssistantMessageSchema = z.object({
  id: z.string(),
  role: z.literal('assistant'),
  // AG-UI marks `content` optional on assistant messages because tool-only
  // assistant turns have no text.
  content: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
  name: z.string().optional(),
});

const ToolMessageSchema = z.object({
  id: z.string(),
  role: z.literal('tool'),
  content: z.string(),
  toolCallId: z.string(),
});

const MessageSchema = z.discriminatedUnion('role', [
  DeveloperMessageSchema,
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
]);

const ToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  // AG-UI uses z.any() for the JSON-schema parameters object.
  parameters: z.unknown().optional(),
});

const ContextSchema = z
  .object({
    description: z.string(),
    value: z.string(),
  })
  .passthrough();

/** Validated CopilotKit / AG-UI run request body. */
export const RunAgentInputSchema = z
  .object({
    threadId: z.string().min(1),
    runId: z.string().min(1),
    parentRunId: z.string().optional(),
    state: z.unknown().optional(),
    messages: z.array(MessageSchema),
    tools: z.array(ToolSchema).optional(),
    context: z.array(ContextSchema).optional(),
    // Forward-compat: AG-UI may add fields. `.passthrough()` keeps them
    // accessible if a future translator branch wants them.
  })
  .passthrough();
export type RunAgentInput = z.infer<typeof RunAgentInputSchema>;
