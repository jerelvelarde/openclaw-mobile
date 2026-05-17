// Adapter unit tests.
//
// Exercises the gateway-side translation:
//   - One CopilotKit `run` request emits one `threads.post` publish.
//   - Streamed `threads.event` frames translate to AG-UI SSE events.
//   - A gateway error event translates to a `RUN_ERROR` chunk.
//   - Tool-call events round-trip to AG-UI TOOL_CALL_* triples.
//
// We don't need the real router for these; a minimal fake matches the
// `Router` interface and records publishes / dispatches.

import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openclaw/protocol';
import type {
  Broadcaster,
  HandlerContext,
  InboundFrame,
  Router,
  TopicHandler,
} from '../../transport/router';
import { runAdapter } from '../adapter';
import { type RunAgentInput } from '../agui-types';
import { createSseWriter, type SseSink } from '../stream';

function buildFakeRouter() {
  const handlers = new Map<string, Set<TopicHandler>>();
  let _bc: Broadcaster | null = null;
  /** Frames the adapter pushed into the router via `dispatchRaw`. */
  const dispatched: Array<{ raw: string; ctx: { deviceId: string } }> = [];
  const router: Router = {
    subscribe(topic, handler) {
      let s = handlers.get(topic);
      if (!s) {
        s = new Set();
        handlers.set(topic, s);
      }
      s.add(handler);
      return () => {
        s!.delete(handler);
      };
    },
    publish(topic, type, payload, overrides) {
      const frame: InboundFrame = {
        id: overrides?.id ?? 'pub-id',
        topic,
        type,
        payload,
        ts: overrides?.ts ?? 0,
      };
      _bc?.(frame, overrides?.target);
      return frame;
    },
    dispatchRaw(raw, ctx) {
      dispatched.push({ raw, ctx });
      return null;
    },
    setBroadcaster(fn) {
      _bc = fn;
    },
    onOutbound() {
      // Not exercised by the adapter; return a no-op unsubscribe.
      return (): void => {
        // ignore
      };
    },
    _topics() {
      return [...handlers.keys()];
    },
  };

  function emitThreadEvent(deviceId: string, event: ThreadEvent): void {
    const frame: InboundFrame = {
      id: 'gw-frame',
      topic: 'threads.event',
      type: 'threads.event',
      payload: event,
      ts: 1,
    };
    const ctx: HandlerContext = {
      deviceId,
      reply: () => {
        // not used by the adapter; the adapter never replies, it only
        // subscribes + writes SSE.
      },
    };
    for (const [sub, set] of handlers) {
      if (sub === 'threads.event' || 'threads.event'.startsWith(`${sub}.`)) {
        for (const h of set) {
          void h(frame, ctx);
        }
      }
    }
  }

  function emitErrorEvent(deviceId: string, topic: string, payload: unknown): void {
    const frame: InboundFrame = {
      id: 'err-frame',
      topic,
      type: topic,
      payload,
      ts: 1,
    };
    const ctx: HandlerContext = { deviceId, reply: () => {} };
    for (const [sub, set] of handlers) {
      if (sub === topic) {
        for (const h of set) {
          void h(frame, ctx);
        }
      }
    }
  }

  return { router, dispatched, emitThreadEvent, emitErrorEvent };
}

function buildCaptureSink() {
  const events: unknown[] = [];
  const sink: SseSink = {
    write(chunk) {
      // Parse `data: <json>\n\n` back to the original object.
      const m = /^data: (.*)\n\n$/s.exec(chunk);
      if (m && m[1]) {
        events.push(JSON.parse(m[1]));
      }
      return true;
    },
    end() {
      // no-op
    },
  };
  return { sink, events };
}

function baseInput(content: string): RunAgentInput {
  return {
    threadId: 't1',
    runId: 'r1',
    messages: [{ id: 'u1', role: 'user', content }],
  };
}

