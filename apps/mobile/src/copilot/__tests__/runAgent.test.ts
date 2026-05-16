// `runAgent` event-pump tests.
//
// We mock `fetch` to return a fabricated SSE response and assert that
// the handler callbacks see the right sequence of AG-UI events for a
// streamed-text + tool-call run. This is the closest mocked-equivalent
// to the smoke test of "mobile talks to the desktop adapter" without
// spinning up an Electron process.

import { runAgent } from '../runAgent';
import { AGUI_EVENT_TYPE, type AGUIEvent } from '../types';

function eventLines(events: AGUIEvent[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

function fakeFetch(body: string, opts: { status?: number; headers?: Record<string, string> } = {}) {
  return jest.fn(async (_url: string, _init?: RequestInit) => {
    const encoder = new TextEncoder();
    const chunks = [encoder.encode(body)];
    const bodyShim = {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield c;
      },
    };
    const res = {
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      headers: new Headers(opts.headers ?? {}),
      body: bodyShim,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
      clone() {
        return res as unknown as Response;
      },
    } as const;
    return res as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('runAgent', () => {
  it('pumps a streamed-text + tool-call run through handlers in order', async () => {
    const events: AGUIEvent[] = [
      { type: AGUI_EVENT_TYPE.RUN_STARTED, threadId: 't1', runId: 'r1' },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'hel' },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'lo' },
      { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END, messageId: 'm1' },
      {
        type: AGUI_EVENT_TYPE.TOOL_CALL_START,
        toolCallId: 'tc1',
        toolCallName: 'echo.lookup',
        parentMessageId: 'm1',
      },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '{"a":' },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, toolCallId: 'tc1', delta: '1}' },
      { type: AGUI_EVENT_TYPE.TOOL_CALL_END, toolCallId: 'tc1' },
      { type: AGUI_EVENT_TYPE.RUN_FINISHED, threadId: 't1', runId: 'r1' },
    ];

    const runStarted: Array<{ threadId: string; runId: string }> = [];
    const runFinished: Array<{ threadId: string; runId: string }> = [];
    const messageStarts: string[] = [];
    const deltas: string[] = [];
    const messageEnds: string[] = [];
    const toolCalls: Array<{ name: string; args: string; closed: boolean }> = [];

    await runAgent({
      runtimeUrl: 'http://x:1/copilot/runtime',
      agentId: 'openclaw.default',
      token: 'tok',
      input: {
        threadId: 't1',
        runId: 'r1',
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      },
      fetchImpl: fakeFetch(eventLines(events)),
      handlers: {
        onRunStarted: (e) => runStarted.push(e),
        onRunFinished: (e) => runFinished.push({ threadId: e.threadId, runId: e.runId }),
        onMessageStart: (m) => messageStarts.push(m.id),
        onMessageDelta: (_m, d) => deltas.push(d),
        onMessageEnd: (m) => messageEnds.push(m.id),
        onToolCallEnd: (_msg, call) =>
          toolCalls.push({ name: call.name, args: call.argsBuffer, closed: call.closed }),
      },
    });

    expect(runStarted).toEqual([{ threadId: 't1', runId: 'r1' }]);
    expect(messageStarts).toEqual(['m1']);
    expect(deltas).toEqual(['hel', 'lo']);
    expect(messageEnds).toEqual(['m1']);
    expect(toolCalls).toEqual([{ name: 'echo.lookup', args: '{"a":1}', closed: true }]);
    expect(runFinished).toEqual([{ threadId: 't1', runId: 'r1' }]);
  });

  it('surfaces RUN_ERROR events via the handler instead of throwing', async () => {
    const events: AGUIEvent[] = [
      { type: AGUI_EVENT_TYPE.RUN_STARTED, threadId: 't', runId: 'r' },
      { type: AGUI_EVENT_TYPE.RUN_ERROR, message: 'agent crashed', code: 'AGENT_OOPS' },
    ];
    const errors: Array<{ message: string; code?: string }> = [];
    await runAgent({
      runtimeUrl: 'http://x:1/copilot/runtime',
      agentId: 'openclaw.default',
      token: 'tok',
      input: {
        threadId: 't',
        runId: 'r',
        messages: [{ id: 'u', role: 'user', content: 'go' }],
      },
      fetchImpl: fakeFetch(eventLines(events)),
      handlers: { onRunError: (e) => errors.push(e) },
    });
    expect(errors).toEqual([{ message: 'agent crashed', code: 'AGENT_OOPS' }]);
  });

  it('throws when the runtime returns a non-2xx status', async () => {
    await expect(
      runAgent({
        runtimeUrl: 'http://x:1/copilot/runtime',
        agentId: 'openclaw.default',
        token: 'bad',
        input: {
          threadId: 't',
          runId: 'r',
          messages: [{ id: 'u', role: 'user', content: 'hi' }],
        },
        fetchImpl: fakeFetch(JSON.stringify({ error: 'invalid token' }), { status: 401 }),
      }),
    ).rejects.toThrow(/401.*invalid token/);
  });

  it('builds the correct request URL + auth header', async () => {
    const fetchSpy = fakeFetch(eventLines([]));
    await runAgent({
      runtimeUrl: 'http://192.168.1.42:18789/copilot/runtime',
      agentId: 'openclaw.default',
      token: 'tok_123',
      input: { threadId: 't', runId: 'r', messages: [{ id: 'u', role: 'user', content: 'hi' }] },
      fetchImpl: fetchSpy,
    });
    const [url, init] = (fetchSpy as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('http://192.168.1.42:18789/copilot/runtime/agent/openclaw.default/run');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok_123',
      'Content-Type': 'application/json',
    });
  });
});
