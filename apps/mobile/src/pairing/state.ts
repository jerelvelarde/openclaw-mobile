// Pairing state machine, modeled as a plain `useReducer` reducer.
//
// Drives `welcome → discover → code → paired` per `.chalk/plan.md` §5 and the
// cross-app handshake in `.chalk/desktop-app.md` §3. Owned states map 1:1 to
// what the UI in `app/(pairing)/*` needs to render; events match what
// `PairingProvider` dispatches as it interacts with `GatewayClient`.
//
// We keep this as `useReducer` per the P03A plan's note: prefer it over XState
// for v1 — the transition graph is small enough that a switch is clearer than
// importing a state-machine library.

import type { PairingApproved, Token } from '@openclaw/protocol';

/**
 * Discrete pairing state. `idle` is the entry point shown on `welcome.tsx`;
 * `paired` gates the `(tabs)` route group; `error` is recoverable via `RESET`.
 */
export type PairingStatus =
  | 'idle'
  | 'discovering'
  | 'requesting'
  | 'awaiting_approval'
  | 'paired'
  | 'error';

/**
 * Reducer state. Optional fields are populated as the flow progresses; e.g.
 * `code` only exists once the gateway has issued one, `token` only exists
 * once the desktop has approved.
 */
export interface PairingState {
  status: PairingStatus;
  /** Selected host id (mock-only for P03A; real Bonjour entries land in P04A). */
  hostId?: string;
  /** 6-digit code shown on the `code` screen while awaiting approval. */
  code?: string;
  /** Epoch ms at which the current pairing code stops being accepted. */
  expiresAt?: number;
  /** Approval envelope returned by the gateway on success. */
  approved?: PairingApproved;
  /** Persisted bearer token once approval lands. */
  token?: Token;
  /**
   * Absolute CopilotKit runtime URL the desktop advertised at pairing
   * time. Populated on `APPROVED` and on `LOADED_TOKEN` when the session
   * record carried it (P05A+). Consumed by the CopilotKit provider.
   */
  runtimeUrl?: string;
  /** HTTP base the phone paired against — used as runtime-URL fallback. */
  httpBase?: string;
  /**
   * Optional clawg-ui daemon base URL the desktop advertised in the
   * pairing payload (Q46). Persisted across launches so chat in
   * `mode: 'clawg-ui'` can target `<clawgUiBaseUrl>/v1/clawg-ui` without
   * re-pairing. Absent in stub mode + on pre-Wave-15 desktops.
   */
  clawgUiBaseUrl?: string;
  /** Human-readable error for the `error` state. */
  error?: string;
}

/**
 * Dispatchable events. Names match the P03A plan §3.
 *
 * - `START` — user tapped "Continue" on welcome; move to `discovering`.
 * - `HOST_SELECTED` — user picked a host on `discover.tsx`; move to `requesting`.
 * - `CODE_ISSUED` — `requestPairing()` resolved; show the code.
 * - `APPROVED` — `awaitPaired()` resolved; persist token + move to `paired`.
 * - `FAILED` — any step blew up; surface the message in `state.error`.
 * - `RESET` — clear state (used by re-pair and on token-clear).
 * - `LOADED_TOKEN` — provider mount loaded a persisted token; skip pairing.
 */
export type PairingEvent =
  | { type: 'START' }
  | { type: 'HOST_SELECTED'; hostId: string; httpBase?: string }
  | { type: 'CODE_ISSUED'; code: string; expiresAt: number }
  | { type: 'APPROVED'; token: Token; approved: PairingApproved; httpBase?: string }
  | { type: 'FAILED'; error: string }
  | { type: 'RESET' }
  | {
      type: 'LOADED_TOKEN';
      token: Token;
      runtimeUrl?: string;
      httpBase?: string;
      clawgUiBaseUrl?: string;
    };

/** Starting state when the provider first mounts (before token load). */
export const initialPairingState: PairingState = { status: 'idle' };

/**
 * Pure reducer — no side effects. `PairingProvider` owns the GatewayClient
 * calls and dispatches the resulting events. Keeping this pure lets the
 * `__tests__/state.test.ts` suite assert transitions without mocking timers
 * or network.
 */
export function pairingReducer(state: PairingState, event: PairingEvent): PairingState {
  switch (event.type) {
    case 'START':
      // Entering discovery clears any stale error from a prior attempt.
      return { status: 'discovering' };

    case 'HOST_SELECTED':
      // Only meaningful while discovering; ignore otherwise so a stray tap
      // from a dev-only "approve" button can't rewind a paired session.
      if (state.status !== 'discovering') return state;
      return {
        status: 'requesting',
        hostId: event.hostId,
        ...(event.httpBase ? { httpBase: event.httpBase } : {}),
      };

    case 'CODE_ISSUED':
      // The provider calls `requestPairing()` after `HOST_SELECTED`; only
      // accept the issued code from the `requesting` state.
      if (state.status !== 'requesting') return state;
      return {
        ...state,
        status: 'awaiting_approval',
        code: event.code,
        expiresAt: event.expiresAt,
      };

    case 'APPROVED':
      // Approval is only valid while awaiting it.
      if (state.status !== 'awaiting_approval') return state;
      return {
        status: 'paired',
        token: event.token,
        approved: event.approved,
        // Preserve the code on the paired state for diagnostics only; it's
        // not used as an auth credential after this point.
        code: state.code,
        runtimeUrl: event.approved.runtimeUrl,
        ...(event.httpBase ? { httpBase: event.httpBase } : {}),
        // Q46: surface the clawg-ui base URL on `paired` state so
        // consumers (CopilotKit runtime resolution) can route real-mode
        // chat without a second store lookup.
        ...(event.approved.clawgUiBaseUrl ? { clawgUiBaseUrl: event.approved.clawgUiBaseUrl } : {}),
      };

    case 'FAILED':
      // Any in-flight state can fail; `RESET` is the way out.
      return { status: 'error', error: event.error };

    case 'RESET':
      // Used by re-pair (settings) and by `clearPairingToken()` flows.
      return { status: 'idle' };

    case 'LOADED_TOKEN':
      // The provider calls this once on mount if it finds a persisted token.
      // We trust the store and jump straight to `paired`; expired-token
      // handling lands when the real WS client emits `token_expired` in P04A.
      return {
        status: 'paired',
        token: event.token,
        ...(event.runtimeUrl ? { runtimeUrl: event.runtimeUrl } : {}),
        ...(event.httpBase ? { httpBase: event.httpBase } : {}),
        // Q46: persist the clawg-ui base URL across launches so chat in
        // real mode doesn't need a re-pair to recover the daemon address.
        ...(event.clawgUiBaseUrl ? { clawgUiBaseUrl: event.clawgUiBaseUrl } : {}),
      };

    default: {
      // Exhaustiveness guard — if a new event variant is added, TS errors here.
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}
