// React context that owns the pairing state machine and the active
// `GatewayClient`. UI components in `app/(pairing)/*` consume `usePairing()`
// to read state and trigger transitions; nothing else in the app reaches into
// the gateway directly during the pairing flow.
//
// P03A: the gateway was always `InMemoryMockGateway`.
// P04A: when the discover screen picks a real host (Bonjour-resolved or
// pasted), we instantiate a `RealGateway` for that host and the pairing
// flow goes over actual HTTP + WS. The in-memory mock stays as the
// fallback used by tests and the dev "Mock Mac mini" entry.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { PairingApproved, Token } from '@openclaw/protocol';

import {
  InMemoryMockGateway,
  RealGateway,
  type GatewayClient,
  type ReconnectState,
} from '../openclaw/gateway';

import { initialPairingState, pairingReducer, type PairingEvent, type PairingState } from './state';
import {
  clearPairingSession,
  loadPairingSession,
  savePairingSession,
  type PersistedSession,
} from './store';

/**
 * Public hook return shape. `state` and `dispatch` are the raw reducer
 * surface so screens can drive transitions imperatively where needed; the
 * convenience derived fields (`code`, `error`) save a destructure.
 */
export interface PairingContextValue {
  state: PairingState;
  dispatch: Dispatch<PairingEvent>;
  /** Current 6-digit code, if one has been issued. */
  code: string | undefined;
  /** Last error message, if any. */
  error: string | undefined;
  /** The active gateway client. Exposed so `code.tsx` can call `_approvePairing`. */
  gateway: GatewayClient;
  /**
   * Convenience action used by `discover.tsx`. When `httpBase` is provided,
   * we install a `RealGateway` for that host and the pairing flow uses
   * real HTTP. When omitted, we use the existing in-memory mock — that
   * path is what the `__tests__` and the optional "dev mock" entry use.
   */
  selectHost: (hostId: string, deviceName: string, httpBase?: string) => Promise<void>;
  /** Convenience action used by `code.tsx` after approval lands. */
  finalizePairing: (token: Token, approved: PairingApproved) => Promise<void>;
  /** Convenience action used by `settings.tsx` re-pair stub. */
  resetPairing: () => Promise<void>;
  /**
   * Current reconnect-controller state. Only meaningful once a `RealGateway`
   * is active and `connect()` has fired; otherwise `null`. The global "Can't
   * reach your Mac" banner subscribes via this field.
   */
  reconnect: ReconnectState | null;
}

const PairingContext = createContext<PairingContextValue | null>(null);

export interface PairingProviderProps {
  children: ReactNode;
  /**
   * Optional gateway override. Tests pass an instance with `replyDelayMs: 0`;
   * production code accepts the default, which is a fresh
   * `InMemoryMockGateway`.
   */
  gateway?: GatewayClient;
}

/**
 * Wraps the route tree, owns the reducer, and seeds it from secure storage on
 * mount. Place once at the root in `app/_layout.tsx`.
 */
