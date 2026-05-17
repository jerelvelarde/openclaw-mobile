// HTTP transport for the pairing flow.
//
// Implements the two endpoints from the desktop server contract
// (`.chalk/desktop-app.md` §5, locked down by P03B's `server.ts`):
//
//   POST /pair/request   { device_name, public_key } → { pair_id, code, expires_at }
//   GET  /pair/status    ?pair_id=… → { status, token?, runtime_url? }
//
// All requests target a `httpBase` chosen by the caller — Bonjour gives us
// `http://<ip>:<port>` (defaulting to port 18789 per `DEFAULT_PORT` in
// `apps/desktop/src/main/pair/server.ts`); a paste-URL flow gives us the
// same shape. We never reach into `globalThis.fetch` from anywhere else —
// the gateway interface stays the only seam.

import type { PairingApproved, Token } from '@openclaw/protocol';

/** Default gateway port — mirrors `apps/desktop/.../server.ts` `DEFAULT_PORT`. */
export const DEFAULT_GATEWAY_PORT = 18789;

/** Strip a trailing slash so we can safely concat paths with a leading `/`. */
function normalizeBase(httpBase: string): string {
  return httpBase.replace(/\/+$/, '');
}

/** Response shape from `POST /pair/request`. */
export interface PairRequestResponse {
  pair_id: string;
  code: string;
  expires_at: number;
}

/** Response shape from `GET /pair/status` while the user hasn't acted. */
export interface PairStatusPending {
  status: 'pending';
}
/** Response shape from `GET /pair/status` once the user approves. */
export interface PairStatusApproved {
  status: 'approved';
  token: string;
  runtime_url: string;
  /**
   * Optional clawg-ui daemon base URL advertised by the desktop when it
   * is running in `gateway_mode: "clawg-ui"` (P11A/P11B). Mobile persists
   * this alongside `runtime_url` so chat in clawg-ui mode can target
   * `<clawgUiBaseUrl>/v1/clawg-ui` (Q46). Omitted in stub mode and in
   * older desktop builds — callers must handle the field being absent.
   */
  clawg_ui_base_url?: string;
}
/** Response shape from `GET /pair/status` if the user denies or it expires. */
export interface PairStatusDenied {
  status: 'denied';
  error?: string;
}
export type PairStatusResponse = PairStatusPending | PairStatusApproved | PairStatusDenied;

/**
 * Injection seam for `fetch`. Tests pass a stub; production passes
 * `globalThis.fetch` which works on RN, RN Web, and Node 22+.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Body sent to `POST /pair/request`. Mirrors the desktop server contract:
 * the desktop expects `device_name` + `public_key` (snake_case on the
 * wire), our higher-level `GatewayClient` uses `deviceName` (camelCase).
 *
 * For P04A the phone does not yet have an Ed25519 keypair of its own — the
 * desktop accepts the public key opaquely and stores it for future
 * signature verification (a forward-compat hook P04B will start using).
 * We pass a stable per-install placeholder so the field validates;
 * generating + persisting a real keypair lands in P05A alongside the
 * actual authenticated reconnect path.
 */
export interface PairRequestBody {
  device_name: string;
  /** Base64-encoded Ed25519 public key (placeholder until P05A). */
  public_key: string;
}

/**
 * Throw a normalized error from a non-2xx response. Keeps callers from
 * having to remember whether `fetch` rejects on 4xx (it doesn't).
 */
async function failedResponseError(res: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === 'string') detail = `: ${body.error}`;
  } catch {
    // Body wasn't JSON or response was already consumed — fine, just drop it.
  }
  return new Error(`HTTP ${res.status}${detail}`);
}

/**
 * `POST /pair/request`. Returns the freshly-issued pair entry. Throws on
 * network failure, on non-2xx HTTP, or on a payload that doesn't match
 * the expected shape.
 */
