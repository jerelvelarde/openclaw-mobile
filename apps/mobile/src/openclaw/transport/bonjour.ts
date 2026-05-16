// Bonjour browser wrapper.
//
// Wraps `react-native-zeroconf` behind a tiny `browse({ onFound, onLost })`
// API so the rest of the app doesn't depend on the library's emitter shape.
// The wrapper is responsible for:
//
// 1. Picking the right scan args for `_openclaw._tcp.` (the service type the
//    desktop pairing server registers — see `.chalk/desktop-app.md` §2).
// 2. Promoting resolved services into a flat `DiscoveredHost` shape with a
//    ready-to-use `httpBase` URL the HTTP layer can hit directly.
// 3. Cleaning up native listeners when the caller unsubscribes (otherwise
//    the next `browse()` call would multi-emit).
// 4. Falling back to a no-op stream on web (Bonjour is a native-only API).
//
// The plan in `.chalk/plans/P04A-mobile-transport.md` calls for a custom
// dev client (`expo prebuild`), so this file lives alongside the iOS /
// Android native projects we just generated.

import { Platform } from 'react-native';

import type { Unsubscribe } from '@openclaw/protocol';

/**
 * Service type we browse. Matches what the desktop registers in P04B
 * (see `.chalk/desktop-app.md` §2: `_openclaw._tcp.local.`). Centralized
 * here so both browse and any future publish path use the same constant.
 */
export const OPENCLAW_SERVICE_TYPE = 'openclaw';
export const OPENCLAW_SERVICE_PROTOCOL = 'tcp';
export const OPENCLAW_SERVICE_DOMAIN = 'local.';

/**
 * Normalized host record passed to the discover screen. We expose only what
 * the UI + transport need; the raw zeroconf payload is dropped on the floor.
 */
export interface DiscoveredHost {
  /** Stable key for React lists; we use the service `name`. */
  id: string;
  /** Human-readable name (e.g. "Jerel's Mac mini"). */
  name: string;
  /** Resolved IPv4/IPv6 host or hostname. */
  host: string;
  /** TCP port the gateway is listening on. */
  port: number;
  /** Convenience HTTP base for the pairing endpoints: `http://host:port`. */
  httpBase: string;
  /** Optional TXT fields, kept as a string→string map for forward-compat. */
  txt?: Record<string, string>;
}

/** Options for a single browse session. */
export interface BrowseOptions {
  /** Called every time a new host resolves. Idempotent — may fire repeatedly for the same id. */
  onFound: (host: DiscoveredHost) => void;
  /** Called when a previously-seen host disappears from the network. */
  onLost: (id: string) => void;
  /** Called when the underlying scanner errors. Optional — defaults to a swallowed warning. */
  onError?: (err: Error) => void;
}

/**
 * Minimal shape we use from `react-native-zeroconf`. Re-stated here so the
 * dependency stays a one-line `require` we can mock in tests without
 * pulling the real native module.
 */
export interface ZeroconfLike {
  on(event: 'resolved', handler: (svc: ZeroconfResolved) => void): void;
  on(event: 'remove', handler: (name: string) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  removeAllListeners(event?: string): void;
  scan(type?: string, protocol?: string, domain?: string): void;
  stop(): void;
}

/** Subset of the `resolved` payload we care about. */
export interface ZeroconfResolved {
  name: string;
  host: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, string>;
}

/**
 * Lazy factory that returns a `Zeroconf` instance — kept as a separate
 * export so tests can swap in a fake without monkey-patching `require`.
 * On native we go through the real library; on web we never call this and
 * the no-op fallback handles things.
 */
export type ZeroconfFactory = () => ZeroconfLike;

/**
 * Default factory: dynamically requires the native module so a web bundle
 * doesn't pull it in. The `require` is intentional vs. a static `import`:
 * Metro tree-shakes the unreachable branch on web, and the unit tests can
 * inject a stub via `browse({ ...opts, _factory })`.
 */
const defaultFactory: ZeroconfFactory = () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const Zeroconf = require('react-native-zeroconf').default as new () => ZeroconfLike;
  return new Zeroconf();
};

/**
 * Pick the canonical host for a resolved service. iOS sometimes returns
 * the `.local` hostname (which the phone can resolve via mDNS), Android
 * usually returns an IPv4 address in `addresses[]`. We prefer an explicit
 * IPv4 address when one is present (fewer mDNS lookups during the pairing
 * round-trip) and fall back to `host` otherwise.
 */
function pickHost(svc: ZeroconfResolved): string {
  if (svc.addresses && svc.addresses.length > 0) {
    // Prefer the first IPv4-looking address; fall back to the first entry.
    const ipv4 = svc.addresses.find((a) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(a));
    if (ipv4) return ipv4;
    const first = svc.addresses[0];
    if (first) return first;
  }
  return svc.host;
}

/**
 * Build a `DiscoveredHost` from a raw zeroconf payload. Exported for tests
 * so we can assert the normalization independent of the emitter wiring.
 */
export function toDiscoveredHost(svc: ZeroconfResolved): DiscoveredHost {
  const host = pickHost(svc);
  return {
    id: svc.name,
    name: svc.name,
    host,
    port: svc.port,
    httpBase: `http://${host}:${svc.port}`,
    txt: svc.txt,
  };
}

/**
 * Start browsing for `_openclaw._tcp.local.` services. Returns an
 * `Unsubscribe` that stops the scanner and removes all listeners. Safe to
 * call repeatedly: each call gets its own underlying scanner.
 *
 * On web (or any platform without zeroconf) returns a no-op `Unsubscribe`
 * and never invokes `onFound` — the discover screen still renders, just
 * empty, and the paste-URL fallback takes over.
 */
export function browse(
  opts: BrowseOptions,
  factory: ZeroconfFactory = defaultFactory,
): Unsubscribe {
  if (Platform.OS === 'web') {
    return () => {
      /* no-op */
    };
  }

  let zc: ZeroconfLike;
  try {
    zc = factory();
  } catch (err) {
    // Surface the load failure once and bail. This keeps a busted native
    // module from crashing the whole app at first render.
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    return () => {
      /* no-op */
    };
  }

  zc.on('resolved', (svc) => {
    if (!svc?.name || typeof svc.port !== 'number') return;
    opts.onFound(toDiscoveredHost(svc));
  });
  zc.on('remove', (name) => {
    if (!name) return;
    opts.onLost(name);
  });
  zc.on('error', (err) => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  zc.scan(OPENCLAW_SERVICE_TYPE, OPENCLAW_SERVICE_PROTOCOL, OPENCLAW_SERVICE_DOMAIN);

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      zc.stop();
    } catch {
      // Stopping a not-yet-started scanner throws on some platforms. Swallow.
    }
    zc.removeAllListeners();
  };
}