export function PairingProvider({ children, gateway }: PairingProviderProps): ReactElement {
  // Stable gateway reference: the default mock must persist across renders so
  // a `requestPairing()` and its matching `_approvePairing()` see the same
  // pending entry. `useRef` is the right tool here (not state) — we never
  // want re-renders just because the gateway "changed".
  const gatewayRef = useRef<GatewayClient>(gateway ?? new InMemoryMockGateway());
  // Allow the prop to update across renders (used by tests that pass a fresh
  // gateway between mounts) without recreating the mock when undefined.
  if (gateway && gateway !== gatewayRef.current) {
    gatewayRef.current = gateway;
  }

  const [state, dispatch] = useReducer(pairingReducer, initialPairingState);
  // Reconnect state from the active `RealGateway` (or `null` when the mock
  // is in use). Stored in React state so subscribers re-render on transitions.
  const [reconnectState, setReconnectState] = useState<ReconnectState | null>(null);

  // On first mount, try to load a persisted session (token + runtimeUrl +
  // httpBase). If we find one, jump straight to `paired` so the user
  // lands in `(tabs)` without re-pairing. P05A: also rebuild a
  // `RealGateway` from `httpBase` so the CopilotKit / threads screens
  // can talk to the WS topics without going through the pairing flow.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await loadPairingSession();
        if (cancelled) return;
        if (session) {
          // If we recover an httpBase, instantiate a real gateway for the
          // rest of the session. We only do this when the caller didn't
          // already provide a gateway override (test path).
          if (!gateway && session.httpBase) {
            gatewayRef.current = new RealGateway({
              httpBase: session.httpBase,
              deviceName: 'OpenClaw mobile',
            });
          }
          dispatch({
            type: 'LOADED_TOKEN',
            token: session.token,
            ...(session.runtimeUrl ? { runtimeUrl: session.runtimeUrl } : {}),
            ...(session.httpBase ? { httpBase: session.httpBase } : {}),
          });
        }
      } catch (err) {
        // A corrupted store shouldn't crash the app; surface as a soft error
        // and let the user proceed through pairing again.
        if (cancelled) return;
        dispatch({
          type: 'FAILED',
          error: err instanceof Error ? err.message : 'Failed to load pairing token',
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // The provider mounts once; the gateway override is captured at first
    // render and doesn't change in practice. Listing `gateway` would
    // re-run this load on every render in tests that pass a fresh mock.
  }, []);

  // We track the `httpBase` chosen for the in-flight pairing so we can
  // persist it alongside the approved token. The reducer also stores it
  // on the state, but the screen-side reducer flow runs slightly behind
  // the awaitPaired() resolution; a ref-side copy guarantees the correct
  // value reaches `savePairingSession`.
  const httpBaseRef = useRef<string | undefined>(undefined);

  const selectHost = useCallback(
    async (hostId: string, deviceName: string, httpBase?: string) => {
      dispatch({ type: 'HOST_SELECTED', hostId, ...(httpBase ? { httpBase } : {}) });
      httpBaseRef.current = httpBase;
      try {
        // If the caller passed a real host base, swap in a `RealGateway`
        // for the rest of the flow. The mock path is preserved for tests +
        // the dev `Mock Mac mini` fallback.
        if (httpBase && !(gateway && gateway === gatewayRef.current)) {
          gatewayRef.current = new RealGateway({ httpBase, deviceName });
        }
        const handshake = await gatewayRef.current.requestPairing({ deviceName });
        dispatch({
          type: 'CODE_ISSUED',
          code: handshake.code,
          expiresAt: handshake.expiresAt,
        });
        // Start waiting for approval. The mock resolves this when
        // `_approvePairing(code)` runs (dev-only button in `code.tsx`); the
        // real desktop will resolve it when the user clicks "Approve". The
        // dispatch happens in `finalizePairing` so the resolver path is the
        // same for tests and real users.
        const { token, approved } = await gatewayRef.current.awaitPaired();
        // Note: the resolver also persists + dispatches APPROVED — but we still
        // run finalizePairing here so the in-app dev button is not required for
        // the eventual real flow.
        await finalizeRef.current(token, approved);
      } catch (err) {
        dispatch({
          type: 'FAILED',
          error: err instanceof Error ? err.message : 'Pairing failed',
        });
      }
    },
    [gateway],
  );

  const finalizePairing = useCallback(async (token: Token, approved: PairingApproved) => {
    try {
      const httpBase = httpBaseRef.current;
      const session: PersistedSession = {
        token,
        ...(approved.runtimeUrl ? { runtimeUrl: approved.runtimeUrl } : {}),
        ...(httpBase ? { httpBase } : {}),
      };
      await savePairingSession(session);
      dispatch({
        type: 'APPROVED',
        token,
        approved,
        ...(httpBase ? { httpBase } : {}),
      });
    } catch (err) {
      dispatch({
        type: 'FAILED',
        error: err instanceof Error ? err.message : 'Failed to persist pairing token',
      });
    }
  }, []);

  // Bridge `selectHost`'s closure to the latest `finalizePairing` without
  // re-creating `selectHost` on every render (which would cancel its pending
  // `awaitPaired` whenever the provider re-rendered).
  const finalizeRef = useRef(finalizePairing);
  useEffect(() => {
    finalizeRef.current = finalizePairing;
  }, [finalizePairing]);

  const resetPairing = useCallback(async () => {
    try {
      await clearPairingSession();
    } catch {
      // Swallow store errors on clear — there's nothing the user can do
      // about a wiped Keychain entry that already isn't there.
    }
    // Tear down any live socket from a `RealGateway` so the next pairing
    // attempt doesn't trip on a stale reconnect loop.
    if (gatewayRef.current instanceof RealGateway) {
      gatewayRef.current.disconnect();
    }
    httpBaseRef.current = undefined;
    setReconnectState(null);
    dispatch({ type: 'RESET' });
  }, []);

  // Subscribe to reconnect-state on the active gateway whenever it's a
  // RealGateway and the user has reached `paired`. We don't `connect()`
  // here yet — the WS handshake (and the persistent `httpBase` that has to
  // come with it) is wired up by the screens once they have a host. For
  // tests + the mock path this effect is a no-op.
  useEffect(() => {
    if (!(gatewayRef.current instanceof RealGateway)) {
      setReconnectState(null);
      return;
    }
    const unsub = gatewayRef.current.subscribeReconnect((s) => {
      setReconnectState(s);
    });
    return unsub;
  }, [state.status]);

  const value = useMemo<PairingContextValue>(
    () => ({
      state,
      dispatch,
      code: state.code,
      error: state.error,
      gateway: gatewayRef.current,
      selectHost,
      finalizePairing,
      resetPairing,
      reconnect: reconnectState,
    }),
    [state, selectHost, finalizePairing, resetPairing, reconnectState],
  );

  return <PairingContext.Provider value={value}>{children}</PairingContext.Provider>;
}

/**
 * Read pairing state + dispatch from inside the provider tree.
 *
 * Throws if used outside `<PairingProvider>` so a misconfigured layout fails
 * loudly during development rather than rendering an empty screen.
 */
export function usePairing(): PairingContextValue {
  const ctx = useContext(PairingContext);
  if (!ctx) {
    throw new Error('usePairing() must be used inside <PairingProvider>');
  }
  return ctx;
}
