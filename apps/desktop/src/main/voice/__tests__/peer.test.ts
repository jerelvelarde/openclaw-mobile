// Unit tests for `voice/peer.ts`.
//
// We mock the `RTCPeerConnection` / `RTCAudioSink` / `RTCAudioSource`
// trio rather than pulling in `@roamhq/wrtc` so:
//   1. The tests work on hosts where the native binary is missing
//      (CI containers without libcrypto3, etc.).
//   2. We can drive `ontrack` / `onicecandidate` / connection-state
//      transitions deterministically.
// A real-peer integration test lives in `router.test.ts` (gated on
// `@roamhq/wrtc` being present); the unit tests here cover the SDP +
// ICE state machine without that dependency.

import { describe, expect, it, vi } from 'vitest';
import type { VoiceSignal } from '@openclaw/protocol';
import {
  createVoicePeer,
  type AudioFrame,
  type AudioSinkCtor,
  type AudioSourceCtor,
  type PeerCtor,
  type PeerLike,
  type TrackLike,
} from '../peer';

// ── Mock factory ────────────────────────────────────────────────────────────

interface MockPeer extends PeerLike {
  _fakeIncomingTrack(track: TrackLike): void;
  _fakeIceCandidate(candidate: string | null): void;
  _fakeStateChange(state: string): void;
  _calls: {
    setLocalDescription: Array<{ type: string; sdp?: string } | undefined>;
    setRemoteDescription: Array<{ type: string; sdp?: string }>;
    addIceCandidate: Array<{ candidate: string } | string>;
    closed: boolean;
    addTrack: Array<TrackLike>;
  };
}

function mockTrack(kind = 'audio'): TrackLike {
  return {
    kind,
    id: `track_${Math.random().toString(36).slice(2, 8)}`,
    stop: vi.fn(),
  };
}

function makeMockPeerCtor(): { ctor: PeerCtor; instances: MockPeer[] } {
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
    _calls: MockPeer['_calls'] = {
      setLocalDescription: [],
      setRemoteDescription: [],
      addIceCandidate: [],
      closed: false,
      addTrack: [],
    };

    constructor() {
      instances.push(this);
    }

    addTransceiver(): unknown {
      return {};
    }
    async setRemoteDescription(desc: { type: string; sdp?: string }): Promise<void> {
      this._calls.setRemoteDescription.push(desc);
      this.remoteDescription = desc;
    }
    async setLocalDescription(desc?: { type: string; sdp?: string }): Promise<void> {
      this._calls.setLocalDescription.push(desc);
      // The real RTCPeerConnection fills in localDescription via the
      // returned createOffer / createAnswer; we mirror that.
      this.localDescription = desc ?? { type: 'answer', sdp: 'v=0\nlocal' };
    }
    async createOffer(): Promise<{ type: string; sdp?: string }> {
      return { type: 'offer', sdp: 'v=0\nmock-offer' };
    }
    async createAnswer(): Promise<{ type: string; sdp?: string }> {
      return { type: 'answer', sdp: 'v=0\nmock-answer' };
    }
    async addIceCandidate(c: { candidate: string } | string): Promise<void> {
      this._calls.addIceCandidate.push(c);
    }
    addTrack(track: TrackLike): unknown {
      this._calls.addTrack.push(track);
      return { _track: track };
    }
    removeTrack(): void {
      /* no-op */
    }
    close(): void {
      this._calls.closed = true;
      this.connectionState = 'closed';
    }
    _fakeIncomingTrack(track: TrackLike): void {
      this.ontrack?.({ track });
    }
    _fakeIceCandidate(candidate: string | null): void {
      this.onicecandidate?.({ candidate: candidate ? { candidate } : null });
    }
    _fakeStateChange(state: string): void {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
  }
  return { ctor: Pc as unknown as PeerCtor, instances };
}

interface MockSinkHandle {
  track: TrackLike;
  emit(f: AudioFrame): void;
  stopped: boolean;
}

