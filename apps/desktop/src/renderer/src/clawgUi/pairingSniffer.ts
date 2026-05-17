// Renderer-side sniffer for clawg-ui's `403 pairing_pending` response.
//
// Wave 15 review Fix 1: the desktop's `clawgUiPairing.notifyPending(...)`
// hook in `apps/desktop/src/main/index.ts` was never called in production
// — the renderer's chat surface POSTs to the gateway plugin directly
// when `gateway_mode === 'clawg-ui'`, gets a 403, and silently fails.
// Without this sniffer the P11B UX (tray notification + Settings banner
// + tray entry) is dead code.
//
// What this module does:
//
//   1. Exports `clawgUiFetch(...)` — a thin wrapper around `fetch` for
//      POSTs to a clawg-ui endpoint. It's a drop-in replacement for the
//      renderer's chat-mode HTTP call.
//   2. On a `403 pairing_pending` body (matching the same shape that
//      `parse-pairing-response.ts` and `client.ts#postClawgUiRequest`
//      understand), it pulls `{ pairingCode, token }` out and calls
//      `window.api.clawgUi.notifyPending({ pairingCode, token, host,
//      port })`. Main persists the token via the identity store and
//      kicks off the notification + Settings banner + tray entry.
//   3. Returns the unchanged `Response` so the caller can render its
//      own "pairing required" message if it wants.
//
// We deliberately keep this sniffer self-contained — it doesn't import
// from `@openclaw/protocol` or from `apps/desktop/src/main/clawg-ui/*`
// because the renderer can't reach across the preload boundary. The
// parser is intentionally a near-clone of
// `main/clawg-ui/parse-pairing-response.ts` so the two stay aligned;
// any change to the wire shape must be mirrored here.
//
// We do NOT fire the sniffer on the in-process `"stub"` mode path — the
// stub gateway never returns a 403 pairing_pending. Callers select
// between the two by inspecting `settings.gateway_mode` first.

/** Parsed pairing-pending envelope. Matches `ClawgUiPairingPending`. */
export interface SniffedPairingPending {
  pairingCode: string;
  token: string;
  instructions: string | undefined;
}

interface PairingPendingBody {
  pairing_code?: unknown;
  bearer_token?: unknown;
  error?: {
    type?: unknown;
    pairing?: {
      pairingCode?: unknown;
      token?: unknown;
      instructions?: unknown;
    };
  };
}

/**
 * Pull a `{ pairingCode, token }` envelope out of a parsed 403 body.
 * Returns `null` if the body doesn't match clawg-ui's documented
 * pairing-pending shape (`vendor/clawg-ui/README.md:259-271`).
 *
 * Mirrors the structured + flat fallback paths in
 * `main/clawg-ui/parse-pairing-response.ts`. Kept in sync deliberately
 * — these are the same wire shape parsed on two sides of the preload
 * boundary.
 */
export function parsePairingPendingBody(body: unknown): SniffedPairingPending | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as PairingPendingBody;
  if (b.error?.type !== 'pairing_pending') return null;
  const pairing = b.error.pairing;
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
  return { pairingCode, token, instructions };
}

/** Options for {@link clawgUiFetch}. */
export interface ClawgUiFetchOptions {
  /**
   * The renderer's HTTP body — typically a `RunAgentInput` (see
   * `apps/mobile/src/copilot/types.ts`). Serialised via `JSON.stringify`.
   */
  body: unknown;
  /**
   * Bearer token to send. Omit on the unauthenticated first call (the
   * gateway plugin will respond `403 pairing_pending`); supply on
   * retries once the user has approved the pairing on the host.
   */
  deviceToken?: string;
  /**
   * Agent id (header `X-OpenClaw-Agent-Id`). Defaults to `"main"` per
   * clawg-ui's convention.
   */
  agentId?: string;
  /** Optional `X-OpenClaw-Session-Key` partition for trusted-proxy callers. */
  sessionKey?: string;
  /** Inject `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /**
   * Inject the preload bridge for tests; defaults to
   * `window.api.clawgUi`. Returning `undefined` from this resolver means
   * the renderer is in a no-preload environment (jsdom smoke path) and
   * the sniffer silently no-ops on the IPC call.
   */
  getBridge?: () => {
    notifyPending: (payload: {
      pairingCode: string;
      token: string;
      host: string;
      port: number;
    }) => Promise<boolean>;
  } | null;
  /** Propagated to `fetch(..., { signal })`. */
  signal?: AbortSignal;
}

