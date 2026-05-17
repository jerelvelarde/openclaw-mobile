// URL + header assembly tests for the clawg-ui request shape (P11A).
//
// These pin the wire contract with the user's `openclaw gateway` daemon
// running the `@contextableai/clawg-ui` plugin (vendored at
// `vendor/clawg-ui/` @ v0.7.0). If you need to change a value here,
// double-check `vendor/clawg-ui/src/http-handler.ts:221–348` first.

import {
  buildClawgUiHeaders,
  buildClawgUiRequest,
  buildClawgUiUrl,
  CLAWG_UI_PATH,
  DEFAULT_CLAWG_UI_AGENT_ID,
  SESSION_KEY_RE,
} from '../clawgUiUrl';

describe('buildClawgUiUrl', () => {
  it('appends /v1/clawg-ui to the daemon base URL', () => {
    expect(buildClawgUiUrl('http://192.168.1.42:18789')).toBe(
      'http://192.168.1.42:18789/v1/clawg-ui',
    );
  });
  it('tolerates a trailing slash on the base', () => {
    expect(buildClawgUiUrl('http://x:1/')).toBe('http://x:1/v1/clawg-ui');
  });
  it('uses the same path constant the README cites', () => {
    expect(CLAWG_UI_PATH).toBe('/v1/clawg-ui');
  });
});

describe('buildClawgUiHeaders', () => {
  it('attaches Bearer auth + JSON + SSE accept + agent id', () => {
    expect(buildClawgUiHeaders({ deviceToken: 'tok', agentId: 'main' })).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-OpenClaw-Agent-Id': 'main',
    });
  });
  it('defaults agent id to "main"', () => {
    const h = buildClawgUiHeaders({ deviceToken: 'tok' });
    expect(h['X-OpenClaw-Agent-Id']).toBe(DEFAULT_CLAWG_UI_AGENT_ID);
    expect(h['X-OpenClaw-Agent-Id']).toBe('main');
  });
  it('forwards a non-default agent id', () => {
    expect(
      buildClawgUiHeaders({ deviceToken: 't', agentId: 'hermes' })['X-OpenClaw-Agent-Id'],
    ).toBe('hermes');
  });
  it('adds a valid session key when supplied', () => {
    expect(
      buildClawgUiHeaders({ deviceToken: 't', sessionKey: 'alice@example.com' })[
        'X-OpenClaw-Session-Key'
      ],
    ).toBe('alice@example.com');
  });
  it('drops an invalid session key silently', () => {
    expect(
      buildClawgUiHeaders({ deviceToken: 't', sessionKey: '../escape' })['X-OpenClaw-Session-Key'],
    ).toBeUndefined();
  });
  it('drops an oversize session key silently', () => {
    expect(
      buildClawgUiHeaders({
        deviceToken: 't',
        sessionKey: 'a'.repeat(257),
      })['X-OpenClaw-Session-Key'],
    ).toBeUndefined();
  });
});

describe('SESSION_KEY_RE', () => {
  it('accepts alphanumerics + . _ @ : -', () => {
    expect(SESSION_KEY_RE.test('alice@example.com:42')).toBe(true);
    expect(SESSION_KEY_RE.test('user-1.profile_v2')).toBe(true);
  });
  it('rejects path traversal + slashes + spaces', () => {
    expect(SESSION_KEY_RE.test('../escape')).toBe(false);
    expect(SESSION_KEY_RE.test('with spaces')).toBe(false);
    expect(SESSION_KEY_RE.test('a/b')).toBe(false);
    expect(SESSION_KEY_RE.test('a\\b')).toBe(false);
    expect(SESSION_KEY_RE.test('a\0b')).toBe(false);
  });
  it('rejects empty strings + values over 256 chars', () => {
    expect(SESSION_KEY_RE.test('')).toBe(false);
    expect(SESSION_KEY_RE.test('a'.repeat(257))).toBe(false);
  });
});

describe('buildClawgUiRequest', () => {
  it('bundles URL + headers for the production happy path', () => {
    const req = buildClawgUiRequest({
      baseUrl: 'http://192.168.1.42:18789',
      deviceToken: 'tok.sig',
      agentId: 'main',
    });
    expect(req.url).toBe('http://192.168.1.42:18789/v1/clawg-ui');
    expect(req.headers).toMatchObject({
      Authorization: 'Bearer tok.sig',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-OpenClaw-Agent-Id': 'main',
    });
  });
  it('exposes the X-OpenClaw-Agent-Id header (not URL path) for agent routing', () => {
    // Smoke-test that the headers carry the agent — the URL must NOT
    // include an /agent/:id segment, which is the P05C adapter's
    // convention (now stub-only).
    const req = buildClawgUiRequest({
      baseUrl: 'http://h:1',
      deviceToken: 't',
      agentId: 'special-agent',
    });
    expect(req.url).not.toMatch(/\/agent\//);
    expect(req.headers['X-OpenClaw-Agent-Id']).toBe('special-agent');
  });
  it('omits X-OpenClaw-Session-Key when not supplied', () => {
    expect(
      buildClawgUiRequest({ baseUrl: 'http://h:1', deviceToken: 't' }).headers[
        'X-OpenClaw-Session-Key'
      ],
    ).toBeUndefined();
  });
  it('passes a valid session key through', () => {
    expect(
      buildClawgUiRequest({
        baseUrl: 'http://h:1',
        deviceToken: 't',
        sessionKey: 'alice@example.com',
      }).headers['X-OpenClaw-Session-Key'],
    ).toBe('alice@example.com');
  });
});
