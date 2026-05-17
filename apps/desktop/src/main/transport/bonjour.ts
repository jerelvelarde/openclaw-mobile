// Bonjour / mDNS advertisement for the OpenClaw desktop gateway.
//
// Per P04B step 2: when the app boots (and `lan_enabled` is true), we
// publish `_openclaw._tcp.local.` with the gateway id + version in the
// TXT record. Mobile's discovery scan picks this up and pre-fills the
// pairing host.
//
// We use `bonjour-service` (pure-JS, no native deps) instead of the
// older `mdns` package — the latter needs Avahi/dnssd headers, which
// the dev container doesn't ship. On Linux in environments without
// multicast support `bonjour-service` may still fail at `publish` time;
// we wrap every entry point in try/catch and surface the failure
// through `state` rather than crashing the main process.

import { hostname as osHostname } from 'node:os';
import { Bonjour, type Service } from 'bonjour-service';

/** Service type advertised by the desktop app. */
export const SERVICE_TYPE = 'openclaw';
/** Service protocol advertised by the desktop app. */
export const SERVICE_PROTOCOL = 'tcp' as const;

/** Inputs the publisher needs at construction time. */
export interface PublishOptions {
  /** Stable per-gateway UUID (from `pair/gateway-id.ts`). */
  gatewayId: string;
  /** App version, from `app.getVersion()` (or any test override). */
  version: string;
  /** Port to advertise — matches the fastify listener (default 18789). */
  port: number;
  /** Override the host name used to render the service display label. */
  hostname?: string;
}

/** Lifecycle state of the publisher, surfaced to the tray menu + tests. */
export type BonjourState = 'idle' | 'advertising' | 'error';

/** Public surface of a constructed publisher. */
export interface BonjourPublisher {
  /** Start advertising. Idempotent. Returns the resulting state. */
  start(): BonjourState;
  /** Stop advertising. Idempotent. Returns the resulting state. */
  stop(): Promise<BonjourState>;
  /** Last-known lifecycle state. */
  readonly state: BonjourState;
  /** Last error caught from `bonjour-service`, if any. */
  readonly lastError: Error | null;
  /** The published service handle, exposed for tests + diagnostics. */
  readonly service: Service | null;
}

/**
 * Build a Bonjour publisher around `bonjour-service`. The caller decides
 * whether to actually start it — typically by checking the `lan_enabled`
 * setting. Designed so that any failure inside `bonjour-service` (e.g.
 * no multicast capability inside a container) lands in `state === 'error'`
 * rather than as an uncaught exception.
 */
export function createBonjourPublisher(opts: PublishOptions): BonjourPublisher {
  const host = opts.hostname ?? osHostname();
  const name = `OpenClaw (${host})`;
  // `bonjour-service` accepts only string values in the TXT record; numeric
  // fields would be quietly coerced anyway, so do it explicitly here.
  const txt = {
    gateway_id: opts.gatewayId,
    version: opts.version,
  };

  let instance: Bonjour | null = null;
  let service: Service | null = null;
  let state: BonjourState = 'idle';
  let lastError: Error | null = null;

  function start(): BonjourState {
    if (state === 'advertising') return state;
    try {
      instance = new Bonjour();
      service = instance.publish({
        name,
        type: SERVICE_TYPE,
        protocol: SERVICE_PROTOCOL,
        port: opts.port,
        txt,
      });
      state = 'advertising';
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      state = 'error';
      // Best-effort cleanup — if Bonjour partially initialised, try to
      // tear it back down so subsequent retries don't double-publish.
      try {
        instance?.destroy();
      } catch {
        // ignore
      }
      instance = null;
      service = null;
    }
    return state;
  }

  async function stop(): Promise<BonjourState> {
    if (!instance) {
      state = 'idle';
      return state;
    }
    try {
      await new Promise<void>((resolve) => {
        // `unpublishAll` callback is invoked when every probe has been
        // retracted; failure here is best-effort.
        instance!.unpublishAll(() => resolve());
      });
      instance.destroy();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
    instance = null;
    service = null;
    state = 'idle';
    return state;
  }

  return {
    start,
    stop,
    get state() {
      return state;
    },
    get lastError() {
      return lastError;
    },
    get service() {
      return service;
    },
  };
}
