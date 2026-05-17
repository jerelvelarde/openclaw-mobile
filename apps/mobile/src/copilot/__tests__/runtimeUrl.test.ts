// Runtime URL derivation tests.
//
// Pure helpers — small but worth pinning because the URL shape is the
// contract with the desktop adapter (`/copilot/runtime/agent/:id/run`).

import {
  buildRunUrl,
  buildRuntimeHeaders,
  deriveRuntimeUrlFromHttpBase,
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
