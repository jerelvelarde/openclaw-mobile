// Derive the CopilotKit runtime URL + auth headers from pairing state.
//
// At pairing time the desktop returns a `runtime_url` value (see
// `apps/desktop/src/main/pair/server.ts` `buildRuntimeUrl`) — typically
// `http://<host>:18789/copilot/runtime`. P05A stashes that URL on the
// `PairingApproved` shape, but for runtime calls we also accept a fallback
// where the URL is derived from the `httpBase` the phone paired to. That
// way a stored session that lost its `runtimeUrl` (older builds, or a
// migration) still works.
//
// Wire shape we hit in P05C ("stub" mode — `mode: 'p05c'`),
// per `apps/desktop/src/main/copilot/runtime.ts`:
//
//   POST <runtimeUrl>/agent/:agentId/run
//   Authorization: Bearer <pairing token>
//   Content-Type: application/json
//   Body: RunAgentInput  (see ./types.ts)
//   Response: text/event-stream of AG-UI events.
//
// Wire shape we hit in P11A ("clawg-ui" mode — `mode: 'clawg-ui'`),
// per `vendor/clawg-ui/src/http-handler.ts:221–348`:
//
//   POST <baseUrl>/v1/clawg-ui
//   Authorization: Bearer <clawg-ui device token>
//   Content-Type: application/json
//   Accept: text/event-stream
//   X-OpenClaw-Agent-Id: <agentId>          ← header, not URL path
//   X-OpenClaw-Session-Key: <sessionKey>?   ← optional trusted-proxy hint
//   Body: RunAgentInput
//   Response: text/event-stream of AG-UI events (identical event set).
//
// The two modes are deliberately kept symmetric so the caller in
// `runAgent.ts` can swap them by switching on `mode` without touching
// the SSE pump.

/** Path the desktop adapter mounts under, mirroring `DEFAULT_COPILOT_BASE_PATH`. */
export const DEFAULT_COPILOT_BASE_PATH = '/copilot/runtime';

/** Compose the auth headers every runtime call needs. */
export function buildRuntimeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

/**
 * Build the absolute `POST` URL for the run endpoint, given the base
 * `runtimeUrl` advertised by the desktop and the agent the caller wants
 * to address. `agentId` is URL-encoded so values like `openclaw.default`
 * with dots stay intact and exotic ids (`my agent`) don't break the path.
 */
export function buildRunUrl(runtimeUrl: string, agentId: string): string {
  // Strip trailing slashes so concatenation stays predictable.
  const base = runtimeUrl.replace(/\/+$/, '');
  return `${base}/agent/${encodeURIComponent(agentId)}/run`;
}

/**
 * Fallback when `PairingApproved.runtimeUrl` is missing (e.g. an old token
 * from a build that didn't persist it). We mirror what the desktop side
 * would produce.
 */
export function deriveRuntimeUrlFromHttpBase(httpBase: string): string {
  const base = httpBase.replace(/\/+$/, '');
  return `${base}${DEFAULT_COPILOT_BASE_PATH}`;
}

/**
 * Pick the best `runtimeUrl` for a paired session. Prefer the value the
 * desktop returned at pairing time; fall back to deriving it from the
 * `httpBase` the phone paired against; throw if neither is available.
 */
export function resolveRuntimeUrl(input: { runtimeUrl?: string; httpBase?: string }): string {
  if (input.runtimeUrl && input.runtimeUrl.length > 0) return input.runtimeUrl;
  if (input.httpBase && input.httpBase.length > 0)
    return deriveRuntimeUrlFromHttpBase(input.httpBase);
  throw new Error('No runtimeUrl or httpBase available — pair the device first');
}

// ── Mode-discriminated request resolution (P11A) ─────────────────────────
import { buildClawgUiRequest, type ClawgUiRequest } from './clawgUiUrl';

