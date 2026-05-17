// Unit tests for the SSE writer.

import { describe, expect, it, vi } from 'vitest';
import { createSseWriter, type SseSink } from '../stream';

function buildSink() {
  const chunks: string[] = [];
  let ended = false;
  const listeners: Record<string, ((err?: Error) => void) | undefined> = {};
  const sink: SseSink = {
    write(chunk) {
      chunks.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
    on(event, listener) {
      listeners[event] = listener;
      return sink;
    },
  };
  return {
    sink,
    chunks,
    isEnded: () => ended,
    fire(event: 'close' | 'error', err?: Error) {
      listeners[event]?.(err);
    },
  };
}

describe('createSseWriter', () => {
  it('writes events as `data: <json>\\n\\n`', () => {
    const h = buildSink();
    const w = createSseWriter(h.sink, { heartbeatMs: 0 });
    w.event({ type: 'RUN_STARTED', threadId: 't', runId: 'r' });
    expect(h.chunks).toEqual(['data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n']);
  });

  it('writes comment lines for heartbeat', () => {
    const h = buildSink();
    const w = createSseWriter(h.sink, { heartbeatMs: 0 });
    w.comment('hb');
    expect(h.chunks).toEqual([': hb\n\n']);
  });

  it('fires heartbeat on the injected interval and stops on close', () => {
    const h = buildSink();
    const captured: { cb: (() => void) | null } = { cb: null };
    const fakeInterval = vi.fn((cb: () => void) => {
      captured.cb = cb;
      return 'handle';
    });
    const fakeClear = vi.fn();
    const w = createSseWriter(h.sink, {
      heartbeatMs: 10,
      setInterval: fakeInterval,
      clearInterval: fakeClear,
    });
    expect(fakeInterval).toHaveBeenCalledOnce();
    // Fire the heartbeat once.
    captured.cb?.();
    expect(h.chunks).toEqual([': heartbeat\n\n']);
    w.close();
    expect(fakeClear).toHaveBeenCalledWith('handle');
    expect(h.isEnded()).toBe(true);
    // After close, subsequent heartbeat callbacks are no-ops.
    captured.cb?.();
    expect(h.chunks).toEqual([': heartbeat\n\n']);
  });

  it('marks closed once and end() is idempotent', () => {
    const h = buildSink();
    const w = createSseWriter(h.sink, { heartbeatMs: 0 });
    expect(w.closed).toBe(false);
    w.close();
    expect(w.closed).toBe(true);
    w.close();
    expect(w.closed).toBe(true);
  });

  it('closes when the underlying sink emits "close"', () => {
    const h = buildSink();
    const w = createSseWriter(h.sink, { heartbeatMs: 0 });
    h.fire('close');
    expect(w.closed).toBe(true);
  });

  it('swallows write errors and flips to closed', () => {
    const sink: SseSink = {
      write() {
        throw new Error('peer gone');
      },
      end() {
        // ignore
      },
    };
    const w = createSseWriter(sink, { heartbeatMs: 0 });
    w.event({ foo: 'bar' });
    expect(w.closed).toBe(true);
  });
});
