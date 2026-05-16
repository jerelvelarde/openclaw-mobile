// Unit tests for `voice/router.ts`.
//
// We exercise the full signaling + lifecycle paths with mock WebRTC
// ctors. The voice router is the public entry point a real agent would
// integrate against, so this test acts as a behavioural contract for
// the canned-reply stub in P07B + the future real OpenClaw voice
// runtime.

import { describe, expect, it, vi } from 'vitest';
import { encode } from '@openclaw/protocol';
import { createRouter as createEnvelopeRouter, type InboundFrame } from '../../transport/router';
import { createVoiceRouter, parseVoiceTopic } from '../router';
import type {
  AudioFrame,
  AudioSinkCtor,
  AudioSourceCtor,
  PeerCtor,
  PeerLike,
  TrackLike,
} from '../peer';

// ── Mock WebRTC ctors (duplicated from peer.test.ts intentionally; the
// two files exercise different surface area and copying ~60 lines keeps
// each test self-contained).

interface MockPeer extends PeerLike {
  _emitTrack(track: TrackLike): void;
  _emitState(state: string): void;
  _calls: { closed: boolean };
}

function mockTrack(): TrackLike {
  return { kind: 'audio', id: `t_${Math.random()}`, stop: vi.fn() };
}

function makeDeps() {
  const instances: MockPeer[] = [];
  class Pc implements MockPeer {
    signalingState = 'stable';
    connectionState = 'new';
    ontrack: PeerLike['ontrack'] = null;
    onicecandidate: PeerLike['onicecandidate'] = null;
    oniceconnectionstatechange: PeerLike['oniceconnectionstatechange'] = null;
    onconnectionstatechange: PeerLike['onconnectionstatechange'] = null;
    localDescription: PeerLike['localDescription'] = null;
    remoteDescription: PeerLike['remoteDescription'] = null;
    _calls = { closed: false };
    constructor() {
      instances.push(this);
    }
    addTransceiver(): unknown {
      return {};
    }
    async setRemoteDescription(d: { type: string; sdp?: string }): Promise<void> {
      this.remoteDescription = d;
    }
    async setLocalDescription(d?: { type: string; sdp?: string }): Promise<void> {
      this.localDescription = d ?? { type: 'answer', sdp: 'v=0\nlocal' };
    }
    async createOffer(): Promise<{ type: string; sdp?: string }> {
      return { type: 'offer', sdp: 'v=0\nmock-offer' };
    }
    async createAnswer(): Promise<{ type: string; sdp?: string }> {
      return { type: 'answer', sdp: 'v=0\nmock-answer' };
    }
    async addIceCandidate(): Promise<void> {
      /* no-op */
    }
    addTrack(): unknown {
      return {};
    }
    removeTrack(): void {
      /* no-op */
    }
    close(): void {
      this._calls.closed = true;
      this.connectionState = 'closed';
    }
    _emitTrack(track: TrackLike): void {
      this.ontrack?.({ track });
    }
    _emitState(state: string): void {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
  }
  interface SinkHandle {
    track: TrackLike;
    ondata: ((d: AudioFrame) => void) | null;
    stopped: boolean;
  }
  const sinkHandles: SinkHandle[] = [];
  class Sink {
    private _handle: SinkHandle;
    set ondata(fn: ((d: AudioFrame) => void) | null) {
      this._handle.ondata = fn;
    }
    constructor(track: TrackLike) {
      const handle: SinkHandle = { track, ondata: null, stopped: false };
      this._handle = handle;
      sinkHandles.push(handle);
    }
    stop(): void {
      this._handle.stopped = true;
    }
  }
  class Source {
    private _track = mockTrack();
    createTrack(): TrackLike {
      return this._track;
    }
    onData(): void {
      /* no-op */
    }
  }
  return {
    deps: {
      PeerConnection: Pc as unknown as PeerCtor,
      AudioSink: Sink as unknown as AudioSinkCtor,
      AudioSource: Source as unknown as AudioSourceCtor,
    },
    instances,
    getLastSink: (): SinkHandle | null => sinkHandles[sinkHandles.length - 1] ?? null,
  };
}

function frame(topic: string, type: string, payload: unknown): string {
  return encode({ id: `f_${type}_${Math.random()}`, topic, type, payload, ts: 1 });
}

describe('parseVoiceTopic', () => {
  it('splits well-formed topics', () => {
    expect(parseVoiceTopic('voice.abc123.signal')).toEqual({ sessionId: 'abc123', sub: 'signal' });
    expect(parseVoiceTopic('voice.s1.frame')).toEqual({ sessionId: 's1', sub: 'frame' });
  });

  it('rejects malformed topics', () => {
    expect(parseVoiceTopic('voice.')).toBeNull();
    expect(parseVoiceTopic('voice.onlysession')).toBeNull();
    expect(parseVoiceTopic('threads.s1.signal')).toBeNull();
    expect(parseVoiceTopic('voice..signal')).toBeNull();
  });
});

describe('voice/router signaling lifecycle', () => {
  it('creates a session on the first offer and answers it', async () => {
    const env = createEnvelopeRouter();
    const out: Array<{ frame: InboundFrame; deviceId?: string }> = [];
    env.setBroadcaster((f, t) => out.push({ frame: f, deviceId: t?.deviceId }));

    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    expect(voice.sessions.size).toBe(0);

    env.dispatchRaw(
      frame('voice.sx.signal', 'voice.signal', { type: 'offer', sdp: 'v=0\nphone-offer' }),
      { deviceId: 'phone-1' },
    );
    // applySignal is async — settle.
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(voice.sessions.size).toBe(1);
    expect(voice.sessions.has('sx')).toBe(true);
    expect(instances).toHaveLength(1);

    // The router should have published an `answer` signal scoped to the
    // originating device.
    const answer = out.find(
      (f) =>
        f.frame.topic === 'voice.sx.signal' &&
        f.frame.type === 'voice.signal' &&
        (f.frame.payload as { type: string }).type === 'answer',
    );
    expect(answer).toBeDefined();
    expect(answer!.deviceId).toBe('phone-1');

    expect(voice._createdCount()).toBe(1);
    await voice.close();
  });

  it('routes subsequent ICE candidates to the same session', async () => {
    const env = createEnvelopeRouter();
    env.setBroadcaster(() => {
      /* no-op */
    });
    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    env.dispatchRaw(frame('voice.s2.signal', 'voice.signal', { type: 'offer', sdp: 'v=0' }), {
      deviceId: 'p',
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    env.dispatchRaw(
      frame('voice.s2.signal', 'voice.signal', { type: 'ice', candidate: 'cand:1' }),
      { deviceId: 'p' },
    );
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(voice.sessions.size).toBe(1);
    expect(instances).toHaveLength(1);
    await voice.close();
  });

  it('forwards inbound audio onto voice.<sid>.frame', async () => {
    const env = createEnvelopeRouter();
    const captured: InboundFrame[] = [];
    env.setBroadcaster((f) => captured.push(f));

    const { deps, instances, getLastSink } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    env.dispatchRaw(
      frame('voice.audiosx.signal', 'voice.signal', { type: 'offer', sdp: 'v=0\nphone' }),
      { deviceId: 'p1' },
    );
    await new Promise<void>((r) => setTimeout(r, 0));

    // Simulate the phone's audio track arriving on the peer.
    instances[0]!._emitTrack(mockTrack());
    const sink = getLastSink();
    expect(sink).not.toBeNull();

    // Fire one audio frame.
    sink!.ondata?.({
      samples: Int16Array.from([5, 6, 7]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 3,
    });

    const audioFrame = captured.find(
      (f) => f.topic === 'voice.audiosx.frame' && f.type === 'voice.frame',
    );
    expect(audioFrame).toBeDefined();
    const wire = audioFrame!.payload as { samples: number[] };
    expect(wire.samples).toEqual([5, 6, 7]);

    await voice.close();
  });

  it('tears down on peer connection-state failure (lifecycle: create → close → cleanup)', async () => {
    const env = createEnvelopeRouter();
    env.setBroadcaster(() => {
      /* no-op */
    });
    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    env.dispatchRaw(frame('voice.lc.signal', 'voice.signal', { type: 'offer', sdp: 'v=0' }), {
      deviceId: 'p',
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(voice.sessions.size).toBe(1);
    expect(voice._createdCount()).toBe(1);

    // Peer drops -> router cleans up automatically.
    instances[0]!._emitState('failed');
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(voice.sessions.size).toBe(0);
    expect(voice._destroyedCount()).toBe(1);
    expect(instances[0]!._calls.closed).toBe(true);

    await voice.close();
  });

  it('close() destroys every live session', async () => {
    const env = createEnvelopeRouter();
    env.setBroadcaster(() => {
      /* no-op */
    });
    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    for (const sid of ['a', 'b', 'c']) {
      env.dispatchRaw(frame(`voice.${sid}.signal`, 'voice.signal', { type: 'offer', sdp: 'v=0' }), {
        deviceId: 'p',
      });
    }
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(voice.sessions.size).toBe(3);

    await voice.close();
    expect(voice.sessions.size).toBe(0);
    expect(voice._destroyedCount()).toBe(3);
    expect(instances.every((p) => p._calls.closed)).toBe(true);
  });

  it('drops stray ICE candidates for unknown sessions', async () => {
    const env = createEnvelopeRouter();
    env.setBroadcaster(() => {
      /* no-op */
    });
    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    // End-of-candidates (empty string) for a never-seen session: drop.
    env.dispatchRaw(frame('voice.never.signal', 'voice.signal', { type: 'ice', candidate: '' }), {
      deviceId: 'p',
    });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(voice.sessions.size).toBe(0);
    expect(instances).toHaveLength(0);

    await voice.close();
  });

  it('rejects malformed signal payloads silently', async () => {
    const env = createEnvelopeRouter();
    env.setBroadcaster(() => {
      /* no-op */
    });
    const { deps, instances } = makeDeps();
    const voice = createVoiceRouter({ router: env, deps });

    env.dispatchRaw(frame('voice.bad.signal', 'voice.signal', { type: 'nope' }), { deviceId: 'p' });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(voice.sessions.size).toBe(0);
    expect(instances).toHaveLength(0);

    await voice.close();
  });
});
