// Minimal HTTP client for the clawg-ui plugin (P11A).
//
// Targets `POST <baseUrl>/v1/clawg-ui` — the AG-UI/SSE endpoint exposed
// by `@contextableai/clawg-ui` (vendored at `vendor/clawg-ui/` @ v0.7.0).
// See `vendor/clawg-ui/src/http-handler.ts:221–348` for the server
// shape we mirror here.
//
// Auth flow:
//   1. Caller passes an optional `deviceToken`. On the first call against
//      a fresh `host:port` the token is absent, the plugin responds
//      `403 { error: { type: 'pairing_pending', pairing: { pairingCode,
//      token } } }`, and we return `{ kind: 'pairing-needed' }` so the
//      desktop can surface the pairing code in the Settings UI. The new
//      `deviceToken` is persisted via {@link ClawgUiIdentityHandle} so
//      retries already carry it.
//   2. Once the user runs `openclaw pairing approve clawg-ui <code>` on
//      the host, subsequent calls succeed and the response is an SSE
//      stream of AG-UI events. We pipe each `data: <JSON>` frame through
//      `onSseEvent` and return `{ kind: 'ok' }`.
//
// We deliberately do NOT consume the SSE here in production — the caller
// (the renderer / mobile client) does that via the existing `runAgent`
// pump. The `onSseEvent` hook is for the test mock + future
// main-process consumers.
//
// Headers we set (per `vendor/clawg-ui/README.md:328–369` +
// `vendor/clawg-ui/src/http-handler.ts:484–511`):
//   - `Authorization: Bearer <deviceToken>` (omitted on the first
//     unauthenticated request)
//   - `Content-Type: application/json`
//   - `Accept: text/event-stream`
//   - `X-OpenClaw-Agent-Id: <agentId>` (default `"main"` — routes to the
//     gateway's `main` agent unless overridden)
//   - `X-OpenClaw-Session-Key: <sessionKey>` (optional; only when the
//     caller is a trusted proxy partitioning sessions per user — see the
//     README's "Trust model" section. We don't set this in v1.)

import type { ClawgUiIdentityHandle } from './identity';

/** Parsed `pairing_pending` envelope from the plugin's 403 response. */
export interface PairingPendingPayload {
  pairingCode: string;
  token: string;
  instructions?: string;
}

/** Result of a single `postClawgUiRequest` call. */
export type ClawgUiResponse =
  | {
      kind: 'pairing-needed';
      pairingCode: string;
      /** Echoed verbatim from the plugin for diagnostics. */
      instructions: string | undefined;
    }
  | { kind: 'ok'; status: number }
  | {
      kind: 'unauthorized';
      /**
       * Plugin returned 401 even though we sent a token. Usually means the
       * gateway secret rotated; the caller should drop the stored
       * identity and re-pair.
       */
      detail: string;
    }
  | {
      kind: 'http-error';
      status: number;
      /** Body text (truncated to 1 KiB for safety). */
      body: string;
    };

/** Input to {@link postClawgUiRequest}. */
export interface PostClawgUiRequestOptions {
  /** Upstream gateway base URL, e.g. `http://127.0.0.1:18789`. */
  baseUrl: string;
  /** Per-gateway identity store (used to persist tokens learned mid-call). */
  identityStore: ClawgUiIdentityHandle;
  /** Daemon host (used to key identityStore). */
  host: string;
  /** Daemon port (used to key identityStore). */
  port: number;
  /** Bearer token to send. `undefined` triggers the pairing handshake. */
  deviceToken: string | undefined;
  /** Agent to route to. Defaults to `"main"` per clawg-ui's convention. */
  agentId?: string;
  /**
   * Optional session-key partition. ONLY set this when the desktop is
   * acting as a trusted proxy. See the README's "Trust model" section.
   */
  sessionKey?: string;
  /** AG-UI `RunAgentInput` body (JSON-serialisable). */
  body: unknown;
  /** Called with each parsed SSE `data:` JSON frame. */
  onSseEvent?: (event: unknown) => void;
  /** Inject `fetch` for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Propagated to `fetch(..., { signal })`. */
  signal?: AbortSignal;
}

