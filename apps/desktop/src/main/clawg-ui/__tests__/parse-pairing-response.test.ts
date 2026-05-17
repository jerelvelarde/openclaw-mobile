// Tests for the shared clawg-ui pairing-pending response parser (P11B).

import { describe, expect, it } from 'vitest';
import { parseClawgUiPairingPending } from '../parse-pairing-response';

describe('parseClawgUiPairingPending', () => {
  it('extracts the nested pairing envelope from a 403 body', () => {
    const body = {
      pairing_code: 'IGNOREDFLAT',
      bearer_token: 'IGNOREDTOKEN',
      error: {
        type: 'pairing_pending',
        message: 'Device pending approval',
        pairing: {
          pairingCode: 'ABCD1234',
          token: 'deadbeef.cafebabe',
          instructions: 'Save this token...',
        },
      },
    };
    expect(parseClawgUiPairingPending(403, body)).toEqual({
      pairingCode: 'ABCD1234',
      token: 'deadbeef.cafebabe',
    });
  });

  it('falls back to the flat shape when the nested form is absent', () => {
    const body = {
      pairing_code: 'WXYZ5678',
      bearer_token: 'abc123',
      error: { type: 'pairing_pending', message: 'Device pending approval' },
    };
    expect(parseClawgUiPairingPending(403, body)).toEqual({
      pairingCode: 'WXYZ5678',
      token: 'abc123',
    });
  });

  it('returns null for non-403 status codes', () => {
    const body = {
      error: { type: 'pairing_pending', pairing: { pairingCode: 'A', token: 'B' } },
    };
    expect(parseClawgUiPairingPending(200, body)).toBeNull();
    expect(parseClawgUiPairingPending(401, body)).toBeNull();
  });

  it('returns null for non-pairing 403s', () => {
    const body = { error: { type: 'unauthorized', message: 'Invalid token' } };
    expect(parseClawgUiPairingPending(403, body)).toBeNull();
  });

  it('returns null when both shapes are missing required fields', () => {
    expect(
      parseClawgUiPairingPending(403, {
        error: { type: 'pairing_pending', pairing: { pairingCode: 'A' } },
      }),
    ).toBeNull();
    expect(
      parseClawgUiPairingPending(403, {
        error: { type: 'pairing_pending', pairing: { token: 'B' } },
      }),
    ).toBeNull();
    expect(parseClawgUiPairingPending(403, {})).toBeNull();
  });

  it('returns null for non-object bodies', () => {
    expect(parseClawgUiPairingPending(403, null)).toBeNull();
    expect(parseClawgUiPairingPending(403, 'oops')).toBeNull();
    expect(parseClawgUiPairingPending(403, 42)).toBeNull();
  });
});
