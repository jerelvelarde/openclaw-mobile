// Unit tests for the topic-based router.
//
// Covers:
//   - Exact + prefix subscription matching.
//   - `reply` round-tripping through the broadcaster.
//   - Envelope validation in `dispatchRaw`.
//   - Handler errors are isolated (don't tear down the router).
//   - Unsubscribe stops future deliveries.

import { describe, expect, it, vi } from 'vitest';
import { encode } from '@openclaw/protocol';
import { createRouter, type InboundFrame } from '../router';

function frame(topic: string, type: string, payload: unknown): string {
  return encode<unknown>({
    id: 'frame-1',
    topic,
    type,
    payload,
    ts: 1,
  });
}

describe('router.dispatchRaw', () => {
  it('delivers an exact-topic match', async () => {
    const router = createRouter();
    const handler = vi.fn();
    router.subscribe('threads.post', handler);
    const err = router.dispatchRaw(frame('threads.post', 'threads.post', { content: 'hi' }), {
      deviceId: 'd1',
    });
    expect(err).toBeNull();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    const call = handler.mock.calls[0]!;
    const inbound = call[0] as InboundFrame;
    expect(inbound.payload).toEqual({ content: 'hi' });
    expect(call[1].deviceId).toBe('d1');
  });

  it('delivers prefix matches but not non-matches', async () => {
    const router = createRouter();
    const prefixHandler = vi.fn();
    const otherHandler = vi.fn();
    router.subscribe('threads', prefixHandler);
    router.subscribe('agents', otherHandler);

    router.dispatchRaw(frame('threads.list', 'threads.list', {}), { deviceId: 'd' });
    router.dispatchRaw(frame('threads.post', 'threads.post', {}), { deviceId: 'd' });
    await Promise.resolve();

    expect(prefixHandler).toHaveBeenCalledTimes(2);
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without throwing', () => {
    const router = createRouter();
    const err = router.dispatchRaw('not-json', { deviceId: 'd' });
    expect(err).toMatch(/malformed/i);
  });

  it('rejects an envelope missing required fields', () => {
    const router = createRouter();
    const bad = JSON.stringify({ topic: 'agents.list' });
    const err = router.dispatchRaw(bad, { deviceId: 'd' });
    expect(err).toMatch(/envelope/i);
  });

  it('isolates handler errors', async () => {
    const router = createRouter();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    router.subscribe('threads.post', bad);
    router.subscribe('threads.post', good);

    const err = router.dispatchRaw(frame('threads.post', 'threads.post', {}), {
      deviceId: 'd',
    });
    expect(err).toBeNull();
    await Promise.resolve();
    expect(bad).toHaveBeenCalled();
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribe stops further deliveries', async () => {
    const router = createRouter();
    const handler = vi.fn();
    const off = router.subscribe('threads.post', handler);
    off();
    router.dispatchRaw(frame('threads.post', 'threads.post', {}), { deviceId: 'd' });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(router._topics()).not.toContain('threads.post');
  });
});

describe('router.publish / reply', () => {
  it('round-trips replies through the broadcaster', async () => {
    const router = createRouter();
    const out: Array<{ frame: InboundFrame; deviceId?: string }> = [];
    router.setBroadcaster((f, target) => {
      out.push({ frame: f, deviceId: target?.deviceId });
    });

    router.subscribe('agents.list', (_inbound, ctx) => {
      ctx.reply('agents.list.response', { agents: [{ id: 'a', name: 'A' }] });
    });
    router.dispatchRaw(frame('agents.list', 'agents.list', {}), { deviceId: 'phone-1' });
    await Promise.resolve();

    expect(out).toHaveLength(1);
    expect(out[0]!.frame.type).toBe('agents.list.response');
    expect(out[0]!.deviceId).toBe('phone-1');
  });

  it('publish() broadcasts without filtering by deviceId when none is given', () => {
    const router = createRouter();
    const out: Array<{ frame: InboundFrame; deviceId?: string }> = [];
    router.setBroadcaster((f, target) => {
      out.push({ frame: f, deviceId: target?.deviceId });
    });

    router.publish('system.broadcast', 'system.note', { msg: 'hi' });
    expect(out).toHaveLength(1);
    expect(out[0]!.deviceId).toBeUndefined();
  });
});
