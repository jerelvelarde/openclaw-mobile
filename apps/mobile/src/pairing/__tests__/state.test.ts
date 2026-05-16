// Reducer transition tests for the pairing state machine.
//
// We deliberately exercise every transition listed in
// `.chalk/plans/P03A-mobile-pairing-ui.md` §3 plus the guard rules in
// `pairingReducer` (events ignored when issued from the wrong state).

import type { PairingApproved, Token } from '@openclaw/protocol';

import { initialPairingState, pairingReducer, type PairingState } from '../state';

const FAKE_TOKEN: Token = { value: 'tok_test', expiresAt: 9_999_999_999_999 };
const FAKE_APPROVED: PairingApproved = {
  code: '123456',
  token: FAKE_TOKEN,
  runtimeUrl: 'http://127.0.0.1:18789/copilot/runtime',
};

describe('pairingReducer', () => {
  it('starts in idle', () => {
    expect(initialPairingState).toEqual<PairingState>({ status: 'idle' });
  });

  it('START moves idle → discovering', () => {
    const next = pairingReducer({ status: 'idle' }, { type: 'START' });
    expect(next.status).toBe('discovering');
  });

  it('HOST_SELECTED moves discovering → requesting and records hostId', () => {
    const next = pairingReducer(
      { status: 'discovering' },
      { type: 'HOST_SELECTED', hostId: 'mock-mac-mini' },
    );
    expect(next).toEqual<PairingState>({ status: 'requesting', hostId: 'mock-mac-mini' });
  });

  it('HOST_SELECTED is ignored when not in discovering', () => {
    const state: PairingState = { status: 'paired', token: FAKE_TOKEN };
    const next = pairingReducer(state, { type: 'HOST_SELECTED', hostId: 'evil-host' });
    // Same reference — reducer returns state untouched.
    expect(next).toBe(state);
  });

  it('CODE_ISSUED moves requesting → awaiting_approval and records code', () => {
    const next = pairingReducer(
      { status: 'requesting', hostId: 'mock-mac-mini' },
      { type: 'CODE_ISSUED', code: '482915', expiresAt: 1_700_000_000_000 },
    );
    expect(next).toMatchObject({
      status: 'awaiting_approval',
      code: '482915',
      expiresAt: 1_700_000_000_000,
      hostId: 'mock-mac-mini',
    });
  });

  it('CODE_ISSUED is ignored outside requesting', () => {
    const state: PairingState = { status: 'idle' };
    const next = pairingReducer(state, {
      type: 'CODE_ISSUED',
      code: '111111',
      expiresAt: 1,
    });
    expect(next).toBe(state);
  });

  it('APPROVED moves awaiting_approval → paired and carries the token', () => {
    const next = pairingReducer(
      { status: 'awaiting_approval', code: '123456', expiresAt: 1 },
      { type: 'APPROVED', token: FAKE_TOKEN, approved: FAKE_APPROVED },
    );
    expect(next.status).toBe('paired');
    expect(next.token).toEqual(FAKE_TOKEN);
    expect(next.approved).toEqual(FAKE_APPROVED);
    expect(next.code).toBe('123456');
    // P05A: paired state also carries runtimeUrl from PairingApproved so
    // the CopilotKit provider can resume without re-pairing.
    expect(next.runtimeUrl).toBe(FAKE_APPROVED.runtimeUrl);
  });

  it('APPROVED records httpBase when provided', () => {
    const next = pairingReducer(
      { status: 'awaiting_approval', code: '123456', expiresAt: 1 },
      {
        type: 'APPROVED',
        token: FAKE_TOKEN,
        approved: FAKE_APPROVED,
        httpBase: 'http://192.168.1.42:18789',
      },
    );
    expect(next.httpBase).toBe('http://192.168.1.42:18789');
  });

  it('APPROVED is ignored outside awaiting_approval', () => {
    const state: PairingState = { status: 'requesting' };
    const next = pairingReducer(state, {
      type: 'APPROVED',
      token: FAKE_TOKEN,
      approved: FAKE_APPROVED,
    });
    expect(next).toBe(state);
  });

  it('FAILED moves any state to error and records the message', () => {
    for (const start of ['discovering', 'requesting', 'awaiting_approval'] as const) {
      const next = pairingReducer({ status: start }, { type: 'FAILED', error: 'boom' });
      expect(next).toEqual<PairingState>({ status: 'error', error: 'boom' });
    }
  });

  it('RESET clears state from any status, including error and paired', () => {
    expect(pairingReducer({ status: 'error', error: 'x' }, { type: 'RESET' })).toEqual({
      status: 'idle',
    });
    expect(pairingReducer({ status: 'paired', token: FAKE_TOKEN }, { type: 'RESET' })).toEqual({
      status: 'idle',
    });
  });

  it('LOADED_TOKEN jumps directly to paired regardless of starting state', () => {
    const next = pairingReducer({ status: 'idle' }, { type: 'LOADED_TOKEN', token: FAKE_TOKEN });
    expect(next).toEqual<PairingState>({ status: 'paired', token: FAKE_TOKEN });
  });

  it('LOADED_TOKEN carries runtimeUrl + httpBase when present', () => {
    const next = pairingReducer(
      { status: 'idle' },
      {
        type: 'LOADED_TOKEN',
        token: FAKE_TOKEN,
        runtimeUrl: 'http://192.168.1.42:18789/copilot/runtime',
        httpBase: 'http://192.168.1.42:18789',
      },
    );
    expect(next).toEqual<PairingState>({
      status: 'paired',
      token: FAKE_TOKEN,
      runtimeUrl: 'http://192.168.1.42:18789/copilot/runtime',
      httpBase: 'http://192.168.1.42:18789',
    });
  });

  it('walks the full happy path end-to-end', () => {
    let s: PairingState = initialPairingState;
    s = pairingReducer(s, { type: 'START' });
    s = pairingReducer(s, { type: 'HOST_SELECTED', hostId: 'mock-mac-mini' });
    s = pairingReducer(s, { type: 'CODE_ISSUED', code: '482915', expiresAt: 1 });
    s = pairingReducer(s, { type: 'APPROVED', token: FAKE_TOKEN, approved: FAKE_APPROVED });
    expect(s.status).toBe('paired');
    expect(s.token).toEqual(FAKE_TOKEN);
  });
});
