// SSE / chunked-encoding helpers for the CopilotKit runtime adapter.
//
// Per P05C step 4: a tiny SSE writer with heartbeat support. CopilotKit
// runtime v2 (which we target — see `runtime.ts`'s pinned-version header)
// uses bare `data: <JSON>\n\n` event-stream frames; the AG-UI EventEncoder
// it ships does exactly that. We mirror that wire format here instead of
// pulling in `@ag-ui/encoder` so the adapter stays light + auditable.
//
// We deliberately don't use fastify's `reply.raw` directly inside the
// route handler: passing an `SseWriter` makes the route handler trivial
// to unit-test against a `Writable` stub. Heartbeats are SSE comment
// lines (`: heartbeat\n\n`) — clients ignore them but proxies see traffic
// and don't close the idle TCP connection.

/** Default cadence for heartbeat comments. Must beat common proxy idle timers (60s). */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Minimal write-side surface we need from the underlying Node response /
 * `Writable`. Modeled after `http.ServerResponse`'s `write` + `end` so
 * tests can pass a `PassThrough`.
 */
export interface SseSink {
  /**
   * Write a chunk. Returns whether the buffer is below the high-water
   * mark — callers should honour `false` by awaiting `drain`. We don't
   * actually backpressure here because the AG-UI per-event payload is
   * tiny (kilobytes at most) and the desktop adapter only fans out to
   * one phone at a time; surface the bool for future tuning.
   */
  write(chunk: string): boolean;
  end(): void;
  /** Test-only hook so the heartbeat loop can stop early when the sink ends. */
  on?(event: 'close' | 'error', listener: (err?: Error) => void): unknown;
}

/** Options accepted by `createSseWriter`. */
export interface SseWriterOptions {
  /** Override the heartbeat interval (ms). Set to `0` to disable. */
  heartbeatMs?: number;
  /** Override the heartbeat comment text. Default: `heartbeat`. */
  heartbeatComment?: string;
  /** Clock injection for deterministic tests. Defaults to `setInterval`. */
  setInterval?: (cb: () => void, ms: number) => unknown;
  /** Mirror of `setInterval` for cleanup. */
  clearInterval?: (handle: unknown) => void;
}

/** Public surface of an SSE writer. */
export interface SseWriter {
  /** Emit a JSON-encoded event as a single `data:` SSE frame. */
  event(data: unknown): void;
  /**
   * Emit a raw SSE comment line (`: <text>\n\n`). Clients ignore these;
   * useful for the heartbeat. Exposed for tests + diagnostics.
   */
  comment(text: string): void;
  /** Stop the heartbeat loop and end the underlying stream. */
  close(): void;
  /** Whether `close()` was already called — guards against double-end. */
  readonly closed: boolean;
}

/**
 * Wrap a Node `Writable` in an SSE event writer. The caller is
 * responsible for setting `Content-Type: text/event-stream` + cache
 * headers before passing the sink in (so this helper stays
 * framework-agnostic — fastify, raw `http`, even a `PassThrough` in
 * tests).
 */
export function createSseWriter(sink: SseSink, opts: SseWriterOptions = {}): SseWriter {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeatComment = opts.heartbeatComment ?? 'heartbeat';
  const intervalImpl = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearImpl = opts.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout));

  let closed = false;
  let heartbeatHandle: unknown = null;

  function safeWrite(chunk: string): void {
    if (closed) return;
    try {
      sink.write(chunk);
    } catch {
      // The peer disconnected mid-write. Mark closed so subsequent
      // events / heartbeats short-circuit.
      closed = true;
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (heartbeatHandle) {
      clearImpl(heartbeatHandle);
      heartbeatHandle = null;
    }
    try {
      sink.end();
    } catch {
      // ignore
    }
  }

  // Wire up a close-on-peer-disconnect listener if the sink supports it.
  // Fastify's `reply.raw` is an `http.ServerResponse` which emits 'close'.
  sink.on?.('close', () => {
    close();
  });
  sink.on?.('error', () => {
    close();
  });

  if (heartbeatMs > 0) {
    heartbeatHandle = intervalImpl(() => {
      if (closed) return;
      safeWrite(`: ${heartbeatComment}\n\n`);
    }, heartbeatMs);
    // Don't keep the event loop alive just for the heartbeat — Node's
    // `setInterval` returns a `Timeout` with `.unref()`. The injected
    // impl might not, hence the optional chain.
    (heartbeatHandle as { unref?: () => void } | null)?.unref?.();
  }

  return {
    event(data: unknown): void {
      // SSE spec: each line in the payload must be prefixed with `data:`.
      // We serialise the whole payload as a single JSON object so it
      // lives on one line — matches what `@ag-ui/encoder` does
      // (`data: ${JSON.stringify(event)}\n\n`).
      safeWrite(`data: ${JSON.stringify(data)}\n\n`);
    },
    comment(text: string): void {
      safeWrite(`: ${text}\n\n`);
    },
    close,
    get closed() {
      return closed;
    },
  };
}
