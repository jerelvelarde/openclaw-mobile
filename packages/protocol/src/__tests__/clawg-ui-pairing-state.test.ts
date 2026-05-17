// Tests for the `ClawgUiPairingState` shared shape (P11B).
//
// Coverage:
//  - Each discriminator variant round-trips through the Zod schema.
//  - Malformed payloads (invalid pairingCode, missing fields, unknown
//    status) produce a Zod error, so a mismatched-version desktop can't
//    push a payload that crashes a mobile parser.
//  - The exported topic constant matches the agreed wire string so the
//    desktop broadcaster + mobile subscriber can't drift.

import { describe, expect, it } from 'vitest';

import {
  CLAWG_UI_PAIRING_STATE_TOPIC,
  ClawgUiPairingStateSchema,
  type ClawgUiPairingState,
} from '../index';

describe('ClawgUiPairingStateSchema (P11B)', () => {
  it('round-trips each variant', () => {
    const variants: ClawgUiPairingState[] = [
      { status: 'idle' },
      { status: 'pending', pairingCode: 'ABCD1234' },
      { status: 'approved' },
      { status: 'denied' },
      { status: 'denied', reason: 'user dismissed' },
      { status: 'error', message: 'openclaw binary not found on PATH' },
    ];
    for (const v of variants) {
      const parsed = ClawgUiPairingStateSchema.parse(v);
      expect(parsed).toEqual(v);
    }
  });

  it('rejects a pending state without a pairingCode', () => {
    expect(() => ClawgUiPairingStateSchema.parse({ status: 'pending' })).toThrow();
  });

  it('rejects a pending state with an unsupported pairingCode shape', () => {
    expect(() =>
      ClawgUiPairingStateSchema.parse({ status: 'pending', pairingCode: 'has space' }),
    ).toThrow();
    expect(() => ClawgUiPairingStateSchema.parse({ status: 'pending', pairingCode: '' })).toThrow();
  });

  it('rejects an unknown status', () => {
    expect(() => ClawgUiPairingStateSchema.parse({ status: 'unknown' })).toThrow();
  });

  it('rejects an error variant without a message', () => {
    expect(() => ClawgUiPairingStateSchema.parse({ status: 'error' })).toThrow();
  });

  it('exposes the agreed broadcast topic name', () => {
    expect(CLAWG_UI_PAIRING_STATE_TOPIC).toBe('system:clawg-ui-pairing-state');
  });
});
