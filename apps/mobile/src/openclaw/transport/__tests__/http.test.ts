// HTTP pairing transport tests.
//
// We exercise:
//   - `requestPairing` POSTs the right body + handles the response shape,
//   - `fetchPairStatus` handles `pending`, `approved`, `denied`, and the
//      410-on-expiry server response,
//   - `pollPairingStatus` walks the backoff schedule when the server keeps
//      returning `pending`,
//   - `resolveHttpBase` coerces ws/host-only inputs to `http://host:port`.
//
// All `fetch` calls are stubbed; sleep is replaced with a sync helper that
// resolves immediately so the test isn't timer-bound.

import {
  DEFAULT_GATEWAY_PORT,
  fetchPairStatus,
  pollPairingStatus,
  PAIR_POLL_INTERVALS_MS,
  requestPairing,
  resolveHttpBase,
  toPairingApproved,
  type FetchLike,
  type PairStatusResponse,
} from '../http';

/** Build a `FetchLike` that returns a JSON response with a chosen status. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('requestPairing', () => {
  it('POSTs to /pair/request and returns the issued pair', async () => {
    const fetchImpl: FetchLike = jest.fn(async () =>
      jsonResponse(200, { pair_id: 'p1', code: '482915', expires_at: 1_700_000_000_000 }),
    );
    const res = await requestPairing(
      'http://127.0.0.1:18789',
      { device_name: 'OpenClaw mobile', public_key: 'pk' },
      fetchImpl,
    );
    expect(res).toEqual({ pair_id: 'p1', code: '482915', expires_at: 1_700_000_000_000 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/pair/request',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });

  it('rejects on a malformed body even when the HTTP status is 200', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { code: 'oops' });
    await expect(
      requestPairing('http://x', { device_name: 'd', public_key: 'k' }, fetchImpl),
    ).rejects.toThrow(/Malformed/);
  });

  it('surfaces non-2xx as a regular error with the JSON `error` field', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(400, { error: 'device_name and public_key are required strings' });
    await expect(
      requestPairing('http://x', { device_name: '', public_key: '' }, fetchImpl),
    ).rejects.toThrow(/HTTP 400.*device_name/);
  });
});

describe('fetchPairStatus', () => {
  it('parses an approved response', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, {
        status: 'approved',
        token: 'tok-1',
        runtime_url: 'http://127.0.0.1:18789/copilot/runtime',
      });
    const res = await fetchPairStatus('http://x', 'p1', fetchImpl);
    expect(res).toEqual({
      status: 'approved',
      token: 'tok-1',
      runtime_url: 'http://127.0.0.1:18789/copilot/runtime',
    });
  });

  it('parses a denied response', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { status: 'denied' });
    const res = await fetchPairStatus('http://x', 'p1', fetchImpl);
    expect(res).toEqual({ status: 'denied' });
  });

  it('treats the server 410-on-expiry as a denied response', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(410, { status: 'denied', error: 'expired' });
    const res = await fetchPairStatus('http://x', 'p1', fetchImpl);
    expect(res).toEqual({ status: 'denied', error: 'expired' });
  });
});

describe('pollPairingStatus', () => {
  it('returns the first non-pending response and burns no extra requests', async () => {
    const responses: PairStatusResponse[] = [
      { status: 'approved', token: 't', runtime_url: 'http://x' },
    ];
    let idx = 0;
    const fetchImpl: FetchLike = async () => jsonResponse(200, responses[idx++]);
    const result = await pollPairingStatus('http://x', 'p1', {
      fetchImpl,
      sleep: async () => undefined,
    });
    expect(result.status).toBe('approved');
    expect(idx).toBe(1);
  });

  it('follows the configured interval schedule across pending responses', async () => {
    const responses: PairStatusResponse[] = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved', token: 't', runtime_url: 'http://x' },
    ];
    let idx = 0;
    const fetchImpl: FetchLike = async () => jsonResponse(200, responses[idx++]);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const result = await pollPairingStatus('http://x', 'p1', { fetchImpl, sleep });
    expect(result.status).toBe('approved');
    // Two pending responses → two sleeps, with the first two intervals
    // from PAIR_POLL_INTERVALS_MS.
    expect(sleeps).toEqual([PAIR_POLL_INTERVALS_MS[0], PAIR_POLL_INTERVALS_MS[1]]);
  });

  it('returns denied:deadline_exceeded once `deadlineMs` elapses', async () => {
    let nowValue = 0;
    const now = () => nowValue;
    const fetchImpl: FetchLike = async () => jsonResponse(200, { status: 'pending' });
    const sleep = async (ms: number) => {
      nowValue += ms;
    };
    const result = await pollPairingStatus('http://x', 'p1', {
      fetchImpl,
      sleep,
      now,
      deadlineMs: 100,
    });
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.error).toMatch(/deadline_exceeded/);
    }
  });

  it('honours `maxAttempts` as a hard cap', async () => {
    const fetchImpl: FetchLike = async () => jsonResponse(200, { status: 'pending' });
    const result = await pollPairingStatus('http://x', 'p1', {
      fetchImpl,
      sleep: async () => undefined,
      maxAttempts: 3,
    });
    expect(result.status).toBe('denied');
    if (result.status === 'denied') {
      expect(result.error).toMatch(/max_attempts_exceeded/);
    }
  });
});

describe('toPairingApproved', () => {
  it('builds the protocol PairingApproved envelope from a snake_case status', () => {
    const fixed = 1_700_000_000_000;
    const { approved, token } = toPairingApproved(
      '482915',
      { status: 'approved', token: 't', runtime_url: 'http://x' },
      5_000,
      () => fixed,
    );
    expect(token).toEqual({ value: 't', expiresAt: fixed + 5_000 });
    expect(approved).toEqual({
      code: '482915',
      token: { value: 't', expiresAt: fixed + 5_000 },
      runtimeUrl: 'http://x',
    });
  });
});

describe('resolveHttpBase', () => {
  it('passes through a well-formed http URL with a port', () => {
    expect(resolveHttpBase('http://mac.local:18789')).toBe('http://mac.local:18789');
  });

  it('passes through a well-formed https URL with a port', () => {
    expect(resolveHttpBase('https://example.com:8443')).toBe('https://example.com:8443');
  });

  it('rewrites ws[s]:// to http[s]://', () => {
    expect(resolveHttpBase('ws://mac.local:18789')).toBe('http://mac.local:18789');
    expect(resolveHttpBase('wss://example.com')).toBe(
      `https://example.com:${DEFAULT_GATEWAY_PORT}`,
    );
  });

  it('adds the default port when missing', () => {
    expect(resolveHttpBase('http://mac.local')).toBe(`http://mac.local:${DEFAULT_GATEWAY_PORT}`);
  });

  it('adds the default port to a bare hostname', () => {
    expect(resolveHttpBase('mac.local')).toBe(`http://mac.local:${DEFAULT_GATEWAY_PORT}`);
  });

  it('throws on an empty input', () => {
    expect(() => resolveHttpBase('')).toThrow(/Empty/);
  });
});
