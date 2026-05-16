// React hook that drives a single CopilotKit run from the chat screen.
//
// Wraps `runAgent(...)` with React state so the chat surface renders
// streamed assistant text + tool calls without each render manually
// massaging the aggregator. Behaviour:
//
//   - `send(userText)` posts a new user message + kicks off a run.
//   - While the run is in flight, `streaming` is the latest assistant
//     message (text + tool calls). `messages` holds the closed history.
//   - On run end we flush the streaming message into `messages` and
//     clear `streaming`.
//   - Errors (HTTP + RUN_ERROR) land in `error`. The user can `send`
//     again — the error doesn't latch.
//
// This intentionally keeps a flat "history of completed turns" model
// instead of trying to reconcile with `streamThread` from the gateway.
// The CopilotKit runtime owns conversation state inside its own thread
// id; we just mirror what comes back over SSE.

import { useCallback, useRef, useState } from 'react';

import { useCopilotKit } from './CopilotKitProvider';
import { newRunId, newUserMessageId, runAgent, type AggregatedAssistantMessage } from './runAgent';
import type { AGUIMessage, RunAgentInput } from './types';

/** A finished chat turn — either a user or assistant message. */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Tool calls observed on this turn (assistant turns only). */
  toolCalls: ReadonlyArray<{
    id: string;
    name: string;
    args: string;
    closed: boolean;
  }>;
}

/** Hook return shape. */
export interface UseChatRun {
  messages: ChatTurn[];
  /** The currently-streaming assistant turn, if any. */
  streaming: ChatTurn | null;
  /** Whether a run is in flight. */
  isRunning: boolean;
  /** Last error message — null on success. */
  error: string | null;
  /** Submit a new user message and start a run. */
  send: (text: string) => Promise<void>;
  /** Reset the entire conversation history. */
  reset: () => void;
}

/** Snapshot an `AggregatedAssistantMessage` into the lighter `ChatTurn` shape. */
function snapshotAssistant(msg: AggregatedAssistantMessage): ChatTurn {
  return {
    id: msg.id,
    role: 'assistant',
    text: msg.content,
    toolCalls: msg.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      args: c.argsBuffer,
      closed: c.closed,
    })),
  };
}

/**
 * Drive the chat surface for a single thread id. The hook reads the
 * runtime URL / token / active agent from `useCopilotKit()` so screens
 * stay declarative.
 */
export function useChatRun(threadId: string): UseChatRun {
  const ctx = useCopilotKit();
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState<ChatTurn | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hold the latest aggregator so we can snapshot it on RUN_FINISHED
  // without re-reading via React state.
  const latestRef = useRef<AggregatedAssistantMessage | null>(null);

  // Stash the history in a ref so we can read it inside the run handlers
  // (those callbacks fire faster than React state catches up).
  const historyRef = useRef<ChatTurn[]>([]);
  historyRef.current = messages;

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed || isRunning) return;
      setError(null);
      // Build the local user turn and add it to history immediately.
      const userTurn: ChatTurn = {
        id: newUserMessageId(),
        role: 'user',
        text: trimmed,
        toolCalls: [],
      };
      const nextHistory = [...historyRef.current, userTurn];
      setMessages(nextHistory);
      historyRef.current = nextHistory;
      latestRef.current = null;
      setStreaming(null);
      setIsRunning(true);

      // Compose the AG-UI message history. The runtime adapter cares
      // about user/assistant pairs; tool-result messages would go here
      // once #27 lands. For now we send a flat conversation.
      const aguiMessages: AGUIMessage[] = nextHistory.map((turn) =>
        turn.role === 'user'
          ? { id: turn.id, role: 'user', content: turn.text }
          : { id: turn.id, role: 'assistant', content: turn.text },
      );

      const input: RunAgentInput = {
        threadId,
        runId: newRunId(),
        messages: aguiMessages,
        ...(ctx.tools.length > 0 ? { tools: ctx.tools } : {}),
        ...(ctx.context.length > 0 ? { context: ctx.context } : {}),
      };

      try {
        await runAgent({
          runtimeUrl: ctx.runtimeUrl,
          agentId: ctx.activeAgent,
          token: ctx.token,
          input,
          handlers: {
            onMessageStart: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onMessageDelta: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onMessageEnd: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onToolCall: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onToolCallArgs: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onToolCallEnd: (msg) => {
              latestRef.current = msg;
              setStreaming(snapshotAssistant(msg));
            },
            onRunError: (e) => {
              setError(e.code ? `${e.code}: ${e.message}` : e.message);
            },
            onRunFinished: () => {
              const final = latestRef.current;
              if (final) {
                const snapped = snapshotAssistant(final);
                const newHistory = [...historyRef.current, snapped];
                setMessages(newHistory);
                historyRef.current = newHistory;
              }
              setStreaming(null);
              latestRef.current = null;
            },
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Run failed');
      } finally {
        setIsRunning(false);
      }
    },
    [ctx, isRunning, threadId],
  );

  const reset = useCallback((): void => {
    setMessages([]);
    setStreaming(null);
    setError(null);
    setIsRunning(false);
    latestRef.current = null;
  }, []);

  return { messages, streaming, isRunning, error, send, reset };
}
