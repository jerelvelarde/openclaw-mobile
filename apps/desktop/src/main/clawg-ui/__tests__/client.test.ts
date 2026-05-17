// clawg-ui HTTP client tests (P11A).
//
// Exercises the three response shapes the plugin can produce against a
// mocked `fetch`:
//   - 403 pairing_pending → persist the new token + return pairing-needed
//   - 401 → unauthorized branch
//   - 2xx text/event-stream → pump SSE frames through onSseEvent + clear
//     any pairing code on the identity record.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClawgUiHeaders, buildClawgUiUrl, postClawgUiRequest } from '../client';
import { openClawgUiIdentityStore } from '../identity';
import { openKeystore, type Keystore } from '../../pair/keystore';

let tmp: string;
let keystore: Keystore;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'openclaw-clawg-ui-client-'));
  keystore = await openKeystore(tmp, 'dev.openclaw.clawg-ui.client.test');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Tiny `Response` shim — Vitest's default Response is fine but the
// async-iterable body shape lets us mirror what fetch returns.
function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('buildClawgUiUrl', () => {
  it('joins the daemon base URL with /v1/clawg-ui', () => {
    expect(buildClawgUiUrl('http://127.0.0.1:18789')).toBe('http://127.0.0.1:18789/v1/clawg-ui');
  });
  it('tolerates a trailing slash', () => {
    expect(buildClawgUiUrl('http://x:1/')).toBe('http://x:1/v1/clawg-ui');
  });
});

describe('buildClawgUiHeaders', () => {
  it('omits Authorization when no device token is set (pairing handshake)', () => {
    const h = buildClawgUiHeaders({ deviceToken: undefined, agentId: 'main' });
    expect(h['Authorization']).toBeUndefined();
    expect(h['X-OpenClaw-Agent-Id']).toBe('main');
    expect(h['Accept']).toBe('text/event-stream');
    expect(h['Content-Type']).toBe('application/json');
  });
  it('adds Authorization: Bearer <token> when present', () => {
    const h = buildClawgUiHeaders({ deviceToken: 'tok.sig', agentId: 'main' });
    expect(h['Authorization']).toBe('Bearer tok.sig');
  });
  it('routes via X-OpenClaw-Agent-Id (default "main")', () => {
    expect(
      buildClawgUiHeaders({ deviceToken: 'tok.sig', agentId: 'hermes' })['X-OpenClaw-Agent-Id'],
    ).toBe('hermes');
  });
  it('forwards a non-empty session key', () => {
    expect(
      buildClawgUiHeaders({
        deviceToken: 't',
        agentId: 'main',
        sessionKey: 'alice@example.com',
      })['X-OpenClaw-Session-Key'],
    ).toBe('alice@example.com');
  });
  it('drops an empty session key', () => {
    expect(
      buildClawgUiHeaders({ deviceToken: 't', agentId: 'main', sessionKey: '' })[
        'X-OpenClaw-Session-Key'
      ],
    ).toBeUndefined();
  });
});

