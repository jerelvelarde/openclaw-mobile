// Pairing-approval modal.
//
// Per P03B step 7: shows the device name + the 6-digit code mirrored
// from the main process so the user can compare it against what the
// phone shows. Approve/Deny buttons IPC back to main, which flips the
// pending pair to approved/denied; the phone polling `/pair/status`
// then picks up the new state.
//
// The page subscribes to `onPending` so a new pairing request that
// arrives while the modal is open swaps in the latest pair (we always
// show the oldest still-pending entry — what the user is most likely
// to act on). When the queue empties we render an "all caught up"
// message instead of the modal.

import { useEffect, useState } from 'react';
import type { PendingPairView } from '../../../preload/ipc-channels';

type LoadState = 'loading' | 'ready';

interface PairingPageState {
  load: LoadState;
  queue: PendingPairView[];
}

export function ApprovePairing(): JSX.Element {
  const [state, setState] = useState<PairingPageState>({ load: 'loading', queue: [] });
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) {
      setState({ load: 'ready', queue: [] });
      return;
    }
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const queue = await bridge.pairing.listPending();
      if (cancelled) return;
      setState({ load: 'ready', queue });
    };
    void refresh();
    const unsub = bridge.pairing.onPending(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleDecision = async (pairId: string, decision: 'approve' | 'deny'): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) return;
    setBusy(pairId);
    try {
      if (decision === 'approve') {
        await bridge.pairing.approve(pairId);
      } else {
        await bridge.pairing.deny(pairId);
      }
      const queue = await bridge.pairing.listPending();
      setState({ load: 'ready', queue });
    } finally {
      setBusy(null);
    }
  };

  if (state.load === 'loading') {
    return (
      <section aria-busy="true">
        <h2>Pairing</h2>
        <p>Loading pending requests…</p>
      </section>
    );
  }

  const pending = state.queue[0];
  if (!pending) {
    return (
      <section>
        <h2>Pairing</h2>
        <p>No pending requests. Pairing prompts appear here when a phone connects.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Approve pairing?</h2>
      <p>
        <strong>{pending.device_name}</strong> is asking to pair with this Mac.
      </p>
      <p>
        Confirm this code matches what the phone shows:
        <br />
        <code aria-label="pairing code" style={{ fontSize: '1.6em', letterSpacing: '0.25em' }}>
          {pending.code}
        </code>
      </p>
      <div role="group" aria-label="pairing-decision">
        <button
          type="button"
          disabled={busy === pending.pair_id}
          onClick={() => void handleDecision(pending.pair_id, 'approve')}
        >
          Approve
        </button>{' '}
        <button
          type="button"
          disabled={busy === pending.pair_id}
          onClick={() => void handleDecision(pending.pair_id, 'deny')}
        >
          Deny
        </button>
      </div>
      {state.queue.length > 1 ? (
        <p aria-live="polite">
          {state.queue.length - 1} more pairing request{state.queue.length - 1 === 1 ? '' : 's'}{' '}
          queued.
        </p>
      ) : null}
    </section>
  );
}
