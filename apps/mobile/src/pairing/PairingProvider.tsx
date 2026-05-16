// React context that owns the pairing state machine and the active
// `GatewayClient`. UI components in `app/(pairing)/*` consume `usePairing()`
// to read state and trigger transitions; nothing else in the app reaches into
// the gateway directly during the pairing flow.
//
// For P03A the gateway is always the `InMemoryMockGateway`. P04A swaps in a
// real WS-backed client at this seam without touching the screens.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { PairingApproved, Token } from '@openclaw/protocol';

import { InMemoryMockGateway, type GatewayClient } from '../openclaw/gateway';

import { initialPairingState, pairingReducer, type PairingEvent, type PairingState } from './state';
import { clearPairingToken, loadPairingToken, savePairingToken } from './store';

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
  /** Convenience action used by `discover.tsx`. */
  selectHost: (hostId: string, deviceName: string) => Promise<void>;
  /** Convenience action used by `code.tsx` after approval lands. */
  finalizePairing: (token: Token, approved: PairingApproved) => Promise<void>;
  /** Convenience action used by `settings.tsx` re-pair stub. */
  resetPairing: () => Promise<void>;
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

  // On first mount, try to load a persisted token. If we find one, jump
  // straight to `paired` so the user lands in `(tabs)` without re-pairing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await loadPairingToken();
        if (cancelled) return;
        if (token) {
          dispatch({ type: 'LOADED_TOKEN', token });
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
  }, []);

  const selectHost = useCallback(async (hostId: string, deviceName: string) => {
    dispatch({ type: 'HOST_SELECTED', hostId });
    try {
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
  }, []);

  const finalizePairing = useCallback(async (token: Token, approved: PairingApproved) => {
    try {
      await savePairingToken(token);
      dispatch({ type: 'APPROVED', token, approved });
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
      await clearPairingToken();
    } catch {
      // Swallow store errors on clear — there's nothing the user can do
      // about a wiped Keychain entry that already isn't there.
    }
    dispatch({ type: 'RESET' });
  }, []);

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
    }),
    [state, selectHost, finalizePairing, resetPairing],
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
