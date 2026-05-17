// Tests for the renderer-side 403 pairing-pending sniffer (Wave 15
// Fix 1). Exercises the IPC contract end-to-end: a mocked
// `fetch` returns a `403 pairing_pending` body, and the sniffer must
// call `window.api.clawgUi.notifyPending(...)` with the parsed
// `{ pairingCode, token, host, port }` payload.

import { describe, expect, it, vi } from 'vitest';
import { clawgUiFetch, parseBaseUrl, parsePairingPendingBody } from '../pairingSniffer';

function makeFetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('parsePairingPendingBody', () => {
  it('extracts the nested envelope', () => {
    expect(
      parsePairingPendingBody({
        error: {
          type: 'pairing_pending',
          pairing: { pairingCode: 'ABCD1234', token: 'tok.sig' },
        },
      }),
    ).toEqual({ pairingCode: 'ABCD1234', token: 'tok.sig', instructions: undefined });
  });

  it('falls back to the flat shape', () => {
    expect(
      parsePairingPendingBody({
        pairing_code: 'XY12',
        bearer_token: 'flat.sig',
        error: { type: 'pairing_pending' },
      }),
    ).toEqual({ pairingCode: 'XY12', token: 'flat.sig', instructions: undefined });
  });

  it('returns null on a non-pairing error', () => {
    expect(parsePairingPendingBody({ error: { type: 'unauthorized' } })).toBeNull();
  });

  it('returns null on empty / non-object bodies', () => {
    expect(parsePairingPendingBody(null)).toBeNull();
    expect(parsePairingPendingBody('oops')).toBeNull();
  });
});

describe('parseBaseUrl', () => {
  it('returns the host + explicit port', () => {
    expect(parseBaseUrl('http://127.0.0.1:18789')).toEqual({ host: '127.0.0.1', port: 18789 });
  });

  it('defaults to 18789 when the port is omitted on http', () => {
    expect(parseBaseUrl('http://gateway.local')).toEqual({ host: 'gateway.local', port: 18789 });
  });

  it('defaults to 443 on https without a port', () => {
    expect(parseBaseUrl('https://gateway.example.com')).toEqual({
      host: 'gateway.example.com',
      port: 443,
    });
  });

  it('returns zero values on garbage input', () => {
    expect(parseBaseUrl('not-a-url')).toEqual({ host: '', port: 0 });
  });
});

describe('clawgUiFetch', () => {
  it('POSTs to <baseUrl>/v1/clawg-ui with the documented headers', async () => {
    const fetchFake = makeFetchReturning(200, 'ok');
    await clawgUiFetch('http://gw:18789', {
      body: { hello: 'world' },
      deviceToken: 'tok.sig',
      agentId: 'main',
      fetchImpl: fetchFake,
      getBridge: () => null,
    });
    expect(fetchFake).toHaveBeenCalledTimes(1);
    const call = (fetchFake as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toBe('http://gw:18789/v1/clawg-ui');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok.sig');
    expect(headers['X-OpenClaw-Agent-Id']).toBe('main');
    expect(headers['Accept']).toBe('text/event-stream');
    expect(init.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('omits Authorization when no token is supplied (pairing handshake)', async () => {
    const fetchFake = makeFetchReturning(200, 'ok');
    await clawgUiFetch('http://gw:18789', {
      body: {},
      fetchImpl: fetchFake,
      getBridge: () => null,
    });
    const call = (fetchFake as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('on 403 pairing_pending: parses the body and calls notifyPending over IPC', async () => {
    const fetchFake = makeFetchReturning(403, {
      error: {
        type: 'pairing_pending',
        pairing: { pairingCode: 'ABCD1234', token: 'tok.sig' },
      },
    });
    const notifyPending = vi.fn(async () => true);
    const res = await clawgUiFetch('http://gw:18789', {
      body: {},
      fetchImpl: fetchFake,
      getBridge: () => ({ notifyPending }),
    });
    expect(res.status).toBe(403);
    expect(notifyPending).toHaveBeenCalledTimes(1);
    expect(notifyPending).toHaveBeenCalledWith({
      pairingCode: 'ABCD1234',
      token: 'tok.sig',
      host: 'gw',
      port: 18789,
    });
  });

  it('on 403 non-pending: does NOT call notifyPending', async () => {
    const fetchFake = makeFetchReturning(403, {
      error: { type: 'unauthorized', message: 'bad token' },
    });
    const notifyPending = vi.fn(async () => true);
    await clawgUiFetch('http://gw:18789', {
      body: {},
      deviceToken: 'rotated.tok',
      fetchImpl: fetchFake,
      getBridge: () => ({ notifyPending }),
    });
    expect(notifyPending).not.toHaveBeenCalled();
  });

  it('does not throw if the IPC bridge is missing (jsdom smoke path)', async () => {
    const fetchFake = makeFetchReturning(403, {
      error: { type: 'pairing_pending', pairing: { pairingCode: 'C', token: 't' } },
    });
    await expect(
      clawgUiFetch('http://gw:18789', {
        body: {},
        fetchImpl: fetchFake,
        getBridge: () => null,
      }),
    ).resolves.toBeInstanceOf(Response);
  });

  it('swallows an IPC error so the caller can still surface the 403', async () => {
    const fetchFake = makeFetchReturning(403, {
      error: { type: 'pairing_pending', pairing: { pairingCode: 'A', token: 't' } },
    });
    const notifyPending = vi.fn(async () => {
      throw new Error('boom');
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await clawgUiFetch('http://gw:18789', {
      body: {},
      fetchImpl: fetchFake,
      getBridge: () => ({ notifyPending }),
    });
    expect(res.status).toBe(403);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