export async function requestPairing(
  httpBase: string,
  body: PairRequestBody,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<PairRequestResponse> {
  const res = await fetchImpl(`${normalizeBase(httpBase)}/pair/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failedResponseError(res);
  const json = (await res.json()) as Partial<PairRequestResponse>;
  if (
    typeof json.pair_id !== 'string' ||
    typeof json.code !== 'string' ||
    typeof json.expires_at !== 'number'
  ) {
    throw new Error('Malformed /pair/request response');
  }
  return { pair_id: json.pair_id, code: json.code, expires_at: json.expires_at };
}

/** One raw call to `GET /pair/status`. Exposed for granular tests. */
export async function fetchPairStatus(
  httpBase: string,
  pairId: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<PairStatusResponse> {
  const url = `${normalizeBase(httpBase)}/pair/status?pair_id=${encodeURIComponent(pairId)}`;
  const res = await fetchImpl(url, { method: 'GET' });
  // The desktop server returns 410 + `{status:'denied', error:'expired'}` on
  // expiry — treat that as a regular response so callers can settle the
  // poller on a denied status without retrying.
  if (res.status === 410) {
    return { status: 'denied', error: 'expired' };
  }
  if (!res.ok) throw await failedResponseError(res);
  const json = (await res.json()) as Partial<PairStatusResponse> & Record<string, unknown>;
  if (json.status === 'approved') {
    if (typeof json.token !== 'string' || typeof json.runtime_url !== 'string') {
      throw new Error('Malformed approved /pair/status response');
    }
    return {
      status: 'approved',
      token: json.token,
      runtime_url: json.runtime_url,
      // Only forward when present + string; older desktops omit the field
      // entirely and stub-mode desktops omit it intentionally (Q46).
      ...(typeof json['clawg_ui_base_url'] === 'string'
        ? { clawg_ui_base_url: json['clawg_ui_base_url'] }
        : {}),
    };
  }
  if (json.status === 'denied') {
    return { status: 'denied', error: typeof json.error === 'string' ? json.error : undefined };
  }
  if (json.status === 'pending') return { status: 'pending' };
  throw new Error(`Unexpected /pair/status status: ${String(json.status)}`);
}

/**
 * Backoff schedule for poll attempts while the user is reading the code
 * off the phone and walking to the Mac. Tight at first (so a fast approval
 * feels instant) then loose (so we don't hammer the server while the user
 * gets coffee). Total schedule covers ~5 minutes which lines up with the
 * server's `DEFAULT_PAIR_TTL_MS`.
 */
export const PAIR_POLL_INTERVALS_MS: readonly number[] = [
  500, 500, 1000, 1000, 2000, 2000, 3000, 5000,
];
/** Steady-state interval once the schedule above is exhausted. */
export const PAIR_POLL_STEADY_MS = 5000;

/** Options for `pollPairingStatus`. Tests stub the clock + delay. */
export interface PollPairingOptions {
  /** Replaces `globalThis.fetch` — used by tests. */
  fetchImpl?: FetchLike;
  /** Replaces `setTimeout`-backed sleep — used by tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Replaces `Date.now` — used by tests to drive the deadline. */
  now?: () => number;
  /** Absolute deadline epoch ms; defaults to `expiresAt` from the request. */
  deadlineMs?: number;
  /** Hard cap on attempts (tests use this to bound runaway loops). */
  maxAttempts?: number;
  /** Override the backoff schedule. */
  intervals?: readonly number[];
  /** Override the steady-state interval. */
  steadyMs?: number;
}

/** Default sleep that respects fake timers in tests via the injected `setTimeout`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Translate a snake_case `PairStatusApproved` into the protocol's `PairingApproved`. */
export function toPairingApproved(
  code: string,
  status: PairStatusApproved,
  /** Default token TTL when the desktop doesn't tell us — 1 hour to match the mock. */
  tokenTtlMs: number = 60 * 60 * 1000,
  now: () => number = Date.now,
): { token: Token; approved: PairingApproved } {
  const token: Token = { value: status.token, expiresAt: now() + tokenTtlMs };
  const approved: PairingApproved = {
    code,
    token,
    runtimeUrl: status.runtime_url,
    // Forward the clawg-ui base URL if the desktop advertised one (Q46).
    // Absent in stub mode + on pre-Wave-15 desktops; the optional field
    // matches the Zod schema in @openclaw/protocol.
    ...(status.clawg_ui_base_url !== undefined ? { clawgUiBaseUrl: status.clawg_ui_base_url } : {}),
  };
  return { token, approved };
}

/**
 * Poll `/pair/status` until the request resolves. Resolves with the final
 * approved/denied response. Rejects on network errors that aren't recoverable
 * and on `deadlineMs` elapsed.
 *
 * The schedule (`PAIR_POLL_INTERVALS_MS` then `PAIR_POLL_STEADY_MS`) starts
 * tight so a fast approval shows up quickly and loosens so we don't hammer
 * the desktop while the user walks across the room.
 */
export async function pollPairingStatus(
  httpBase: string,
  pairId: string,
  opts: PollPairingOptions = {},
): Promise<PairStatusApproved | PairStatusDenied> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const intervals = opts.intervals ?? PAIR_POLL_INTERVALS_MS;
  const steadyMs = opts.steadyMs ?? PAIR_POLL_STEADY_MS;
  const deadline = opts.deadlineMs ?? Infinity;
  const maxAttempts = opts.maxAttempts ?? Infinity;

  let attempt = 0;
  // We do an immediate first check so a server that approves before the
  // phone even displays the code is picked up without the initial 500ms delay.
  // After each pending response we sleep for `intervals[attempt - 1]` (or
  // steady-state once we exhaust the schedule).
  for (;;) {
    if (now() >= deadline) {
      return { status: 'denied', error: 'deadline_exceeded' };
    }
    if (attempt >= maxAttempts) {
      return { status: 'denied', error: 'max_attempts_exceeded' };
    }
    attempt += 1;

    const result = await fetchPairStatus(httpBase, pairId, fetchImpl);
    if (result.status === 'approved' || result.status === 'denied') {
      return result;
    }
    // Pending — sleep for the next interval before re-polling.
    const idx = attempt - 1;
    const wait = idx < intervals.length ? (intervals[idx] ?? steadyMs) : steadyMs;
    // Don't oversleep past the deadline; clamp to whatever we have left.
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { status: 'denied', error: 'deadline_exceeded' };
    }
    await sleep(Math.min(wait, remaining));
  }
}

/**
 * High-level helper used by `RealGateway`: kick off `requestPairing` and a
 * matching `pollPairingStatus`, returning both the handshake (so the UI can
 * show the code) and a deferred for the eventual `{ token, approved }`.
 *
 * Splitting these on a single function keeps the gateway from having to
 * juggle two promises; the UI awaits `handshake` synchronously and the
 * gateway awaits `paired` in the background.
 */
export interface PairingFlow {
  handshake: PairRequestResponse;
  paired: Promise<{ token: Token; approved: PairingApproved }>;
}

export async function startPairingFlow(
  httpBase: string,
  body: PairRequestBody,
  opts: PollPairingOptions & { fetchImpl?: FetchLike } = {},
): Promise<PairingFlow> {
  const handshake = await requestPairing(httpBase, body, opts.fetchImpl);
  const paired = (async () => {
    const final = await pollPairingStatus(httpBase, handshake.pair_id, {
      ...opts,
      deadlineMs: opts.deadlineMs ?? handshake.expires_at,
    });
    if (final.status === 'denied') {
      throw new Error(`Pairing denied${final.error ? `: ${final.error}` : ''}`);
    }
    return toPairingApproved(handshake.code, final, undefined, opts.now);
  })();
  return { handshake, paired };
}

/**
 * Turn a discovered host or a pasted URL into an `http://host:port` base
 * the rest of this module can hit. Accepts `ws://`/`wss://` URLs and
 * coerces them to `http(s)://`; accepts bare hostnames and adds the
 * default port. Throws on garbage.
 */
export function resolveHttpBase(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty gateway URL');
  // Coerce ws[s]:// → http[s]://. Pairing is over HTTP regardless of how
  // the user pasted it.
  const httpish = trimmed.replace(/^ws(s?):\/\//, 'http$1://');
  if (!/^https?:\/\//.test(httpish)) {
    return `http://${httpish.replace(/\/+$/, '')}${trimmed.includes(':') ? '' : `:${DEFAULT_GATEWAY_PORT}`}`;
  }
  try {
    const u = new URL(httpish);
    if (!u.port) u.port = String(DEFAULT_GATEWAY_PORT);
    // Drop trailing slash on the path so the concat in `normalizeBase` is
    // a no-op in the common case.
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    throw new Error(`Invalid gateway URL: ${raw}`);
  }
}