/**
 * Wire mode the mobile client should use for a given session.
 *
 *   - `"p05c"` — POST `<runtimeUrl>/agent/:agentId/run` with a pairing
 *     bearer token. This is today's stub-mode path and the default for
 *     existing sessions.
 *   - `"clawg-ui"` — POST `<baseUrl>/v1/clawg-ui` with a clawg-ui device
 *     token + `X-OpenClaw-Agent-Id` header. Used when the gateway has
 *     the `@contextableai/clawg-ui` plugin installed and the desktop is
 *     in `gateway_mode: "clawg-ui"`. The base URL + device token are
 *     advertised via the pairing handshake (P11B).
 */
export type RuntimeMode = 'p05c' | 'clawg-ui';

/** Shared shape returned by {@link resolveRuntimeRequest}. */
export interface ResolvedRuntimeRequest {
  /** Absolute POST URL. */
  url: string;
  /** Headers the caller stamps onto `fetch(..., { headers })`. */
  headers: Record<string, string>;
}

/** Inputs to {@link resolveRuntimeRequest}. */
export interface ResolveRuntimeRequestOptions {
  /** Which wire format the gateway speaks. */
  mode: RuntimeMode;
  /** Agent id to address. */
  agentId: string;
  /**
   * P05C input — pairing token (`PairingApproved.token`). Required when
   * `mode === "p05c"`; ignored otherwise.
   */
  pairingToken?: string;
  /**
   * P05C input — base runtime URL (`PairingApproved.runtimeUrl` or
   * derived from `httpBase`). Required when `mode === "p05c"`.
   */
  runtimeUrl?: string;
  /** P05C fallback. */
  httpBase?: string;
  /**
   * P11A input — clawg-ui device token (persisted per-gateway after the
   * pairing-pending 403 handshake). Required when `mode === "clawg-ui"`.
   */
  clawgUiDeviceToken?: string;
  /**
   * P11A input — daemon base URL (e.g. `http://192.168.1.42:18789`).
   * Required when `mode === "clawg-ui"`.
   */
  clawgUiBaseUrl?: string;
  /**
   * Optional trusted-proxy session-key partition. Only meaningful in
   * `clawg-ui` mode; see `clawgUiUrl.ts` for validation rules.
   */
  sessionKey?: string;
}

/**
 * Resolve the URL + headers the mobile client should hit for a single
 * agent run, picking between the legacy P05C adapter URL and the new
 * clawg-ui plugin endpoint per `opts.mode`.
 *
 * The body is built by the caller from `RunAgentInput` (see
 * `apps/mobile/src/copilot/runAgent.ts`) — this helper is body-agnostic
 * so the same plumbing works for any payload shape AG-UI accepts.
 */
export function resolveRuntimeRequest(opts: ResolveRuntimeRequestOptions): ResolvedRuntimeRequest {
  if (opts.mode === 'clawg-ui') {
    if (!opts.clawgUiBaseUrl) {
      throw new Error('clawg-ui mode requires clawgUiBaseUrl');
    }
    if (!opts.clawgUiDeviceToken) {
      throw new Error('clawg-ui mode requires clawgUiDeviceToken');
    }
    const req: ClawgUiRequest = buildClawgUiRequest({
      baseUrl: opts.clawgUiBaseUrl,
      deviceToken: opts.clawgUiDeviceToken,
      agentId: opts.agentId,
      ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    });
    return { url: req.url, headers: req.headers };
  }
  // P05C — today's default, unchanged behaviour.
  if (!opts.pairingToken) {
    throw new Error('p05c mode requires pairingToken');
  }
  const runtimeUrl = resolveRuntimeUrl({
    ...(opts.runtimeUrl !== undefined ? { runtimeUrl: opts.runtimeUrl } : {}),
    ...(opts.httpBase !== undefined ? { httpBase: opts.httpBase } : {}),
  });
  return {
    url: buildRunUrl(runtimeUrl, opts.agentId),
    headers: buildRuntimeHeaders(opts.pairingToken),
  };
}
