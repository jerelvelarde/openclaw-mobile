// Runtime URL derivation tests.
//
// Pure helpers — small but worth pinning because the URL shape is the
// contract with the desktop adapter (`/copilot/runtime/agent/:id/run`).

import {
  buildRunUrl,
  buildRuntimeHeaders,
  deriveRuntimeUrlFromHttpBase,
  resolveRuntimeRequest,
  resolveRuntimeUrl,
} from '../runtimeUrl';

describe('buildRunUrl', () => {
  it('encodes the agent id segment', () => {
    expect(buildRunUrl('http://x:1/copilot/runtime', 'my agent')).toBe(
      'http://x:1/copilot/runtime/agent/my%20agent/run',
    );
  });

  it('preserves dots in agent ids', () => {
    expect(buildRunUrl('http://x:1/copilot/runtime', 'openclaw.default')).toBe(
      'http://x:1/copilot/runtime/agent/openclaw.default/run',
    );
  });

  it('strips trailing slashes from the runtime base', () => {
    expect(buildRunUrl('http://x:1/copilot/runtime/', 'a')).toBe(
      'http://x:1/copilot/runtime/agent/a/run',
    );
  });
});

describe('buildRuntimeHeaders', () => {
  it('attaches the bearer prefix + JSON content type', () => {
    expect(buildRuntimeHeaders('tok_abc')).toEqual({
      Authorization: 'Bearer tok_abc',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    });
  });
});

describe('deriveRuntimeUrlFromHttpBase', () => {
  it('appends the default copilot path', () => {
    expect(deriveRuntimeUrlFromHttpBase('http://192.168.1.42:18789')).toBe(
      'http://192.168.1.42:18789/copilot/runtime',
    );
  });
  it('handles a trailing slash on the base', () => {
    expect(deriveRuntimeUrlFromHttpBase('http://x:1/')).toBe('http://x:1/copilot/runtime');
  });
});

describe('resolveRuntimeUrl', () => {
  it('prefers an explicit runtimeUrl', () => {
    expect(
      resolveRuntimeUrl({
        runtimeUrl: 'http://a/copilot/runtime',
        httpBase: 'http://b',
      }),
    ).toBe('http://a/copilot/runtime');
  });
  it('falls back to httpBase when runtimeUrl is missing', () => {
    expect(resolveRuntimeUrl({ httpBase: 'http://b:1' })).toBe('http://b:1/copilot/runtime');
  });
  it('throws when neither is present', () => {
    expect(() => resolveRuntimeUrl({})).toThrow(/runtimeUrl or httpBase/);
  });
});

// ── P11A: mode-discriminated resolver ─────────────────────────────────────
describe('resolveRuntimeRequest', () => {
  it('p05c mode returns the legacy adapter URL + bearer headers', () => {
    const got = resolveRuntimeRequest({
      mode: 'p05c',
      agentId: 'openclaw.default',
      pairingToken: 'tok_p05',
      runtimeUrl: 'http://192.168.1.42:18789/copilot/runtime',
    });
    expect(got.url).toBe('http://192.168.1.42:18789/copilot/runtime/agent/openclaw.default/run');
    expect(got.headers).toMatchObject({
      Authorization: 'Bearer tok_p05',
      'Content-Type': 'application/json',
    });
    expect(got.headers['X-OpenClaw-Agent-Id']).toBeUndefined();
  });

  it('clawg-ui mode targets POST /v1/clawg-ui with header-based agent routing', () => {
    const got = resolveRuntimeRequest({
      mode: 'clawg-ui',
      agentId: 'hermes',
      clawgUiBaseUrl: 'http://192.168.1.42:18789',
      clawgUiDeviceToken: 'tok.sig',
    });
    expect(got.url).toBe('http://192.168.1.42:18789/v1/clawg-ui');
    expect(got.headers).toMatchObject({
      Authorization: 'Bearer tok.sig',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-OpenClaw-Agent-Id': 'hermes',
    });
    expect(got.url).not.toMatch(/\/agent\//);
  });

  it('clawg-ui mode forwards a valid session key', () => {
    const got = resolveRuntimeRequest({
      mode: 'clawg-ui',
      agentId: 'main',
      clawgUiBaseUrl: 'http://h:1',
      clawgUiDeviceToken: 'tok',
      sessionKey: 'alice@example.com',
    });
    expect(got.headers['X-OpenClaw-Session-Key']).toBe('alice@example.com');
  });

  it('throws if clawg-ui mode is missing the base URL', () => {
    expect(() =>
      resolveRuntimeRequest({
        mode: 'clawg-ui',
        agentId: 'main',
        clawgUiDeviceToken: 'tok',
      }),
    ).toThrow(/clawgUiBaseUrl/);
  });

  it('throws if clawg-ui mode is missing the device token', () => {
    expect(() =>
      resolveRuntimeRequest({
        mode: 'clawg-ui',
        agentId: 'main',
        clawgUiBaseUrl: 'http://h:1',
      }),
    ).toThrow(/clawgUiDeviceToken/);
  });

  it('throws if p05c mode is missing the pairing token', () => {
    expect(() =>
      resolveRuntimeRequest({
        mode: 'p05c',
        agentId: 'a',
        runtimeUrl: 'http://h/copilot/runtime',
      }),
    ).toThrow(/pairingToken/);
  });
});
