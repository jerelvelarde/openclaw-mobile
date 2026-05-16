// Local HTTP pairing service.
//
// Per P03B step 5: a fastify server bound to **127.0.0.1 only** that
// implements the three HTTP routes mobile depends on at first contact:
//
//   POST /pair/request        — phone announces itself, gets a code + pair_id.
//   GET  /pair/status         — phone polls until the user approves/denies.
//   GET  /healthz             — used by mobile's Bonjour probe + dev curl.
//
// P04B opens this server to the LAN (when `settings.lan_enabled === true`)
// so Bonjour-discovered phones can reach it, and attaches the WS
// transport on the same port. P05C mounts the CopilotKit runtime adapter
// at `/copilot/runtime` on this same fastify instance, so the
// `runtime_url` returned by `/pair/status` resolves to a live HTTP
// endpoint mobile can POST against.
//
// The pending-pair table lives in-memory: pairing requests are transient
// and don't survive a desktop restart on purpose (the user will just
// re-pair). Approved devices persist via `DeviceStore`.

import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_TOKEN_TTL_MS, issueToken, verifyToken, type PairingClaim } from './token';
import { DeviceStore } from './store';
import type { SigningKey } from './keypair';

/** Default loopback port. Override via the `OPENCLAW_DESKTOP_PORT` env. */
export const DEFAULT_PORT = 18789;

/**
 * Build the `runtime_url` value returned at pairing time. P04B derives
 * this from the LAN hostname so mobile can reach the runtime after
 * pairing; loopback callers (dev tooling, the renderer chat UI) pass
 * `host: '127.0.0.1'`. P05C mounts the actual `/copilot/runtime`
 * adapter on the same fastify server (see `copilot/runtime.ts`'s
 * `registerCopilotRuntime`) — this URL is the live endpoint mobile
 * stashes alongside the token.
 */
export function buildRuntimeUrl(host: string, port: number): string {
  return `http://${host}:${port}/copilot/runtime`;
}

/**
 * Legacy loopback placeholder kept around for the existing tests that
 * compare against it. New callers should prefer `buildRuntimeUrl()` so
 * the host matches the actual bind address.
 */
export const RUNTIME_URL_PLACEHOLDER = buildRuntimeUrl('127.0.0.1', DEFAULT_PORT);

/** Default time-to-approve for a pending pairing request. */
export const DEFAULT_PAIR_TTL_MS = 5 * 60 * 1000;

/** In-memory record for a not-yet-approved pairing request. */
export interface PendingPair {
  pair_id: string;
  device_name: string;
  /** Base64-encoded Ed25519 public key the phone sent us. Kept verbatim. */
  public_key: string;
  /** Six-digit numeric code shown to the user for visual confirmation. */
  code: string;
  /** Epoch ms when this pending entry stops being valid. */
  expires_at: number;
  /** Current state in the approval state machine. */
  status: 'pending' | 'approved' | 'denied';
  /** Populated only once `status === 'approved'`. */
  token?: string;
  /** Populated only once `status === 'approved'` — see RUNTIME_URL_PLACEHOLDER. */
  runtime_url?: string;
  /** Populated only once approved — assigned at approve time. */
  device_id?: string;
}

interface PairRequestBody {
  device_name?: unknown;
  public_key?: unknown;
}

interface PairStatusQuery {
  pair_id?: unknown;
}

interface PushTokenParams {
  id: string;
}

interface PushTokenBody {
  token?: unknown;
  platform?: unknown;
}

/**
 * Pull the compact `claim.signature` bearer token off a fastify request.
 * Mirrors the WS server's extractor; we accept `?token=` as a fallback
 * for environments that can't set Authorization headers.
 */
function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(\S+)/i.exec(auth);
    if (m) return m[1] ?? null;
  }
  const query = req.query as Record<string, unknown> | undefined;
  const q = query?.['token'];
  if (typeof q === 'string' && q.length > 0) return q;
  return null;
}

/** Generate a 6-digit zero-padded numeric code. */
function generateCode(): string {
  // randomInt would do, but we use randomBytes to avoid the small bias of
  // modulo and keep all six digits uniformly distributed.
  const bytes = randomBytes(4);
  const n = bytes.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(6, '0');
}