/**
 * POST `body` to `<baseUrl>/v1/clawg-ui` with the conventional headers
 * (Authorization, Accept: text/event-stream, X-OpenClaw-Agent-Id). On a
 * `403 pairing_pending` response we extract `{ pairingCode, token }`
 * and notify the main process via the preload bridge so the standard
 * P11B UX flows can fire. The returned `Response` is the original one,
 * untouched, so the caller can read the SSE body on success or render
 * its own error UI on failure.
 *
 * `baseUrl` is the daemon BASE URL (e.g. `http://127.0.0.1:18789`); the
 * `/v1/clawg-ui` suffix is appended here. Host + port are parsed from
 * `baseUrl` and forwarded over IPC so the identity store keys line up
 * with the desktop's own client.
 */
export async function clawgUiFetch(baseUrl: string, opts: ClawgUiFetchOptions): Promise<Response> {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/clawg-ui`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-OpenClaw-Agent-Id': opts.agentId ?? 'main',
  };
  if (opts.deviceToken) {
    headers['Authorization'] = `Bearer ${opts.deviceToken}`;
  }
  if (opts.sessionKey !== undefined && opts.sessionKey.length > 0) {
    headers['X-OpenClaw-Session-Key'] = opts.sessionKey;
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (res.status === 403) {
    // Clone before reading so the caller still sees the original body
    // (some renderer paths may want to surface the plugin's error message
    // verbatim). `.clone()` errors on streamed bodies that have already
    // been consumed; we don't consume here so this is safe.
    let parsed: unknown = null;
    try {
      parsed = await res.clone().json();
    } catch {
      // Body wasn't JSON — fall through; caller handles a non-pending 403
      // as a generic HTTP error.
      return res;
    }
    const pending = parsePairingPendingBody(parsed);
    if (pending) {
      const { host, port } = parseBaseUrl(baseUrl);
      const getBridge =
        opts.getBridge ??
        (() => {
          // The preload bridge isn't available in the jsdom smoke path —
          // returning null keeps the sniffer side-effect-free in tests
          // that don't mock `window.api`.
          if (typeof window === 'undefined' || !window.api?.clawgUi) return null;
          return window.api.clawgUi;
        });
      const bridge = getBridge();
      if (bridge && host && port) {
        try {
          await bridge.notifyPending({
            pairingCode: pending.pairingCode,
            token: pending.token,
            host,
            port,
          });
        } catch (err) {
          // Surface to the console so the diagnostic is observable, but
          // don't block the caller — the user can still hit the
          // notification on the next attempt.
          // eslint-disable-next-line no-console
          console.warn('[clawg-ui] notifyPending IPC failed:', err);
        }
      }
    }
  }
  return res;
}

interface ParsedBaseUrl {
  host: string;
  port: number;
}

/**
 * Pull `host` + `port` out of a daemon base URL. The desktop's identity
 * store keys by these two values verbatim (`clawg-ui/identity.ts`); the
 * IPC payload echoes them so the persisted record lines up with what
 * `apps/desktop/src/main/index.ts` reads at boot. Defaults to the
 * gateway port (18789) when the URL omits it — matches
 * `vendor/clawg-ui/README.md:39`.
 */
export function parseBaseUrl(baseUrl: string): ParsedBaseUrl {
  try {
    const u = new URL(baseUrl);
    const port = u.port ? Number.parseInt(u.port, 10) : u.protocol === 'https:' ? 443 : 18789;
    return { host: u.hostname, port };
  } catch {
    return { host: '', port: 0 };
  }
}
