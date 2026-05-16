// SSE chunk parser tests.
//
// These are pure unit tests against `parseSseChunk` — the chunk
// boundary handling is the most likely place to break, so we exercise
// every variant of split: mid-frame, mid-line, mid-data-prefix, and
// adversarial garbage.

import { parseSseChunk, readSseFromResponse } from '../sse';
import { AGUI_EVENT_TYPE, type AGUIEvent } from '../types';

describe('parseSseChunk', () => {
  it('parses a single well-formed AG-UI frame', () => {
    const ev: AGUIEvent = {
      type: AGUI_EVENT_TYPE.RUN_STARTED,
      threadId: 't1',
      runId: 'r1',
    };
    const chunk = `data: ${JSON.stringify(ev)}\n\n`;
    const result = parseSseChunk('', chunk);
    expect(result.remainder).toBe('');
    expect(result.malformed).toEqual([]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.event).toEqual(ev);
  });

  it('keeps partial frames in the remainder until the next call', () => {
    const ev1: AGUIEvent = {
      type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START,
      messageId: 'm1',
      role: 'assistant',
    };
    const full = `data: ${JSON.stringify(ev1)}\n\n`;
    const a = full.slice(0, 10);
    const b = full.slice(10);
    const first = parseSseChunk('', a);
    expect(first.events).toHaveLength(0);
    expect(first.remainder).toBe(a);
    const second = parseSseChunk(first.remainder, b);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.event).toEqual(ev1);
  });

  it('handles multiple frames in one chunk', () => {
    const e1: AGUIEvent = {
      type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT,
      messageId: 'm1',
      delta: 'hello',
    };
    const e2: AGUIEvent = {
      type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END,
      messageId: 'm1',
    };
    const chunk = `data: ${JSON.stringify(e1)}\n\ndata: ${JSON.stringify(e2)}\n\n`;
    const r = parseSseChunk('', chunk);
    expect(r.events).toHaveLength(2);
    expect(r.events[0]!.event).toEqual(e1);
    expect(r.events[1]!.event).toEqual(e2);
  });

  it('strips an optional leading space after `data:`', () => {
    const ev: AGUIEvent = {
      type: AGUI_EVENT_TYPE.RUN_FINISHED,
      threadId: 't',
      runId: 'r',
    };
    // No leading space after the colon — still parseable.
    const chunk = `data:${JSON.stringify(ev)}\n\n`;
    const r = parseSseChunk('', chunk);
    expect(r.events).toHaveLength(1);
  });

  it('records malformed frames without throwing', () => {
    const chunk = `data: {not-json\n\n`;
    const r = parseSseChunk('', chunk);
    expect(r.events).toHaveLength(0);
    expect(r.malformed).toEqual(['{not-json']);
  });

  it('ignores non-data lines inside a frame', () => {
    const ev: AGUIEvent = {
      type: AGUI_EVENT_TYPE.TOOL_CALL_START,
      toolCallId: 'tc1',
      toolCallName: 'echo',
    };
    const chunk = `event: tool\nid: 42\ndata: ${JSON.stringify(ev)}\n: a comment line\n\n`;
    const r = parseSseChunk('', chunk);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.event).toEqual(ev);
  });
});

describe('readSseFromResponse', () => {
  /** Build a Response-like double whose body yields the given chunks. */
  function makeResponse(chunks: string[]): Response {
    // Cast through unknown — we only set fields the function reads.
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: makeAsyncIterableBody(chunks),
      text: async () => chunks.join(''),
      clone() {
        return makeResponse([...chunks]);
      },
    } as unknown as Response;
  }
  function makeAsyncIterableBody(chunks: string[]): unknown {
    const encoder = new TextEncoder();
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const c of chunks) yield encoder.encode(c);
      },
    };
  }

  it('delivers events in order across chunked input', async () => {
    const e1: AGUIEvent = { type: AGUI_EVENT_TYPE.RUN_STARTED, threadId: 't', runId: 'r' };
    const e2: AGUIEvent = {
      type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START,
      messageId: 'm',
      role: 'assistant',
    };
    const e3: AGUIEvent = {
      type: AGUI_EVENT_TYPE.RUN_FINISHED,
      threadId: 't',
      runId: 'r',
    };
    const sse = [
      `data: ${JSON.stringify(e1)}\n`,
      `\ndata: ${JSON.stringify(e2)}\n\n`,
      `data: ${JSON.stringify(e3)}\n\n`,
    ];
    const res = makeResponse(sse);
    const got: AGUIEvent[] = [];
    await readSseFromResponse(res, { onEvent: (f) => got.push(f.event) });
    expect(got).toEqual([e1, e2, e3]);
  });
});