describe('runAdapter', () => {
  it('dispatches a threads.post envelope and translates the streamed reply', async () => {
    const { router, dispatched, emitThreadEvent } = buildFakeRouter();
    const { sink, events } = buildCaptureSink();
    const writer = createSseWriter(sink, { heartbeatMs: 0 });
    const done = runAdapter({
      router,
      input: baseInput('hello'),
      agentId: 'openclaw.default',
      deviceId: 'device-1',
      writer,
      timeoutMs: 1000,
    });
    // Allow the adapter to subscribe + dispatch.
    await new Promise<void>((r) => queueMicrotask(r));

    // Exactly one threads.post dispatch scoped to the calling device,
    // payload mirrors what the stub gateway's `threads.post` reads.
    expect(dispatched).toHaveLength(1);
    const [dispatch] = dispatched;
    expect(dispatch?.ctx.deviceId).toBe('device-1');
    const envelope = JSON.parse(dispatch!.raw) as {
      topic: string;
      type: string;
      payload: { threadId: string; content: string; agentId: string };
    };
    expect(envelope.topic).toBe('threads.post');
    expect(envelope.type).toBe('threads.post');
    expect(envelope.payload).toEqual({
      threadId: 't1',
      content: 'hello',
      agentId: 'openclaw.default',
    });

    // Simulate the stub gateway's reply sequence.
    emitThreadEvent('device-1', {
      type: 'message',
      message: { id: 'mu', threadId: 't1', role: 'user', content: 'hello', createdAt: 1 },
    });
    emitThreadEvent('device-1', {
      type: 'message',
      message: {
        id: 'ma',
        threadId: 't1',
        role: 'assistant',
        content: 'Echo: hello',
        createdAt: 2,
      },
    });
    emitThreadEvent('device-1', {
      type: 'token',
      messageId: 'ma',
      delta: 'Echo: hello',
    });
    emitThreadEvent('device-1', {
      type: 'tool_call',
      messageId: 'ma',
      toolName: 'echo.lookup',
      args: { input: 'hello' },
    });
    emitThreadEvent('device-1', { type: 'done', messageId: 'ma' });
    await done;

    // Inspect the AG-UI event sequence.
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual([
      'RUN_STARTED',
      // user-message ack was filtered out
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT', // from assistant message body
      'TEXT_MESSAGE_CONTENT', // from token delta
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);

    // Spot-check shapes.
    const tokenContent = events[3] as { delta: string; messageId: string };
    expect(tokenContent.delta).toBe('Echo: hello');
    expect(tokenContent.messageId).toMatch(/^msg_/);

    const toolStart = events[4] as {
      toolCallName: string;
      toolCallId: string;
      parentMessageId: string;
    };
    expect(toolStart.toolCallName).toBe('echo.lookup');
    expect(toolStart.toolCallId).toMatch(/^tc_/);

    const toolArgs = events[5] as { delta: string };
    expect(JSON.parse(toolArgs.delta)).toEqual({ input: 'hello' });
  });

  it('scopes deliveries by deviceId — other devices do not leak', async () => {
    const { router, emitThreadEvent } = buildFakeRouter();
    const { sink, events } = buildCaptureSink();
    const writer = createSseWriter(sink, { heartbeatMs: 0 });
    const done = runAdapter({
      router,
      input: baseInput('hi'),
      agentId: 'a',
      deviceId: 'device-A',
      writer,
      timeoutMs: 1000,
    });
    await new Promise<void>((r) => queueMicrotask(r));

    // Cross-device frame: should be ignored.
    emitThreadEvent('device-B', {
      type: 'message',
      message: { id: 'm', threadId: 't1', role: 'assistant', content: 'pwn', createdAt: 0 },
    });
    emitThreadEvent('device-A', { type: 'done', messageId: 'm' });
    await done;

    const types = events.map((e) => (e as { type: string }).type);
    // No TEXT_MESSAGE_START/CONTENT from the cross-device frame.
    expect(types).toEqual(['RUN_STARTED', 'RUN_FINISHED']);
  });

  it('emits RUN_ERROR when the gateway publishes an error envelope', async () => {
    const { router, emitErrorEvent } = buildFakeRouter();
    const { sink, events } = buildCaptureSink();
    const writer = createSseWriter(sink, { heartbeatMs: 0 });
    const done = runAdapter({
      router,
      input: baseInput('boom'),
      agentId: 'a',
      deviceId: 'd',
      writer,
      timeoutMs: 1000,
    });
    await new Promise<void>((r) => queueMicrotask(r));
    emitErrorEvent('d', 'threads.error', { message: 'gateway exploded', code: 'E_BOOM' });
    await done;

    const last = events[events.length - 1] as {
      type: string;
      message?: string;
      code?: string;
    };
    expect(last.type).toBe('RUN_ERROR');
    expect(last.message).toBe('gateway exploded');
    expect(last.code).toBe('E_BOOM');
  });

  it('emits RUN_ERROR with a `timeout` code when the gateway never replies', async () => {
    const { router } = buildFakeRouter();
    const { sink, events } = buildCaptureSink();
    const writer = createSseWriter(sink, { heartbeatMs: 0 });

    // Use a synchronous fake setTimeout that fires immediately.
    const captured: { cb: (() => void) | null } = { cb: null };
    const fakeSetTimeout = (cb: () => void): unknown => {
      captured.cb = cb;
      return 'handle';
    };
    const fakeClearTimeout = (): void => {};
    const done = runAdapter({
      router,
      input: baseInput('quiet'),
      agentId: 'a',
      deviceId: 'd',
      writer,
      timeoutMs: 1,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
    });
    await new Promise<void>((r) => queueMicrotask(r));
    captured.cb?.();
    await done;

    const last = events[events.length - 1] as { type: string; code: string };
    expect(last.type).toBe('RUN_ERROR');
    expect(last.code).toBe('timeout');
  });

  it('emits RUN_ERROR when the request signal aborts', async () => {
    const { router } = buildFakeRouter();
    const { sink, events } = buildCaptureSink();
    const writer = createSseWriter(sink, { heartbeatMs: 0 });
    const controller = new AbortController();
    const done = runAdapter({
      router,
      input: baseInput('abort me'),
      agentId: 'a',
      deviceId: 'd',
      writer,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await new Promise<void>((r) => queueMicrotask(r));
    controller.abort();
    await done;

    const last = events[events.length - 1] as { type: string; code: string };
    expect(last.type).toBe('RUN_ERROR');
    expect(last.code).toBe('aborted');
  });
});
