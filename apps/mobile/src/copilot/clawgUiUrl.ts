// Build the URL + headers + body shape for clawg-ui requests (P11A).
//
// Mobile-side mirror of `apps/desktop/src/main/clawg-ui/client.ts`'s URL
// + header conventions. The desktop owns the network call when chat
// originates from the desktop renderer; mobile owns it when chat
// originates from the phone (per `apps/mobile/src/copilot/runAgent.ts`).
// Both must hit the same endpoint with the same header set or the
// gateway will reject one of the two clients.
//
// The wire shape we match is `vendor/clawg-ui/src/http-handler.ts:221–
// 348` + `vendor/clawg-ui/README.md:328–369`:
//   - POST `<baseUrl>/v1/clawg-ui`
//   - `Authorization: Bearer <deviceToken>`
//   - `Content-Type: application/json`
//   - `Accept: text/event-stream`
//   - `X-OpenClaw-Agent-Id: <agentId>` (default `"main"`)
//   - `X-OpenClaw-Session-Key: <sessionKey>` (only when supplied and
//     valid per the plugin's regex; see SESSION_KEY_RE below).
//
// Body is built by the caller from a `RunAgentInput`. We don't
// stringify here so the caller can stream / log / replay it freely.

/** Default agent the gateway routes to when no `X-OpenClaw-Agent-Id` is set. */
export const DEFAULT_CLAWG_UI_AGENT_ID = 'main';

/** Path the plugin mounts under, relative to the daemon's base URL. */
export const CLAWG_UI_PATH = '/v1/clawg-ui';

/**
 * Validator for the optional `X-OpenClaw-Session-Key` header. Matches the
 * plugin-side regex in `vendor/clawg-ui/src/http-handler.ts:85–91`:
 * up to 256 chars from `[A-Za-z0-9._@:-]`. We reject anything else
 * client-side so the gateway doesn't send back a 400 we'd have to retry.
 */
export const SESSION_KEY_RE = /^[A-Za-z0-9._@:-]{1,256}$/;

/** Result of {@link buildClawgUiRequest}. */
export interface ClawgUiRequest {
  /** Absolute POST URL. */
  url: string;
  /** Headers the caller stamps onto `fetch(..., { headers })`. */
  headers: Record<string, string>;
}

/** Inputs to {@link buildClawgUiRequest}. */
export interface BuildClawgUiRequestOptions {
  /** Daemon base URL, e.g. `http://192.168.1.42:18789`. */
  baseUrl: string;
  /**
   * HMAC-signed device token the plugin returned in a 403
   * `pairing_pending` response and the user later approved via
   * `openclaw pairing approve clawg-ui <code>` on the gateway host.
   */
  deviceToken: string;
  /**
   * Agent id (header value). Defaults to `"main"` per the plugin's
   * routing convention. Use a non-default value when targeting a
   * registered alternate agent.
   */
  agentId?: string;
  /**
   * Optional session-key partition. Set only when the caller is a
   * trusted proxy partitioning sessions per user — see the plugin
   * README's "Trust model" section. Invalid values (per
   * {@link SESSION_KEY_RE}) are dropped silently to avoid client-side
   * 400s; surface a UI warning at the call site if you need stricter
   * feedback.
   */
  sessionKey?: string;
}

/**
 * Compose the absolute URL the mobile client POSTs to.
 *
 * Strips trailing slashes so concatenation stays predictable for both
 * `http://host:18789` and `http://host:18789/`.
 */
export function buildClawgUiUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CLAWG_UI_PATH}`;
}

/**
 * Compose the headers the mobile client sends on every clawg-ui POST.
 *
 * Exported for tests + the URL+headers bundle in {@link buildClawgUiRequest}.
 */
export function buildClawgUiHeaders(opts: {
  deviceToken: string;
  agentId?: string;
  sessionKey?: string;
}): Record<string, string> {
  const agentId = opts.agentId ?? DEFAULT_CLAWG_UI_AGENT_ID;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.deviceToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-OpenClaw-Agent-Id': agentId,
  };
  if (opts.sessionKey !== undefined && SESSION_KEY_RE.test(opts.sessionKey)) {
    headers['X-OpenClaw-Session-Key'] = opts.sessionKey;
  }
  return headers;
}

/**
 * Bundle URL + headers for a clawg-ui POST. The body is assembled by the
 * caller from `RunAgentInput` (see `apps/mobile/src/copilot/runAgent.ts`).
 *
 * Headers we set:
 *   - `Authorization: Bearer ${deviceToken}`
 *   - `Content-Type: application/json`
 *   - `Accept: text/event-stream`
 *   - `X-OpenClaw-Agent-Id: ${agentId}` (default `"main"`)
 *   - `X-OpenClaw-Session-Key: ${sessionKey}` (only when valid)
 */
export function buildClawgUiRequest(opts: BuildClawgUiRequestOptions): ClawgUiRequest {
  return {
    url: buildClawgUiUrl(opts.baseUrl),
    headers: buildClawgUiHeaders({
      deviceToken: opts.deviceToken,
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    }),
  };
}
