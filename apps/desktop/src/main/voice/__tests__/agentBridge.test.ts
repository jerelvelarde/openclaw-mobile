// Unit tests for `voice/agentBridge.ts`.
//
// The bridge sits between a `VoicePeer` and the shared envelope router.
// We mock the peer (just need `pushReplyFrame` + `close` + `sessionId`)
// and drive the router directly — that's enough to assert the
// publish/subscribe contract end-to-end:
//
//   - inbound audio → `router.publish` on `voice.<sid>.frame` w/ type
//     `voice.frame` and the same PCM16 bytes
//   - agent `voice.frame.reply` → `peer.pushReplyFrame` with the same
//     bytes back

import { describe, expect, it, vi } from 'vitest';
import { encode } from '@openclaw/protocol';
import { createRouter, type InboundFrame } from '../../transport/router';
import {
  createAgentBridge,
  VOICE_FRAME_REPLY_TYPE,
  VOICE_FRAME_TYPE,
  type VoiceFrameWire,
} from '../agentBridge';
import type { AudioFrame, VoicePeer } from '../peer';

function fakePeer(): VoicePeer & { _replies: AudioFrame[] } {
  const replies: AudioFrame[] = [];
  return {
    schemaVersion: 1,
    sessionId: 's1',
    _replies: replies,
    applySignal: async () => {
      /* no-op */
    },
    pushReplyFrame: (f) => replies.push(f),
    close: async () => {
      /* no-op */
    },
    state: () => ({ signaling: 'stable', connection: 'new', hasInboundTrack: false }),
    _peer: () => ({}) as never,
  };
}

function captureRouter() {
  const router = createRouter();
  const out: Array<{ frame: InboundFrame; deviceId?: string }> = [];
  router.setBroadcaster((f, t) => out.push({ frame: f, deviceId: t?.deviceId }));
  return { router, out };
}

describe('agentBridge', () => {
  it('forwards inbound audio onto voice.<sid>.frame with type voice.frame', () => {
    const { router, out } = captureRouter();
    const peer = fakePeer();
    const bridge = createAgentBridge({ sessionId: 'sx', deviceId: 'phone-1', router, peer });

    const audio: AudioFrame = {
      samples: Int16Array.from([1, 2, 3, 4]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 4,
    };
    bridge.handleInboundAudio(audio);

    expect(out).toHaveLength(1);
    const env = out[0]!.frame;
    expect(env.topic).toBe('voice.sx.frame');
    expect(env.type).toBe(VOICE_FRAME_TYPE);
    expect(out[0]!.deviceId).toBe('phone-1');
    const wire = env.payload as VoiceFrameWire;
    expect(wire.seq).toBe(0);
    expect(wire.format).toBe('pcm16');
    expect(wire.sampleRate).toBe(16_000);
    expect(wire.samples).toEqual([1, 2, 3, 4]);

    // Second call increments seq.
    bridge.handleInboundAudio(audio);
    const wire2 = out[1]!.frame.payload as VoiceFrameWire;
    expect(wire2.seq).toBe(1);

    expect(bridge._outboundCount()).toBe(2);
    bridge.detach();
  });

  it('round-trips inbound bytes unchanged through publish', () => {
    const { router, out } = captureRouter();
    const peer = fakePeer();
    const bridge = createAgentBridge({ sessionId: 'sy', deviceId: 'd', router, peer });

    const samples = [10, -20, 30, -40, 0];
    bridge.handleInboundAudio({
      samples: Int16Array.from(samples),
      sampleRate: 48_000,
      channelCount: 1,
      numberOfFrames: samples.length,
    });

    // `router.publish` invokes the broadcaster directly (the WS server's
    // fan-out hook); it does not dispatch to in-process subscriptions.
    // Bytes-in, bytes-out is therefore observed via the broadcaster.
    const audioOut = out.filter((o) => o.frame.type === VOICE_FRAME_TYPE);
    expect(audioOut).toHaveLength(1);
    const wire = audioOut[0]!.frame.payload as VoiceFrameWire;
    expect(wire.samples).toEqual(samples);
    expect(wire.sampleRate).toBe(48_000);
    expect(wire.numberOfFrames).toBe(samples.length);
    bridge.detach();
  });

  it('pulls voice.frame.reply onto peer.pushReplyFrame', () => {
    const { router } = captureRouter();
    const peer = fakePeer();
    const bridge = createAgentBridge({ sessionId: 'sz', deviceId: 'd', router, peer });

    const reply: VoiceFrameWire = {
      seq: 0,
      format: 'pcm16',
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 3,
      samples: [100, 200, 300],
    };

    // Simulate the stub agent publishing a reply frame.
    router.dispatchRaw(
      encode({
        id: 'r1',
        topic: 'voice.sz.frame',
        type: VOICE_FRAME_REPLY_TYPE,
        payload: reply,
        ts: 1,
      }),
      { deviceId: 'agent' },
    );

    expect(peer._replies).toHaveLength(1);
    expect(Array.from(peer._replies[0]!.samples)).toEqual([100, 200, 300]);
    expect(peer._replies[0]!.sampleRate).toBe(16_000);
    expect(bridge._replyCount()).toBe(1);

    bridge.detach();
  });

  it('does not loop our own voice.frame publishes back to the peer', () => {
    const { router } = captureRouter();
    const peer = fakePeer();
    const bridge = createAgentBridge({ sessionId: 'loop', deviceId: 'd', router, peer });

    bridge.handleInboundAudio({
      samples: Int16Array.from([7]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 1,
    });

    // We published `voice.frame` on `voice.loop.frame` — the bridge
    // should ignore it because the discriminator is wrong.
    expect(peer._replies).toHaveLength(0);
    bridge.detach();
  });

  it('detach() stops further reply forwarding', () => {
    const { router } = captureRouter();
    const peer = fakePeer();
    const bridge = createAgentBridge({ sessionId: 'det', deviceId: 'd', router, peer });
    bridge.detach();

    router.dispatchRaw(
      encode({
        id: 'r2',
        topic: 'voice.det.frame',
        type: VOICE_FRAME_REPLY_TYPE,
        payload: {
          seq: 0,
          format: 'pcm16',
          sampleRate: 16_000,
          channelCount: 1,
          numberOfFrames: 1,
          samples: [9],
        } satisfies VoiceFrameWire,
        ts: 1,
      }),
      { deviceId: 'agent' },
    );
    expect(peer._replies).toHaveLength(0);
  });

  it('handles malformed reply payloads without throwing', () => {
    const { router } = captureRouter();
    const peer = fakePeer();
    const replySpy = vi.spyOn(peer, 'pushReplyFrame');
    createAgentBridge({ sessionId: 'bad', deviceId: 'd', router, peer });

    router.dispatchRaw(
      encode({
        id: 'r3',
        topic: 'voice.bad.frame',
        type: VOICE_FRAME_REPLY_TYPE,
        payload: { seq: 'not a number' },
        ts: 1,
      }),
      { deviceId: 'agent' },
    );
    expect(replySpy).not.toHaveBeenCalled();
  });
});
