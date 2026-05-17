// E2E driver — pure scenario logic for the clawg-ui pair → chat flow
// (P11E).
//
// Lives outside `apps/*` so it can be invoked directly by `node
// --experimental-strip-types` from CI or the local runbook. It does
// NOT import any workspace code on purpose: the contract under test is
// the HTTP/SSE wire shape exposed by `vendor/clawg-ui/` against a real
// `openclaw gateway` daemon, not whatever helpers our desktop client
// happens to use. The desktop's `apps/desktop/src/main/clawg-ui/client.ts`
// implements the same wire shape; if it ever drifts, this harness will
// catch it independently.
//
// The driver is parameterised by:
//   - `baseUrl` — the gateway base URL (e.g. `http://localhost:18789`).
//   - `approve(pairingCode)` — opaque callback. In real Docker mode
//     this shells out via `docker exec <container> openclaw pairing
//     approve clawg-ui <code>` (the same command we wrap in
//     `apps/desktop/src/main/clawg-ui/cli.ts`); in mock mode it just
//     flips a flag inside the mock server.
//
// The scenario, in steps:
//   1. POST `<baseUrl>/v1/clawg-ui` with `{}` and no Authorization.
//      Expect HTTP 403 with `{ error: { type: "pairing_pending",
//      pairing: { pairingCode, token } } }`. Capture both.
//   2. Invoke `approve(pairingCode)`. Expect ok.
//   3. POST the same endpoint with `Authorization: Bearer <token>`,
//      `Content-Type: application/json`, `Accept: text/event-stream`,
//      `X-OpenClaw-Agent-Id: main`, and a minimal `RunAgentInput`
//      containing one `user` message. Expect a 200 SSE stream.
//   4. Parse each `data:` JSON frame. Assert the event-type sequence
//      contains, in order: `RUN_STARTED` → `TEXT_MESSAGE_START` → at
//      least one `TEXT_MESSAGE_CONTENT` → `TEXT_MESSAGE_END` →
//      `RUN_FINISHED`. Extra events (e.g. tool-call lifecycle, raw
//      heartbeats) are tolerated as long as the ordering holds.
//
// The driver returns a structured report — pass/fail per assertion
// plus the full event log — so the caller can emit JSON without making
// assertion decisions here.

export interface ApproveResult {
  ok: boolean;
  /** Optional human-readable detail; surfaced in the report on failure. */
  detail?: string;
}

export type ApproveFn = (pairingCode: string) => Promise<ApproveResult>;

export interface DriverOptions {
  /** Gateway base URL, e.g. `http://localhost:18789`. */
  baseUrl: string;
  /** Approve hook — see file header. */
  approve: ApproveFn;
  /** Inject `fetch` for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Optional user prompt to send. Defaults to `"hello"`; agent backends
   * that echo the input give us deterministic content to assert on
   * without needing an LLM. The driver doesn't assert on the response
   * text — just on the event sequence — so the value is mostly a
   * diagnostic affordance.
   */
  prompt?: string;
  /** Optional thread id; defaults to `"e2e-thread"`. */
  threadId?: string;
  /** Optional run id; defaults to `"e2e-run"`. */
  runId?: string;
  /**
   * Overall budget for the whole scenario. We don't enforce a per-step
   * timeout because docker-compose health gating already pre-stages the
   * gateway; a single ceiling keeps the harness tight without nested
   * timers.
   */
  totalTimeoutMs?: number;
}

/** Single assertion outcome inside the report. */
export interface AssertionResult {
  name: string;
  passed: boolean;
  detail?: string;
}

/** Compact log entry of every SSE event the driver observed. */
export interface SseEventEntry {
  type: string;
  /** Wall-clock offset from scenario start, in milliseconds. */
  tOffsetMs: number;
  /** Full parsed event payload (may be large; we keep it for debugging). */
  raw: unknown;
}

/** Top-level driver report. */
export interface DriverReport {
  /** ISO timestamp the run began. */
  startedAt: string;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** Resolved scenario config. */
  config: {
    baseUrl: string;
    prompt: string;
    threadId: string;
    runId: string;
  };
  /** Captured pairing-code (omitted if step 1 failed). */
  pairingCode?: string;
  /** SSE events observed during step 4. */
  events: SseEventEntry[];
  /** One entry per assertion, in chronological order. */
  assertions: AssertionResult[];
  /** Convenience: true iff every assertion passed. */
  passed: boolean;
}

interface PairingPendingResponse {
  pairing_code?: unknown;
  bearer_token?: unknown;
  error?: {
    type?: unknown;
    pairing?: {
      pairingCode?: unknown;
      token?: unknown;
    };
  };
}

interface ExtractedPairing {
  pairingCode: string;
  token: string;
}

function extractPairing(body: unknown): ExtractedPairing | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as PairingPendingResponse;
  if (b.error?.type !== 'pairing_pending') return null;
  const pairing = b.error?.pairing;
  const pairingCode =
    (pairing && typeof pairing.pairingCode === 'string' && pairing.pairingCode) ||
    (typeof b.pairing_code === 'string' && b.pairing_code) ||
    null;
  const token =
    (pairing && typeof pairing.token === 'string' && pairing.token) ||
    (typeof b.bearer_token === 'string' && b.bearer_token) ||
    null;
  if (!pairingCode || !token) return null;
  return { pairingCode, token };
}

/**
 * Run the scripted pair → approve → chat scenario against `baseUrl`.
 * Never throws — every failure mode is recorded in the returned report
 * so the calling script can decide how to surface it (JSON file, exit
 * code, etc.).
 */
