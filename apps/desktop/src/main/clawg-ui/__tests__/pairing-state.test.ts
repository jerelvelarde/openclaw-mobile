// Tests for the clawg-ui pairing-state machine (P11B).

import { describe, expect, it, vi } from 'vitest';
import type { ClawgUiPairingState } from '@openclaw/protocol';
import { ClawgUiPairingStateMachine } from '../pairing-state';

describe('ClawgUiPairingStateMachine', () => {
  it('starts in idle', () => {
    const sm = new ClawgUiPairingStateMachine();
    expect(sm.state).toEqual({ status: 'idle' });
  });

  it('transitions idle → pending and emits to subscribers', () => {
    const sm = new ClawgUiPairingStateMachine();
    const seen: ClawgUiPairingState[] = [];
    sm.subscribe((s) => seen.push(s));
    sm.setPending('ABCD1234');
    expect(sm.state).toEqual({ status: 'pending', pairingCode: 'ABCD1234' });
    expect(seen).toEqual([{ status: 'pending', pairingCode: 'ABCD1234' }]);
  });

  it('is idempotent when re-pending the same code', () => {
    const sm = new ClawgUiPairingStateMachine();
    const listener = vi.fn();
    sm.subscribe(listener);
    sm.setPending('ABCD1234');
    sm.setPending('ABCD1234');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('transitions pending → approved on setApproved', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setPending('ABCD1234');
    sm.setApproved();
    expect(sm.state).toEqual({ status: 'approved' });
  });

  it('ignores setApproved when not pending', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setApproved();
    expect(sm.state).toEqual({ status: 'idle' });
  });

  it('transitions pending → denied with optional reason', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setPending('ABCD1234');
    sm.setDenied('user dismissed');
    expect(sm.state).toEqual({ status: 'denied', reason: 'user dismissed' });
  });

  it('transitions pending → error and preserves the message', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setPending('ABCD1234');
    sm.setError('openclaw not found');
    expect(sm.state).toEqual({ status: 'error', message: 'openclaw not found' });
  });

  it('does not let a stale CLI completion overwrite a denied state', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setPending('ABCD1234');
    sm.setDenied();
    // CLI completes after the user clicked Deny — we ignore it.
    sm.setApproved();
    expect(sm.state.status).toBe('denied');
  });

  it('resets to idle from any terminal state', () => {
    const sm = new ClawgUiPairingStateMachine();
    sm.setPending('ABCD1234');
    sm.setApproved();
    sm.reset();
    expect(sm.state).toEqual({ status: 'idle' });
  });

  it('does not emit when reset is called from idle', () => {
    const sm = new ClawgUiPairingStateMachine();
    const listener = vi.fn();
    sm.subscribe(listener);
    sm.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes cleanly', () => {
    const sm = new ClawgUiPairingStateMachine();
    const listener = vi.fn();
    const unsub = sm.subscribe(listener);
    sm.setPending('ABCD1234');
    unsub();
    sm.setApproved();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
