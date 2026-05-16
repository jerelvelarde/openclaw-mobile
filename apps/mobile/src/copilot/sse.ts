// Minimal Server-Sent Events parser for AG-UI's `data: <json>\n\n` frames.
//
// The desktop adapter emits each AG-UI event as one `data: <JSON>\n\n`
// frame — that's the exact wire shape `@copilotkit/runtime@1.57.1` uses
// (see `apps/desktop/src/main/copilot/runtime.ts`'s header). We
// deliberately do NOT implement the full SSE spec (no `event:`, `id:`,
// `retry:` lines, no multi-line `data:`) because the AG-UI encoder
// doesn't emit them. If/when it does, expand `parseSseChunk` below.
//
// The streamer is split in two:
//
//   1. `parseSseChunk` — synchronous, takes a buffer string + appends new
//      bytes, returns extracted events + the remaining buffer tail. Pure
//      and unit-testable.
//   2. `readSseFromResponse` — async generator wrapping `Response.body`'s
//      `ReadableStream` reader. Yields parsed `AGUIEvent`s until the
//      stream ends or the caller aborts.
//
// We rely on `Response.body` being a `ReadableStream<Uint8Array>`. That's
// true under Node 22+ (the desktop adapter test path), Expo SDK 54 RN
// (via the JSC + Hermes WHATWG fetch shim), and modern browsers. If a
// runtime returns `null` (older RN, web w/o streams), we fall back to
// `Response.text()` and parse the full body once — useful only for
// extremely short runs but keeps the code working in degraded modes.

import type { AGUIEvent } from './types';

/** A parsed SSE frame; we keep `raw` around for diagnostics. */
export interface ParsedSseFrame {
  /** Parsed `data:` payload. Always JSON in our wire format. */
  event: AGUIEvent;
  /** The exact JSON string we deserialized — useful for error reporting. */
  raw: string;
}

/** Result of running the synchronous chunk parser. */
export interface ParseSseResult {
  events: ParsedSseFrame[];
  /** Leftover bytes that didn't form a complete frame. */
  remainder: string;
  /**
   * Frames that failed JSON parsing. We don't throw on a single bad
   * frame — the desktop might emit a debug line at some point — but
   * surface them so the caller can decide to log/abort.
   */
  malformed: string[];
}

/**
 * Append `chunk` to `buffer`, then split out every complete SSE frame
 * (terminated by `\n\n`). Returns the parsed events + the unprocessed
 * tail. Caller threads the tail into the next call.
 */
export function parseSseChunk(buffer: string, chunk: string): ParseSseResult {
  const combined = buffer + chunk;
  const events: ParsedSseFrame[] = [];
  const malformed: string[] = [];

  let cursor = 0;
  for (;;) {
    const boundary = combined.indexOf('\n\n', cursor);
    if (boundary === -1) break;
    const frame = combined.slice(cursor, boundary);
    cursor = boundary + 2;

    // A frame can contain multiple lines; we only care about the data lines.
    // AG-UI emits exactly one `data: …` line per frame, but we still scan
    // for safety so a future `event:` / `id:` line doesn't break parsing.
    const lines = frame.split('\n');
    const dataParts: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        // The spec says one optional space after the colon — strip it.
        const part = line.slice(5).replace(/^ /, '');
        dataParts.push(part);
      }
      // We intentionally ignore comments (lines starting with ":"),
      // `event:`, `id:`, `retry:` — none are used by our adapter today.
    }
    if (dataParts.length === 0) continue;
    const data = dataParts.join('\n');
    try {
      const parsed = JSON.parse(data) as AGUIEvent;
      events.push({ event: parsed, raw: data });
    } catch {
      malformed.push(data);
    }
  }

  return { events, remainder: combined.slice(cursor), malformed };
}

/** Options for `readSseFromResponse`. Tests use them to inject doubles. */
export interface ReadSseOptions {
  /** Per-frame callback. Lets the caller pull events as they arrive. */
  onEvent: (frame: ParsedSseFrame) => void;
  /** Called once per malformed frame. Default is to `console.warn`. */
  onMalformed?: (raw: string) => void;
  /** Abort signal — cancel the read mid-stream. */
  signal?: AbortSignal;
  /**
   * Override the response body reader. Production paths use the
   * `ReadableStream` exposed by `Response.body`; tests pass a fake that
   * yields chunks synchronously.
   */
  readerFactory?: (res: Response) => AsyncIterable<string>;
}

/**
 * Decode a `ReadableStream<Uint8Array>` into a string-yielding async
 * iterator. We use a `TextDecoder` for proper UTF-8 chunk handling — a
 * multi-byte character can span the boundary between two `enqueue()`
 * calls, so naive `String.fromCharCode` would corrupt it.
 */
async function* defaultReader(res: Response): AsyncIterable<string> {
  const body = res.body;
  if (!body) {
    // Degraded path: no stream available. Fall back to one-shot text.
    const text = await res.text();
    if (text) yield text;
    return;
  }
  // Some RN runtimes expose `body` as a Node-style async iterable rather
  // than a WHATWG ReadableStream. Handle both.
  const asyncIter = (body as { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array> })[
    Symbol.asyncIterator
  ];
  const decoder = new TextDecoder('utf-8');
  if (typeof asyncIter === 'function') {
    for await (const piece of body as unknown as AsyncIterable<Uint8Array>) {
      yield decoder.decode(piece, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/**
 * Pump SSE events out of an HTTP response. Each event is delivered via
 * `opts.onEvent` in order. Resolves when the stream ends; rejects if the
 * abort signal fires or the underlying reader throws.
 */
export async function readSseFromResponse(res: Response, opts: ReadSseOptions): Promise<void> {
  const reader = opts.readerFactory ? opts.readerFactory(res) : defaultReader(res);
  const onMalformed =
    opts.onMalformed ??
    ((raw: string) => {
      // eslint-disable-next-line no-console
      console.warn('[openclaw/copilot] malformed SSE frame:', raw);
    });

  let buffer = '';
  for await (const chunk of reader) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason instanceof Error
        ? opts.signal.reason
        : new Error('SSE read aborted');
    }
    const result = parseSseChunk(buffer, chunk);
    buffer = result.remainder;
    for (const m of result.malformed) onMalformed(m);
    for (const e of result.events) opts.onEvent(e);
  }
  // Flush any remaining complete frame in the buffer. The adapter ends
  // every run with a `RUN_FINISHED` frame followed by `\n\n`, so this
  // path normally doesn't fire — but a half-flushed buffer shouldn't
  // silently drop the last event either.
  if (buffer.length > 0) {
    const result = parseSseChunk(buffer, '\n\n');
    for (const m of result.malformed) onMalformed(m);
    for (const e of result.events) opts.onEvent(e);
  }
}
