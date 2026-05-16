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
// Wire shape we hit (per `apps/desktop/src/main/copilot/runtime.ts`):
//
//   POST <runtimeUrl>/agent/:agentId/run
//   Authorization: Bearer <pairing token>
//   Content-Type: application/json
//   Body: RunAgentInput  (see ./types.ts)
//   Response: text/event-stream of AG-UI events.

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