function makeMockSinkCtor(): { ctor: AudioSinkCtor; sinks: MockSinkHandle[] } {
  const sinks: MockSinkHandle[] = [];
  // The Sink ctor is captured by `@roamhq/wrtc` via `new (track)`, but
  // we want the test to drive `ondata` from outside. To avoid the
  // `no-this-alias` lint, we keep the per-instance `ondata` slot on the
  // handle object instead of on `Sink` itself, then surface it through
  // a public setter on the constructed instance.
  class Sink {
    private _handle: MockSinkHandle;
    set ondata(fn: ((d: AudioFrame) => void) | null) {
      if (fn) {
        const cb = fn;
        this._handle.emit = (f): void => cb(f);
      } else {
        this._handle.emit = (): void => undefined;
      }
    }
    constructor(track: TrackLike) {
      const handle: MockSinkHandle = {
        track,
        emit: (): void => undefined,
        stopped: false,
      };
      this._handle = handle;
      sinks.push(handle);
    }
    stop(): void {
      this._handle.stopped = true;
    }
  }
  return { ctor: Sink as unknown as AudioSinkCtor, sinks };
}

function makeMockSourceCtor(): {
  ctor: AudioSourceCtor;
  sources: Array<{ frames: AudioFrame[]; track: TrackLike }>;
} {
  const sources: Array<{ frames: AudioFrame[]; track: TrackLike }> = [];
  class Source {
    private _track = mockTrack('audio');
    private _state = { frames: [] as AudioFrame[], track: this._track };
    constructor() {
      sources.push(this._state);
    }
    createTrack(): TrackLike {
      return this._track;
    }
    onData(d: AudioFrame): void {
      this._state.frames.push(d);
    }
  }
  return { ctor: Source as unknown as AudioSourceCtor, sources };
}

