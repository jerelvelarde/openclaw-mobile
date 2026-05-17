// Smoke tests for the Bonjour publisher.
//
// We can't reliably exercise actual mDNS in CI (the dev container has
// no multicast capability), so these tests focus on the lifecycle
// contract — start/stop are idempotent, errors land in `state` rather
// than as uncaught exceptions, and the published service (when
// available) carries our id/version TXT data.

import { describe, expect, it } from 'vitest';
import { createBonjourPublisher } from '../bonjour';

describe('Bonjour publisher', () => {
  it('starts in `idle` state', () => {
    const pub = createBonjourPublisher({
      gatewayId: 'gw',
      version: '0.0.0-test',
      port: 0,
      hostname: 'test-host',
    });
    expect(pub.state).toBe('idle');
    expect(pub.service).toBeNull();
  });

  it('start() transitions to either `advertising` or `error` without throwing', async () => {
    const pub = createBonjourPublisher({
      gatewayId: 'gw',
      version: '0.0.0-test',
      port: 0,
      hostname: 'test-host',
    });
    const state = pub.start();
    expect(['advertising', 'error']).toContain(state);
    if (state === 'advertising') {
      const svc = pub.service;
      expect(svc).not.toBeNull();
      expect(svc?.name).toMatch(/OpenClaw \(test-host\)/);
      const txt = svc?.txt as Record<string, string> | undefined;
      expect(txt?.gateway_id).toBe('gw');
      expect(txt?.version).toBe('0.0.0-test');
    } else {
      expect(pub.lastError).toBeInstanceOf(Error);
    }
    await pub.stop();
    expect(pub.state).toBe('idle');
  });

  it('start()/stop() are idempotent', async () => {
    const pub = createBonjourPublisher({
      gatewayId: 'gw',
      version: '0.0.0-test',
      port: 0,
      hostname: 'test-host',
    });
    pub.start();
    pub.start();
    expect(['advertising', 'error']).toContain(pub.state);
    await pub.stop();
    await pub.stop();
    expect(pub.state).toBe('idle');
  });
});