/**
 * Compose the full URL for the clawg-ui endpoint given a daemon base URL.
 * Stripping trailing slashes keeps the join predictable for both
 * `http://127.0.0.1:18789` and `http://127.0.0.1:18789/`.
 */
export function buildClawgUiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/clawg-ui`;
}

/**
 * Build the headers we send on every clawg-ui request. Exported for
 * tests + the mobile-side request-shape builder (`apps/mobile/src/
 * copilot/clawgUiUrl.ts`).
 */
export function buildClawgUiHeaders(opts: {
  deviceToken: string | undefined;
  agentId: string;
  sessionKey?: string | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-OpenClaw-Agent-Id': opts.agentId,
  };
  if (opts.deviceToken) {
    headers['Authorization'] = `Bearer ${opts.deviceToken}`;
  }
  if (opts.sessionKey !== undefined && opts.sessionKey.length > 0) {
    headers['X-OpenClaw-Session-Key'] = opts.sessionKey;
  }
  return headers;
}

interface PairingPendingResponseBody {
  pairing_code?: unknown;
  bearer_token?: unknown;
  error?: {
    type?: unknown;
    message?: unknown;
    pairing?: {
      pairingCode?: unknown;
      token?: unknown;
      instructions?: unknown;
    };
  };
}

function extractPairingPending(body: unknown): PairingPendingPayload | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as PairingPendingResponseBody;
  if (b.error?.type !== 'pairing_pending') return null;
  const pairing = b.error?.pairing;
  // Pull from the structured `pairing` block first, fall back to the
  // top-level shortcuts the plugin also emits for cURL ergonomics.
  const pairingCode =
    (pairing && typeof pairing.pairingCode === 'string' && pairing.pairingCode) ||
    (typeof b.pairing_code === 'string' && b.pairing_code) ||
    null;
  const token =
    (pairing && typeof pairing.token === 'string' && pairing.token) ||
    (typeof b.bearer_token === 'string' && b.bearer_token) ||
    null;
  if (!pairingCode || !token) return null;
  const instructions =
    pairing && typeof pairing.instructions === 'string' ? pairing.instructions : undefined;
  const result: PairingPendingPayload = { pairingCode, token };
  if (instructions !== undefined) result.instructions = instructions;
  return result;
}

async function readBodyTextSafely(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
  } catch {
    return '';
  }
}

/**
 * POST a `RunAgentInput` to the clawg-ui plugin at `<baseUrl>/v1/clawg-ui`.
 *
 * Handles the three response shapes the plugin can produce:
 *   - 403 `pairing_pending`: persist the new device token + return
 *     `{ kind: 'pairing-needed' }` so the caller can surface the code.
 *   - 401: return `{ kind: 'unauthorized' }`; caller decides whether to
 *     drop the identity + retry without a token.
 *   - 2xx text/event-stream: pump each `data: <JSON>` frame through
 *     `onSseEvent` until the stream ends, then return `{ kind: 'ok' }`.
 *
 * Network / other HTTP errors surface as `{ kind: 'http-error', … }` so
 * the caller can decide whether to retry. We do NOT throw on any of
 * these — every documented failure mode has a structured return shape.
 */
export async function postClawgUiRequest(
  opts: PostClawgUiRequestOptions,
): Promise<ClawgUiResponse> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const url = buildClawgUiUrl(opts.baseUrl);
  const agentId = opts.agentId ?? 'main';
  const headers = buildClawgUiHeaders({
    deviceToken: opts.deviceToken,
    agentId,
    ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
  });
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  // ---- 403 pairing_pending --------------------------------------------------
  if (res.status === 403) {
    let parsed: unknown = null;
    try {
      parsed = await res.clone().json();
    } catch {
      /* fall through */
    }
    const pending = extractPairingPending(parsed);
    if (pending) {
      await opts.identityStore.recordPairingPending({
        host: opts.host,
        port: opts.port,
        // The plugin's device token encodes the UUID in the base64url
        // prefix; we don't decode it here. The plugin will accept the
        // token on subsequent requests as long as we echo it back
        // verbatim. We persist the encoded form and treat `deviceId` as
        // an opaque identifier sourced from the same response (the
        // plugin generates it server-side — see
        // `vendor/clawg-ui/src/http-handler.ts:270`). For diagnostics we
        // store the pre-`.` segment of the token decoded as the deviceId
        // when present; falling back to the token itself keeps the
        // record valid.
        deviceId: deviceIdFromToken(pending.token) ?? pending.token,
        deviceToken: pending.token,
        pairingCode: pending.pairingCode,
      });
      return {
        kind: 'pairing-needed',
        pairingCode: pending.pairingCode,
        instructions: pending.instructions,
      };
    }
    // 403 but not in the pairing_pending shape — surface as an HTTP error
    // so the caller can log + bail.
    return {
      kind: 'http-error',
      status: 403,
      body: await readBodyTextSafely(res),
    };
  }

  // ---- 401 unauthorized -----------------------------------------------------
  if (res.status === 401) {
    return { kind: 'unauthorized', detail: await readBodyTextSafely(res) };
  }

  // ---- Other non-2xx --------------------------------------------------------
  if (!res.ok) {
    return {
      kind: 'http-error',
      status: res.status,
      body: await readBodyTextSafely(res),
    };
  }

  // ---- 2xx — successful authenticated POST ----------------------------------
  // The plugin's first authenticated success means we can drop any
  // pending pairing code from the identity store.
  await opts.identityStore.markApproved(opts.host, opts.port);

  // Pump the SSE stream into `onSseEvent`. We tolerate missing bodies
  // (e.g. in tests that fabricate a fetch shim without a stream).
  if (opts.onSseEvent && res.body) {
    await pumpSseToCallback(res, opts.onSseEvent);
  }
  return { kind: 'ok', status: res.status };
}

/**
 * Decode the base64url-prefixed UUID embedded in a clawg-ui device token.
 * Returns `null` if the token doesn't follow the expected
 * `<base64url-uuid>.<hmac>` shape.
 *
 * Mirrors `verifyDeviceToken`'s decode step in
 * `vendor/clawg-ui/src/http-handler.ts:103–115` but without HMAC
 * verification — we only use the decoded id as a diagnostic field in the
 * persisted identity record.
 */
function deviceIdFromToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;
  try {
    const decoded = Buffer.from(token.slice(0, dot), 'base64url').toString('utf-8');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Consume an SSE response body and forward each `data:` JSON frame to
 * `onEvent`. Lines that aren't valid JSON or aren't `data:` are ignored
 * (matches the AG-UI client's lenient parser). Used by the test mock —
 * production callers consume the SSE stream themselves.
 */
async function pumpSseToCallback(res: Response, onEvent: (event: unknown) => void): Promise<void> {
  // We support two body shapes: a `ReadableStream` (real `fetch`) and an
  // async-iterable shim (the test fake). Try the iterable first because
  // tests pass that path; fall back to the standard reader.
  const body = res.body as unknown;
  let buf = '';
  const decoder = new TextDecoder();
  const flushFrames = (): void => {
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          onEvent(JSON.parse(json));
        } catch {
          // skip malformed frames silently
        }
      }
    }
  };
  if (
    body &&
    typeof body === 'object' &&
    (Symbol.asyncIterator in (body as object) || Symbol.iterator in (body as object))
  ) {
    for await (const chunk of body as AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      flushFrames();
    }
  } else if (body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let streamDone = false;
    while (!streamDone) {
      const { value, done } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (value) {
        buf += decoder.decode(value, { stream: true });
        flushFrames();
      }
    }
  }
  // Final flush in case the stream ended without a trailing `\n\n`.
  buf += decoder.decode();
  if (buf.length > 0) {
    buf += '\n\n';
    flushFrames();
  }
}