function makeDeps() {
  const peer = makeMockPeerCtor();
  const sink = makeMockSinkCtor();
  const source = makeMockSourceCtor();
  return {
    deps: { PeerConnection: peer.ctor, AudioSink: sink.ctor, AudioSource: source.ctor },
    peer,
    sink,
    source,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createVoicePeer', () => {
  it('replies with an answer to an offer signal', async () => {
    const { deps, peer } = makeDeps();
    const localSignals: VoiceSignal[] = [];
    const vp = createVoicePeer({
      sessionId: 's1',
      deps,
      onLocalSignal: (s) => localSignals.push(s),
      onInboundAudio: () => {
        /* no-op */
      },
    });

    const offer: VoiceSignal = { type: 'offer', sdp: 'v=0\nremote-offer' };
    await vp.applySignal(offer);

    expect(peer.instances).toHaveLength(1);
    const pc = peer.instances[0]!;
    expect(pc._calls.setRemoteDescription).toEqual([{ type: 'offer', sdp: 'v=0\nremote-offer' }]);
    expect(pc._calls.setLocalDescription).toHaveLength(1);
    expect(localSignals).toHaveLength(1);
    expect(localSignals[0]!.type).toBe('answer');
    expect(localSignals[0]!.sdp).toMatch(/mock-answer/);
    await vp.close();
  });

  it('round-trips ICE candidates in both directions', async () => {
    const { deps, peer } = makeDeps();
    const localSignals: VoiceSignal[] = [];
    const vp = createVoicePeer({
      sessionId: 's2',
      deps,
      onLocalSignal: (s) => localSignals.push(s),
      onInboundAudio: () => {
        /* no-op */
      },
    });

    // Inbound: phone sends us an ICE candidate.
    await vp.applySignal({ type: 'ice', candidate: 'candidate:1 1 UDP 1 1.2.3.4 4242 typ host' });
    const pc = peer.instances[0]!;
    expect(pc._calls.addIceCandidate).toHaveLength(1);

    // Outbound: our peer discovers a candidate.
    pc._fakeIceCandidate('candidate:2 1 UDP 1 5.6.7.8 5252 typ srflx');
    expect(localSignals.some((s) => s.type === 'ice' && s.candidate?.includes('srflx'))).toBe(true);

    // End-of-candidates from us comes through as `candidate: ""`.
    pc._fakeIceCandidate(null);
    expect(localSignals.some((s) => s.type === 'ice' && s.candidate === '')).toBe(true);

    // Inbound end-of-candidates is dropped (no `addIceCandidate` call).
    const before = pc._calls.addIceCandidate.length;
    await vp.applySignal({ type: 'ice', candidate: '' });
    expect(pc._calls.addIceCandidate.length).toBe(before);

    await vp.close();
  });

  it('rejects malformed offer/answer signals', async () => {
    const { deps } = makeDeps();
    const vp = createVoicePeer({
      sessionId: 's3',
      deps,
      onLocalSignal: () => {
        /* no-op */
      },
      onInboundAudio: () => {
        /* no-op */
      },
    });
    await expect(vp.applySignal({ type: 'offer' })).rejects.toThrow(/missing sdp/);
    await expect(vp.applySignal({ type: 'answer' })).rejects.toThrow(/missing sdp/);
    await vp.close();
  });

  it('forwards inbound audio frames to the agent bridge', async () => {
    const { deps, peer, sink } = makeDeps();
    const inbound: AudioFrame[] = [];
    const vp = createVoicePeer({
      sessionId: 's4',
      deps,
      onLocalSignal: () => {
        /* no-op */
      },
      onInboundAudio: (f) => inbound.push(f),
    });

    const track = mockTrack('audio');
    peer.instances[0]!._fakeIncomingTrack(track);

    expect(sink.sinks).toHaveLength(1);
    expect(vp.state().hasInboundTrack).toBe(true);

    const frame: AudioFrame = {
      samples: Int16Array.from([0, 1, 2, 3]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 4,
      bitsPerSample: 16,
    };
    sink.sinks[0]!.emit(frame);
    expect(inbound).toHaveLength(1);
    expect(Array.from(inbound[0]!.samples)).toEqual([0, 1, 2, 3]);
    expect(inbound[0]!.sampleRate).toBe(16_000);

    await vp.close();
  });

  it('lazily attaches an outbound track on the first reply frame', async () => {
    const { deps, peer, source } = makeDeps();
    const vp = createVoicePeer({
      sessionId: 's5',
      deps,
      onLocalSignal: () => {
        /* no-op */
      },
      onInboundAudio: () => {
        /* no-op */
      },
    });

    expect(source.sources).toHaveLength(0);
    expect(peer.instances[0]!._calls.addTrack).toHaveLength(0);

    vp.pushReplyFrame({
      samples: Int16Array.from([10, 20, 30]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 3,
    });

    expect(source.sources).toHaveLength(1);
    expect(source.sources[0]!.frames).toHaveLength(1);
    expect(peer.instances[0]!._calls.addTrack).toHaveLength(1);

    // Subsequent pushes reuse the same source/track.
    vp.pushReplyFrame({
      samples: Int16Array.from([40]),
      sampleRate: 16_000,
      channelCount: 1,
      numberOfFrames: 1,
    });
    expect(source.sources).toHaveLength(1);
    expect(source.sources[0]!.frames).toHaveLength(2);
    expect(peer.instances[0]!._calls.addTrack).toHaveLength(1);

    await vp.close();
  });

  it('fires onClose when the underlying peer transitions to failed', async () => {
    const { deps, peer } = makeDeps();
    const onClose = vi.fn();
    const vp = createVoicePeer({
      sessionId: 's6',
      deps,
      onLocalSignal: () => {
        /* no-op */
      },
      onInboundAudio: () => {
        /* no-op */
      },
      onClose,
    });

    peer.instances[0]!._fakeStateChange('failed');
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(peer.instances[0]!._calls.closed).toBe(true);

    // Calling close() again is idempotent — no second teardown.
    await vp.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() stops sinks and closes the peer', async () => {
    const { deps, peer, sink } = makeDeps();
    const vp = createVoicePeer({
      sessionId: 's7',
      deps,
      onLocalSignal: () => {
        /* no-op */
      },
      onInboundAudio: () => {
        /* no-op */
      },
    });
    peer.instances[0]!._fakeIncomingTrack(mockTrack('audio'));
    expect(sink.sinks[0]!.stopped).toBe(false);

    await vp.close();
    expect(sink.sinks[0]!.stopped).toBe(true);
    expect(peer.instances[0]!._calls.closed).toBe(true);
  });
});
