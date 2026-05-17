// Mobile-side state holder for the clawg-ui pairing flow (P11B).
//
// When the mobile app POSTs to the openclaw gateway's `/v1/clawg-ui`
// endpoint (in `gateway_mode === "clawg-ui"`), the first request returns
// a `403 pairing_pending` body carrying a `pairingCode` + a `token`. The
// mobile client:
//
//   1. Stores the bearer token in secure-store (so subsequent retries
//      can present `Authorization: Bearer <token>`).
//   2. Surfaces the pairing code on a "waiting for gateway approval"
//      intermediate screen so the user can confirm it matches what the
//      desktop is asking them to approve.
//   3. Polls / retries the post until the desktop's gateway-host owner
//      approves it (which is what P11B's desktop wrap does for them).
//
// The transport plumbing — the actual `POST` + 403 detection — lives in
// P11A's `runAgent.ts` changes. This provider exposes a small
// state-setting API that P11A wires into. Keeping the state in a
// context (rather than threading it through every consumer of
// `usePairing()`) lets the "waiting" screen subscribe without dragging
// the chat session reducer into its render tree.
//
// On the secure-store side: clawg-ui's bearer token is a separate
// credential from our P03B pairing token (which authenticates the
// phone↔Mac WS). They coexist under distinct keys so a clawg-ui
// re-pairing doesn't wipe the user's WS session.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { ClawgUiPairingStateSchema, type ClawgUiPairingState } from '@openclaw/protocol';

import { clearClawgUiToken, saveClawgUiToken } from './tokenStore';

/** Public hook return shape. */
export interface ClawgUiPairingContextValue {
  /** Current state from clawg-ui's pairing handshake. */
  state: ClawgUiPairingState;
  /**
   * Called by the transport layer (P11A) when it receives a 403
   * pairing_pending response. Persists the bearer token and transitions
   * the state to `pending`.
   */
  notifyPending(args: { pairingCode: string; token: string }): Promise<void>;
  /** Called when the transport's next retry succeeds. */
  notifyApproved(): void;
  /** Called when a fatal error surfaces (e.g. bad token, unreachable host). */
  notifyError(message: string): void;
  /**
   * User-facing dismiss for the "waiting" screen. Wipes the stashed
   * token + resets the state to idle. clawg-ui has no client-side
   * cancel RPC, so this is purely local.
   */
  dismiss(): Promise<void>;
}

const ClawgUiPairingContext = createContext<ClawgUiPairingContextValue | null>(null);

export interface ClawgUiPairingProviderProps {
  children: ReactNode;
  /**
   * Override for tests. Defaults to the secure-store wrappers in
   * `./tokenStore.ts`.
   */
  storage?: {
    saveToken: (token: string) => Promise<void>;
    clearToken: () => Promise<void>;
  };
}

/**
 * Wraps the mobile route tree below `<PairingProvider>` so any screen
 * (in particular the "waiting for gateway" intermediate) can observe
 * the clawg-ui handshake state without prop-drilling.
 */
export function ClawgUiPairingProvider({
  children,
  storage,
}: ClawgUiPairingProviderProps): ReactElement {
  const [state, setState] = useState<ClawgUiPairingState>({ status: 'idle' });
  // Stable storage ref so swapping the prop between tests doesn't trip
  // a re-bind on every render.
  const storageRef = useRef(
    storage ?? {
      saveToken: saveClawgUiToken,
      clearToken: clearClawgUiToken,
    },
  );
  if (storage && storage !== storageRef.current) {
    storageRef.current = storage;
  }

  const notifyPending = useCallback(async (args: { pairingCode: string; token: string }) => {
    // Validate via the shared protocol schema so a malformed payload
    // (e.g. P11A regressed the parser) surfaces here as a state-machine
    // error rather than rendering garbage on the waiting screen.
    const next = ClawgUiPairingStateSchema.parse({
      status: 'pending',
      pairingCode: args.pairingCode,
    });
    try {
      await storageRef.current.saveToken(args.token);
      setState(next);
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to persist gateway token',
      });
    }
  }, []);

  const notifyApproved = useCallback(() => {
    setState({ status: 'approved' });
  }, []);

  const notifyError = useCallback((message: string) => {
    setState({ status: 'error', message });
  }, []);

  const dismiss = useCallback(async () => {
    try {
      await storageRef.current.clearToken();
    } catch {
      // Best-effort — clearing a missing key is fine.
    }
    setState({ status: 'idle' });
  }, []);

  const value = useMemo<ClawgUiPairingContextValue>(
    () => ({ state, notifyPending, notifyApproved, notifyError, dismiss }),
    [state, notifyPending, notifyApproved, notifyError, dismiss],
  );

  return <ClawgUiPairingContext.Provider value={value}>{children}</ClawgUiPairingContext.Provider>;
}

/**
 * Read the clawg-ui pairing state from inside the provider. Returns a
 * default idle context when no provider is mounted — that lets the
 * existing pairing screens render without coupling to this provider
 * during tests that don't exercise the clawg-ui flow.
 */
export function useClawgUiPairing(): ClawgUiPairingContextValue {
  const ctx = useContext(ClawgUiPairingContext);
  if (!ctx) {
    // Inert no-op context. Returning a stable object keeps `useEffect`
    // dependency arrays sane when a provider is mounted/unmounted in
    // tests.
    return INERT_CONTEXT;
  }
  return ctx;
}

const INERT_CONTEXT: ClawgUiPairingContextValue = {
  state: { status: 'idle' },
  notifyPending: async () => {
    /* no-op */
  },
  notifyApproved: () => {
    /* no-op */
  },
  notifyError: () => {
    /* no-op */
  },
  dismiss: async () => {
    /* no-op */
  },
};
