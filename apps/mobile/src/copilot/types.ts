// AG-UI / CopilotKit runtime wire shapes — mobile-side mirror.
//
// Mirrors `apps/desktop/src/main/copilot/agui-types.ts`. We re-declare here
// so the mobile app doesn't take a runtime dep on the desktop tree (which
// pulls fastify, electron, zod, etc.). Pinned to the same spec the desktop
// adapter emits: `@copilotkit/runtime@1.57.1` / `@ag-ui/core@0.0.53`.
//
// This file is intentionally minimal — only the event variants the desktop
// adapter actually emits today (P05C). If the desktop grows new event kinds
// (thinking, reasoning, activity, state delta), add their shapes here and a
// renderer branch in `chat-stream.ts`.

/** Discriminator literals for AG-UI events, mirrored from `agui-types.ts`. */
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

export interface RunStartedEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_STARTED;
  threadId: string;
  runId: string;
  timestamp?: number;
}
export interface RunFinishedEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_FINISHED;
  threadId: string;
  runId: string;
  result?: unknown;
  timestamp?: number;
}
export interface RunErrorEvent {
  type: typeof AGUI_EVENT_TYPE.RUN_ERROR;
  message: string;
  code?: string;
  timestamp?: number;
}
export interface TextMessageStartEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_START;
  messageId: string;
  role: 'developer' | 'system' | 'assistant' | 'user';
  timestamp?: number;
}
export interface TextMessageContentEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT;
  messageId: string;
  delta: string;
  timestamp?: number;
}
export interface TextMessageEndEvent {
  type: typeof AGUI_EVENT_TYPE.TEXT_MESSAGE_END;
  messageId: string;
  timestamp?: number;
}
export interface ToolCallStartEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_START;
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
  timestamp?: number;
}
export interface ToolCallArgsEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_ARGS;
  toolCallId: string;
  delta: string;
  timestamp?: number;
}
export interface ToolCallEndEvent {
  type: typeof AGUI_EVENT_TYPE.TOOL_CALL_END;
  toolCallId: string;
  timestamp?: number;
}

/** Discriminated union of every AG-UI event the desktop adapter emits. */
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

// ── RunAgentInput (POST body) ────────────────────────────────────────────
// Mirrors the schema in `apps/desktop/src/main/copilot/agui-types.ts` —
// only the shapes we actually build on the mobile side. We don't validate
// outbound payloads at runtime; the desktop adapter does the validation
// and returns 400 if we mis-shape something. Keeping these as plain TS
// keeps the mobile bundle lean (no zod import here).

/** Function-call shape carried inside an assistant message. */
export interface AGUIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Message variants accepted in `RunAgentInput.messages`. */
export type AGUIMessage =
  | { id: string; role: 'developer'; content: string; name?: string }
  | { id: string; role: 'system'; content: string; name?: string }
  | { id: string; role: 'user'; content: string; name?: string }
  | {
      id: string;
      role: 'assistant';
      content?: string;
      toolCalls?: AGUIToolCall[];
      name?: string;
    }
  | { id: string; role: 'tool'; content: string; toolCallId: string };

/** Frontend-declared tool (sent as `tools` in `RunAgentInput`). */
export interface AGUITool {
  name: string;
  description: string;
  /** JSON-schema describing accepted parameters. */
  parameters?: unknown;
}

/** Context entry — what `useCopilotReadable` exposes to the agent. */
export interface AGUIContextEntry {
  description: string;
  value: string;
}

/** `POST /agent/:agentId/run` body. */
export interface RunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state?: unknown;
  messages: AGUIMessage[];
  tools?: AGUITool[];
  context?: AGUIContextEntry[];
}
