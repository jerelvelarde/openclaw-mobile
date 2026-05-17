// Tiny state machine + EventEmitter for the desktop's wrap of clawg-ui's
// pairing-pending flow (P11B).
//
// Transitions:
//
//   idle → pending          P11A's runtime client detected a 403
//                           pairing_pending and called `setPending`.
//   pending → approved      The "Approve" CLI returned exit code 0.
//   pending → denied        The user clicked "Deny" (no server RPC; the
//                           code times out on its own per clawg-ui's
//                           pending TTL).
//   pending → error         The CLI exited non-zero / timed out / the
//                           openclaw binary couldn't be found.
//   approved | denied |
//     error → idle          The renderer (or main) dismissed the
//                           banner; we're ready for the next pairing.
//
// The machine intentionally does NOT spawn child processes itself —
// callers wire the CLI wrapper (`./cli.ts`) into the approve action.
// Keeping the side-effect surface separate from the state means tests
// can drive transitions directly.
//
// We use Node's `EventEmitter` (not RxJS or similar) to stay consistent
// with the existing `pair/server.ts` `onPendingPair` callback style.

import { EventEmitter } from 'node:events';
import type { ClawgUiPairingState } from '@openclaw/protocol';

/** Listener function for state-change events. */
export type StateListener = (state: ClawgUiPairingState) => void;

/** Owner-facing handle exposed to `main/index.ts` + the IPC bridge. */
export class ClawgUiPairingStateMachine {
  private current: ClawgUiPairingState = { status: 'idle' };
  private readonly emitter = new EventEmitter();

  /** Read the current state without subscribing. */
  get state(): ClawgUiPairingState {
    return this.current;
  }

  /**
   * Subscribe to transitions. Returns an unsubscribe fn the caller
   * invokes in cleanup (e.g. ipc handler teardown). The handler fires
   * synchronously on every transition; it does NOT receive the current
   * state on subscribe — callers that need the current value should
   * read `state` immediately after subscribing.
   */
  subscribe(listener: StateListener): () => void {
    this.emitter.on('change', listener);
    return () => {
      this.emitter.off('change', listener);
    };
  }

  /**
   * Move to `pending`. Called when P11A's runtime client receives a 403
   * pairing-pending body and stashes the bearer token. Idempotent: if
   * we're already pending on the same code, this is a no-op.
   */
  setPending(pairingCode: string): void {
    if (this.current.status === 'pending' && this.current.pairingCode === pairingCode) {
      return;
    }
    this.transition({ status: 'pending', pairingCode });
  }

  /**
   * Move to `approved`. Called by the IPC handler after the
   * `openclaw pairing approve clawg-ui <code>` spawn returns exit 0.
   * Only valid from `pending` — calls from any other state are ignored
   * (we don't want a stale CLI completion to bring us back from
   * `denied`).
   */
  setApproved(): void {
    if (this.current.status !== 'pending') return;
    this.transition({ status: 'approved' });
  }

  /**
   * Move to `denied`. Called by the IPC handler when the user clicks
   * "Deny" on the Settings banner. clawg-ui has no reject RPC, so this
   * is purely a local dismissal — the pairing code stays valid
   * server-side until its TTL expires.
   */
  setDenied(reason?: string): void {
    if (this.current.status !== 'pending') return;
    this.transition({ status: 'denied', ...(reason ? { reason } : {}) });
  }

  /**
   * Move to `error`. Called when the CLI spawn fails (binary missing,
   * non-zero exit, timeout). The `message` is rendered verbatim in the
   * banner so it should be user-readable.
   */
  setError(message: string): void {
    if (this.current.status !== 'pending') return;
    this.transition({ status: 'error', message });
  }

  /**
   * Reset to `idle`. Called by the renderer when the user dismisses
   * the banner from any terminal state. Idempotent.
   */
  reset(): void {
    if (this.current.status === 'idle') return;
    this.transition({ status: 'idle' });
  }

  private transition(next: ClawgUiPairingState): void {
    this.current = next;
    this.emitter.emit('change', next);
  }
}