describe('postClawgUiRequest', () => {
  it('handles 403 pairing_pending by persisting the token and returning pairing-needed', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, {
        pairing_code: 'ABCD1234',
        bearer_token:
          'YWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl.deadbeefdeadbeefdeadbeefdeadbeef',
        error: {
          type: 'pairing_pending',
          message: 'Device pending approval',
          pairing: {
            pairingCode: 'ABCD1234',
            token:
              'YWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl.deadbeefdeadbeefdeadbeefdeadbeef',
            instructions: 'openclaw pairing approve clawg-ui ABCD1234',
          },
        },
      }),
    ) as unknown as typeof fetch;
    const result = await postClawgUiRequest({
      baseUrl: 'http://127.0.0.1:18789',
      identityStore,
      host: '127.0.0.1',
      port: 18789,
      deviceToken: undefined,
      agentId: 'main',
      body: { messages: [{ id: 'u', role: 'user', content: 'hi' }] },
      fetchImpl,
    });
    expect(result).toEqual({
      kind: 'pairing-needed',
      pairingCode: 'ABCD1234',
      instructions: 'openclaw pairing approve clawg-ui ABCD1234',
    });
    const persisted = await identityStore.read('127.0.0.1', 18789);
    expect(persisted?.deviceToken).toBe(
      'YWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl.deadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(persisted?.pairingCode).toBe('ABCD1234');
    // POST hit /v1/clawg-ui without an Authorization header.
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    expect(call?.[0]).toBe('http://127.0.0.1:18789/v1/clawg-ui');
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-OpenClaw-Agent-Id']).toBe('main');
  });

  it('returns unauthorized on a 401 response', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, {
        error: { type: 'unauthorized', message: 'bad token' },
      }),
    ) as unknown as typeof fetch;
    const result = await postClawgUiRequest({
      baseUrl: 'http://x:1',
      identityStore,
      host: 'x',
      port: 1,
      deviceToken: 'wrong',
      body: { messages: [] },
      fetchImpl,
    });
    expect(result.kind).toBe('unauthorized');
  });

  it('pipes a 200 SSE response through onSseEvent and clears the pairing code', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    // Seed an identity that's still pending so markApproved has work to do.
    await identityStore.recordPairingPending({
      host: 'h',
      port: 1,
      deviceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      deviceToken: 'tok.sig',
      pairingCode: 'PENDING',
    });
    const captured: unknown[] = [];
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'hi' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
      ]),
    ) as unknown as typeof fetch;
    const result = await postClawgUiRequest({
      baseUrl: 'http://h:1',
      identityStore,
      host: 'h',
      port: 1,
      deviceToken: 'tok.sig',
      agentId: 'main',
      body: { threadId: 't', runId: 'r', messages: [{ id: 'u', role: 'user', content: 'hi' }] },
      fetchImpl,
      onSseEvent: (e) => captured.push(e),
    });
    expect(result).toEqual({ kind: 'ok', status: 200 });
    expect(captured.length).toBe(5);
    expect((captured[0] as { type: string }).type).toBe('RUN_STARTED');
    expect((captured[4] as { type: string }).type).toBe('RUN_FINISHED');
    // The pending pairing code was cleared by markApproved.
    const post = await identityStore.read('h', 1);
    expect(post?.deviceToken).toBe('tok.sig');
    expect(post?.pairingCode).toBeUndefined();
  });

  it('returns http-error for a non-2xx, non-401, non-403 status', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    const fetchImpl = vi.fn(async () =>
      jsonResponse(500, { error: { type: 'server_error', message: 'boom' } }),
    ) as unknown as typeof fetch;
    const result = await postClawgUiRequest({
      baseUrl: 'http://h:1',
      identityStore,
      host: 'h',
      port: 1,
      deviceToken: 'tok.sig',
      body: {},
      fetchImpl,
    });
    expect(result.kind).toBe('http-error');
    if (result.kind === 'http-error') {
      expect(result.status).toBe(500);
      expect(result.body).toContain('boom');
    }
  });

  it('returns http-error for a 403 that is NOT a pairing_pending envelope', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { error: { type: 'forbidden', message: 'nope' } }),
    ) as unknown as typeof fetch;
    const result = await postClawgUiRequest({
      baseUrl: 'http://h:1',
      identityStore,
      host: 'h',
      port: 1,
      deviceToken: 'tok.sig',
      body: {},
      fetchImpl,
    });
    expect(result.kind).toBe('http-error');
  });

  it('passes X-OpenClaw-Session-Key when supplied (trusted-proxy path)', async () => {
    const identityStore = openClawgUiIdentityStore(keystore);
    const fetchImpl = vi.fn(async () => sseResponse([])) as unknown as typeof fetch;
    await postClawgUiRequest({
      baseUrl: 'http://h:1',
      identityStore,
      host: 'h',
      port: 1,
      deviceToken: 'tok.sig',
      sessionKey: 'alice@example.com',
      body: {},
      fetchImpl,
    });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const headers = (call?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-OpenClaw-Session-Key']).toBe('alice@example.com');
  });
});