/**
 * Build the in-memory pending-pair table. Returned as an object so the
 * server + the IPC layer can share the same map without re-exposing
 * implementation details.
 */
export class PendingPairTable {
  private readonly pairs = new Map<string, PendingPair>();

  add(pair: PendingPair): void {
    this.pairs.set(pair.pair_id, pair);
  }

  get(pairId: string): PendingPair | undefined {
    return this.pairs.get(pairId);
  }

  /** All not-yet-resolved pairs, oldest first. */
  listPending(now: number = Date.now()): PendingPair[] {
    const out: PendingPair[] = [];
    for (const p of this.pairs.values()) {
      if (p.status === 'pending' && p.expires_at > now) {
        out.push(p);
      }
    }
    return out.sort((a, b) => a.expires_at - b.expires_at);
  }

  /** Purge expired pending entries and resolved entries older than 10 minutes. */
  gc(now: number = Date.now()): void {
    for (const [id, p] of this.pairs) {
      if (p.status === 'pending' && p.expires_at <= now) {
        this.pairs.delete(id);
      } else if (p.status !== 'pending' && p.expires_at + 10 * 60 * 1000 <= now) {
        this.pairs.delete(id);
      }
    }
  }
}

/** Inputs the server needs at construction time. */
export interface BuildServerOptions {
  /** Loaded signing key from `loadOrCreateSigningKey`. */
  signingKey: SigningKey;
  /** Stable gateway id (`{userDataDir}/gateway_id` is created on first run). */
  gatewayId: string;
  /** Persistent device store for approved devices. */
  deviceStore: DeviceStore;
  /** Build version exposed via `/healthz`. */
  version: string;
  /**
   * Hook called whenever a new pairing request arrives. The main process
   * wires this to the notification helper + the renderer modal.
   */
  onPendingPair?: (pair: PendingPair) => void;
  /** Override the pending TTL (ms). Defaults to `DEFAULT_PAIR_TTL_MS`. */
  pairTtlMs?: number;
  /** Override the issued-token TTL (ms). Defaults to `DEFAULT_TOKEN_TTL_MS`. */
  tokenTtlMs?: number;
  /** Inject the pending table — useful for tests. */
  pendingTable?: PendingPairTable;
  /**
   * Runtime URL handed back in `/pair/status` after approval. The main
   * process passes a value built with `buildRuntimeUrl(hostname, port)`
   * when LAN exposure is on. Defaults to the loopback placeholder so
   * the existing tests keep working without wiring host detection.
   */
  runtimeUrl?: string;
}

/** Bundle returned from `buildPairingServer` for the main process to manage. */
export interface PairingServer {
  fastify: FastifyInstance;
  pending: PendingPairTable;
  /**
   * Approve a pending pair: issue a token, persist the device, and flip
   * the pending entry to "approved". Returns the resolved entry, or
   * `null` if the pair_id is unknown / already resolved / expired.
   */
  approve(pairId: string, now?: number): PendingPair | null;
  /** Symmetric counterpart to `approve`. */
  deny(pairId: string, now?: number): PendingPair | null;
}

/**
 * Construct a fastify server with the three pairing routes wired up. The
 * server is **not** listening yet — callers do `fastify.listen({ host:
 * '127.0.0.1', port })` (or `fastify.inject` in tests).
 */