export async function runScenario(opts: DriverOptions): Promise<DriverReport> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const prompt = opts.prompt ?? 'hello';
  const threadId = opts.threadId ?? 'e2e-thread';
  const runId = opts.runId ?? 'e2e-run';
  const totalTimeoutMs = opts.totalTimeoutMs ?? 30_000;

  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const events: SseEventEntry[] = [];
  const assertions: AssertionResult[] = [];
  let pairingCode: string | undefined;

  function record(name: string, passed: boolean, detail?: string): void {
    const a: AssertionResult = { name, passed };
    if (detail !== undefined) a.detail = detail;
    assertions.push(a);
  }

  function finalize(): DriverReport {
    const report: DriverReport = {
      startedAt,
      durationMs: Date.now() - t0,
      config: { baseUrl: opts.baseUrl, prompt, threadId, runId },
      events,
      assertions,
      passed: assertions.every((a) => a.passed),
    };
    if (pairingCode !== undefined) report.pairingCode = pairingCode;
    return report;
  }

  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), totalTimeoutMs);

  try {
    // ----- Step 1: unauthenticated POST → 403 pairing_pending -----------
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/clawg-ui`;
    let pairingToken: string | undefined;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: overallController.signal,
      });
      record(
        'step1.status-403',
        res.status === 403,
        res.status === 403 ? undefined : `got HTTP ${res.status}`,
      );
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        record('step1.body-json', false, `non-JSON body: ${text.slice(0, 200)}`);
        return finalize();
      }
      record('step1.body-json', true);
      const pending = extractPairing(parsed);
      if (!pending) {
        record(
          'step1.pairing-shape',
          false,
          `expected error.type=pairing_pending with pairingCode + token, got: ${text.slice(0, 200)}`,
        );
        return finalize();
      }
      record('step1.pairing-shape', true);
      pairingCode = pending.pairingCode;
      pairingToken = pending.token;
    } catch (err) {
      record('step1.fetch', false, (err as Error).message);
      return finalize();
    }

    // ----- Step 2: approve the pairing code ----------------------------
    try {
      const approveRes = await opts.approve(pairingCode!);
      record('step2.approve', approveRes.ok, approveRes.detail);
      if (!approveRes.ok) return finalize();
    } catch (err) {
      record('step2.approve', false, (err as Error).message);
      return finalize();
    }

    // ----- Step 3: authenticated POST → 200 SSE ------------------------
    let sseRes: Response;
    try {
      const body = {
        threadId,
        runId,
        messages: [{ role: 'user', content: prompt }],
      };
      sseRes = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${pairingToken!}`,
          'X-OpenClaw-Agent-Id': 'main',
        },
        body: JSON.stringify(body),
        signal: overallController.signal,
      });
    } catch (err) {
      record('step3.fetch', false, (err as Error).message);
      return finalize();
    }
    record(
      'step3.status-200',
      sseRes.status === 200,
      sseRes.status === 200 ? undefined : `got HTTP ${sseRes.status}`,
    );
    if (sseRes.status !== 200) {
      // Drain to surface a hint in the report.
      try {
        const txt = await sseRes.text();
        record('step3.body', false, `non-200 body: ${txt.slice(0, 200)}`);
      } catch {
        /* ignore */
      }
      return finalize();
    }
    const ct = sseRes.headers.get('content-type') ?? '';
    record(
      'step3.content-type',
      ct.includes('text/event-stream'),
      ct ? `content-type: ${ct}` : 'missing content-type',
    );

    // ----- Step 4: consume the stream ----------------------------------
    try {
      await consumeSse(sseRes, (event) => {
        const typeVal =
          event &&
          typeof event === 'object' &&
          typeof (event as { type?: unknown }).type === 'string'
            ? (event as { type: string }).type
            : '<unknown>';
        events.push({ type: typeVal, tOffsetMs: Date.now() - t0, raw: event });
      });
    } catch (err) {
      record('step4.consume-sse', false, (err as Error).message);
      // Still fall through to the ordering assertions in case we got
      // partial events.
    }

    // Ordering check: the *types* we care about must appear in order.
    // We collect indices into `events` and verify they're monotonically
    // increasing. Other events (heartbeats, tool calls) are tolerated.
    const sequence = [
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ];
    const indices: Record<string, number> = {};
    let cursor = 0;
    for (const target of sequence) {
      const found = events.findIndex((e, i) => i >= cursor && e.type === target);
      indices[target] = found;
      if (found >= 0) cursor = found + 1;
    }
    for (const target of sequence) {
      const idx = indices[target] ?? -1;
      record(
        `step4.event:${target}`,
        idx >= 0,
        idx >= 0
          ? undefined
          : `not observed in order; events seen: ${events.map((e) => e.type).join(',')}`,
      );
    }
    // Specifically require ≥1 TEXT_MESSAGE_CONTENT (the spec says
    // "≥1 chunk").
    const contentCount = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').length;
    record(
      'step4.text-content-count',
      contentCount >= 1,
      contentCount >= 1 ? `${contentCount} chunk(s)` : 'zero TEXT_MESSAGE_CONTENT events',
    );

    return finalize();
  } finally {
    clearTimeout(overallTimer);
  }
}

/**
 * Minimal SSE consumer — same shape as the desktop client's pump in
 * `apps/desktop/src/main/clawg-ui/client.ts:312–366`, but kept private
 * to the driver so we don't have to ship workspace code into the e2e
 * package boundary.
 */
async function consumeSse(res: Response, onEvent: (event: unknown) => void): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (): void => {
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          onEvent(JSON.parse(json));
        } catch {
          /* skip malformed */
        }
      }
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      buf += decoder.decode(value, { stream: true });
      flush();
    }
  }
  buf += decoder.decode();
  if (buf.length > 0) {
    buf += '\n\n';
    flush();
  }
}
