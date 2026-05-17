// Unit tests for the stub in-process gateway.
//
// Confirms that the router subscriptions wired up by `attachStubGateway`
// return the expected shapes: two agents on `agents.list`, the streamed
// reply sequence on `threads.post`, and a canvas surface for the
// trigger phrase. The "real" gateway integration is P05C — this test
// pins the contract mobile codes against in the meantime.

import { describe, expect, it } from 'vitest';
import { encode } from '@openclaw/protocol';
import { createRouter, type InboundFrame } from '../../transport/router';
import { attachStubGateway } from '../__fixtures__/stub';

function frame(topic: string, type: string, payload: unknown): string {
  return encode<unknown>({
    id: `f_${topic}_${type}`,
    topic,
    type,
    payload,
    ts: 1,
  });
}

function setupCapture() {
  const router = createRouter();
  const captured: InboundFrame[] = [];
  router.setBroadcaster((f) => {
    captured.push(f);
  });
  return { router, captured };
}

describe('stub gateway', () => {
  it('returns two agents on agents.list', async () => {
    const { router, captured } = setupCapture();
    const stub = attachStubGateway(router, { replyDelayMs: 0 });
    router.dispatchRaw(frame('agents.list', 'agents.list', {}), { deviceId: 'd' });
    await new Promise<void>((r) => queueMicrotask(r));

    expect(captured).toHaveLength(1);
    const reply = captured[0]!;
    expect(reply.type).toBe('agents.list.response');
    const payload = reply.payload as { agents: Array<{ id: string }> };
    expect(payload.agents).toHaveLength(2);
    expect(payload.agents.map((a) => a.id)).toEqual(['openclaw.default', 'hermes']);
    stub.detach();
  });

  it('emits the streamed reply sequence on threads.post', async () => {
    const { router, captured } = setupCapture();
    attachStubGateway(router, { replyDelayMs: 0 });
    router.dispatchRaw(
      frame('threads.post', 'threads.post', {
        threadId: 't-1',
        content: 'hello',
      }),
      { deviceId: 'd' },
    );

    // The user-message ack lands synchronously; the streamed reply lands
    // on a microtask. Drain both.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    const types = captured.map((f) => {
      const p = f.payload as { type?: string };
      return f.type === 'threads.event' ? (p.type ?? '') : f.type;
    });
    // Expected order: ack message, streamed message, token delta,
    // tool_call, done. No canvas surface (no trigger phrase).
    expect(types).toEqual(['message', 'message', 'token', 'tool_call', 'done']);
  });

  it('emits a canvas surface when the trigger phrase appears', async () => {
    const { router, captured } = setupCapture();
    const stub = attachStubGateway(router, { replyDelayMs: 0 });
    router.dispatchRaw(
      frame('threads.post', 'threads.post', {
        threadId: 't-2',
        content: 'please show a canvas now',
      }),
      { deviceId: 'd' },
    );
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    const canvasFrames = captured.filter((f) => f.type === 'canvas.surface');
    expect(canvasFrames).toHaveLength(1);
    stub.detach();
  });

  it('responds to system.ping with system.pong', async () => {
    const { router, captured } = setupCapture();
    attachStubGateway(router, { replyDelayMs: 0 });
    router.dispatchRaw(frame('system.ping', 'system.ping', {}), { deviceId: 'd' });
    await new Promise<void>((r) => queueMicrotask(r));
    const pong = captured.find((f) => f.type === 'system.pong');
    expect(pong).toBeDefined();
  });

  it('detach() removes every subscription', () => {
    const router = createRouter();
    const stub = attachStubGateway(router);
    expect(router._topics().length).toBeGreaterThan(0);
    stub.detach();
    expect(router._topics()).toHaveLength(0);
  });

  it('emits a canned transcript + PCM16 reply clip on a voice offer (P07B)', async () => {
    const { router, captured } = setupCapture();
    attachStubGateway(router, { replyDelayMs: 0, voiceReplyDelayMs: 0 });

    router.dispatchRaw(
      frame('voice.s1.signal', 'voice.signal', { type: 'offer', sdp: 'v=0\nphone-offer' }),
      { deviceId: 'phone-1' },
    );
    // Two microtask drains: one for dispatch, one for the queued canned reply.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    const transcript = captured.find(
      (f) => f.topic === 'voice.s1.transcript' && f.type === 'voice.transcript',
    );
    expect(transcript).toBeDefined();
    const tp = transcript!.payload as { text: string; isFinal: boolean };
    expect(tp.isFinal).toBe(true);
    expect(tp.text.length).toBeGreaterThan(0);

    // The synthetic reply emits 20 frames of 10ms PCM16 each.
    const replyFrames = captured.filter(
      (f) => f.topic === 'voice.s1.frame' && f.type === 'voice.frame.reply',
    );
    expect(replyFrames).toHaveLength(20);
    const wire = replyFrames[0]!.payload as { samples: number[]; sampleRate: number };
    expect(wire.sampleRate).toBe(16_000);
    expect(wire.samples).toHaveLength(160); // 16kHz / 100Hz frames = 160 samples.
    // Samples are signed 16-bit ints — confirm shape, not exact values.
    expect(wire.samples.every((s) => Number.isInteger(s) && s >= -32_768 && s <= 32_767)).toBe(
      true,
    );
  });

  it('does not re-fire the voice reply on subsequent ICE candidates', async () => {
    const { router, captured } = setupCapture();
    attachStubGateway(router, { replyDelayMs: 0, voiceReplyDelayMs: 0 });

    router.dispatchRaw(
      frame('voice.s2.signal', 'voice.signal', { type: 'offer', sdp: 'v=0\noffer' }),
      { deviceId: 'p' },
    );
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    const before = captured.length;

    // A flood of ICE candidates shouldn't re-trigger the canned reply.
    for (let i = 0; i < 5; i += 1) {
      router.dispatchRaw(
        frame('voice.s2.signal', 'voice.signal', { type: 'ice', candidate: `cand:${i}` }),
        { deviceId: 'p' },
      );
    }
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(captured.length).toBe(before);
  });
});