export function buildPairingServer(opts: BuildServerOptions): PairingServer {
  const pending = opts.pendingTable ?? new PendingPairTable();
  const pairTtlMs = opts.pairTtlMs ?? DEFAULT_PAIR_TTL_MS;
  const tokenTtlMs = opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const runtimeUrl = opts.runtimeUrl ?? RUNTIME_URL_PLACEHOLDER;

  const fastify = Fastify({ logger: false });

  fastify.get('/healthz', async () => {
    return { ok: true, gateway_id: opts.gatewayId, version: opts.version };
  });

  fastify.post<{ Body: PairRequestBody }>('/pair/request', async (req, reply) => {
    const body = req.body ?? {};
    const deviceName = typeof body.device_name === 'string' ? body.device_name.trim() : '';
    const publicKey = typeof body.public_key === 'string' ? body.public_key : '';
    if (!deviceName || !publicKey) {
      void reply.code(400);
      return { error: 'device_name and public_key are required strings' };
    }
    const now = Date.now();
    pending.gc(now);
    const pair: PendingPair = {
      pair_id: randomUUID(),
      device_name: deviceName,
      public_key: publicKey,
      code: generateCode(),
      expires_at: now + pairTtlMs,
      status: 'pending',
    };
    pending.add(pair);
    try {
      opts.onPendingPair?.(pair);
    } catch {
      // The notification handler is best-effort. If it throws (e.g. no
      // Electron available in tests), the pair still queues up — the
      // renderer can pull it via the IPC list call.
    }
    return { pair_id: pair.pair_id, code: pair.code, expires_at: pair.expires_at };
  });

  fastify.get<{ Querystring: PairStatusQuery }>('/pair/status', async (req, reply) => {
    const pairId = typeof req.query.pair_id === 'string' ? req.query.pair_id : '';
    if (!pairId) {
      void reply.code(400);
      return { error: 'pair_id is required' };
    }
    const now = Date.now();
    pending.gc(now);
    const pair = pending.get(pairId);
    if (!pair) {
      void reply.code(404);
      return { error: 'unknown pair_id' };
    }
    if (pair.status === 'pending' && pair.expires_at <= now) {
      void reply.code(410);
      return { status: 'denied', error: 'expired' };
    }
    if (pair.status === 'approved') {
      return {
        status: 'approved' as const,
        token: pair.token,
        runtime_url: pair.runtime_url,
      };
    }
    if (pair.status === 'denied') {
      return { status: 'denied' as const };
    }
    return { status: 'pending' as const };
  });

  // POST /devices/:id/push-token — P08B step 5.
  //
  // Mobile POSTs its Expo push token after pairing completes. The route
  // is bearer-authenticated against the *same* signing key as the WS
  // upgrade: any device with a valid pairing token can register a
  // token for the device id encoded in that token. Cross-device writes
  // are rejected (claim.device_id must match the URL param) so a phone
  // can't overwrite another phone's token.
  fastify.post<{ Params: PushTokenParams; Body: PushTokenBody }>(
    '/devices/:id/push-token',
    async (req, reply) => {
      const token = extractBearer(req);
      if (!token) {
        void reply.code(401);
        return { error: 'missing bearer token' };
      }
      const claim: PairingClaim | null = verifyToken(opts.signingKey.publicKey, token);
      if (!claim) {
        void reply.code(401);
        return { error: 'invalid token' };
      }
      if (claim.device_id !== req.params.id) {
        // Same shape as 401 to avoid leaking which device ids exist.
        void reply.code(403);
        return { error: 'token does not match device id' };
      }
      const body = req.body ?? {};
      const pushToken = typeof body.token === 'string' ? body.token : '';
      const platformRaw = typeof body.platform === 'string' ? body.platform : '';
      if (!pushToken) {
        void reply.code(400);
        return { error: 'token is required' };
      }
      if (platformRaw !== 'ios' && platformRaw !== 'android') {
        void reply.code(400);
        return { error: "platform must be 'ios' or 'android'" };
      }
      const ok = opts.deviceStore.setPushToken(req.params.id, pushToken, platformRaw);
      if (!ok) {
        void reply.code(404);
        return { error: 'unknown device id' };
      }
      return { ok: true };
    },
  );

  function approve(pairId: string, now: number = Date.now()): PendingPair | null {
    const pair = pending.get(pairId);
    if (!pair || pair.status !== 'pending') return null;
    if (pair.expires_at <= now) return null;
    const deviceId = randomUUID();
    const token = issueToken(opts.signingKey.privateKey, {
      device_id: deviceId,
      device_name: pair.device_name,
      gateway_id: opts.gatewayId,
      ttlMs: tokenTtlMs,
      issuedAt: now,
    });
    pair.status = 'approved';
    pair.token = token;
    pair.runtime_url = runtimeUrl;
    pair.device_id = deviceId;
    opts.deviceStore.addDevice({
      device_id: deviceId,
      device_name: pair.device_name,
      paired_at: now,
      last_seen: now,
    });
    return pair;
  }

  function deny(pairId: string, now: number = Date.now()): PendingPair | null {
    const pair = pending.get(pairId);
    if (!pair || pair.status !== 'pending') return null;
    if (pair.expires_at <= now) return null;
    pair.status = 'denied';
    return pair;
  }

  return { fastify, pending, approve, deny };
}
