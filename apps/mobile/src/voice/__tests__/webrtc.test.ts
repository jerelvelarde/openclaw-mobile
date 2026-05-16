// Signaling round-trip + format negotiation for the WebRTC peer (P07A).
//
// We can't run a real `RTCPeerConnection` under jest (the native lib isn't
// loaded in node), so we inject a stub `RtcShim` and a fake signaling
// gateway. The tests exercise:
//
//  - On `openVoicePeer`, the shim's mic is opened with `audio: true`.
//  - An `offer` envelope is emitted via the gateway after `setLocalDescription`.
//  - Inbound `answer` triggers `setRemoteDescription`.
//  - Inbound `ice` triggers `addIceCandidate`.
//  - Local ICE candidates trickle back through `sendVoiceSignal`.
//  - `setSending(true/false)` flips the audio track's `enabled` flag.
//  - `close()` stops the tracks + closes the peer + unsubscribes.
//  - Format negotiation pins to opus@16kHz for v1.
//
// `react-native-webrtc` is jest-mocked at the top of the file so callers
// that don't pass an explicit shim still don't load the native module.

jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn().mockImplementation(() => ({
    createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'm=audio' }),
    setLocalDescription: jest.fn().mockResolvedValue(undefined),
    setRemoteDescription: jest.fn().mockResolvedValue(undefined),
    addIceCandidate: jest.fn().mockResolvedValue(undefined),
    addTrack: jest.fn(),
    close: jest.fn(),
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ontrack: null,
    iceConnectionState: 'new',
  })),
  RTCSessionDescription: jest
    .fn()
    .mockImplementation((init: { type: string; sdp?: string }) => init),
  RTCIceCandidate: jest.fn().mockImplementation((init: { candidate: string }) => init),
  mediaDevices: {
    getUserMedia: jest.fn().mockResolvedValue({
      getTracks: () => [],
      getAudioTracks: () => [],
    }),
  },
}));

import type { Unsubscribe, VoiceSignal } from '@openclaw/protocol';
import { VoiceOptsSchema } from '@openclaw/protocol';

import {
  openVoicePeer,
  type RtcAudioTrackLike,
  type RtcMediaStreamLike,
  type RtcPeerConnectionLike,
  type RtcShim,
  type VoiceSignalingGateway,
} from '../webrtc';

// ── Test doubles ───────────────────────────────────────────────────────────

interface FakePeer extends RtcPeerConnectionLike {
  __localDescription: { type: string; sdp?: string } | null;
  __remoteDescription: { type: string; sdp?: string } | null;
  __addedIce: Array<{ candidate: string }>;
  __closed: boolean;
  __trackAdds: number;
  __emitIceCandidate(candidate: string | null): void;
}

function makeShim(audioTracks: RtcAudioTrackLike[]): { shim: RtcShim; peer: FakePeer } {
  const peer: FakePeer = {
    iceConnectionState: 'new',
    onicecandidate: null,
    oniceconnectionstatechange: null,
    ontrack: null,
    __localDescription: null,
    __remoteDescription: null,
    __addedIce: [],
    __closed: false,
    __trackAdds: 0,
    createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' }),
    setLocalDescription(desc) {
      peer.__localDescription = desc;
      return Promise.resolve();
    },
    setRemoteDescription(desc) {
      peer.__remoteDescription = desc;
      return Promise.resolve();
    },
    addIceCandidate(cand) {
      peer.__addedIce.push({ candidate: cand.candidate });
      return Promise.resolve();
    },
    addTrack: jest.fn().mockImplementation(() => {
      peer.__trackAdds++;
    }),
    close() {
      peer.__closed = true;
    },
    __emitIceCandidate(candidate) {
      peer.onicecandidate?.({ candidate: candidate ? { candidate } : null });
    },
  };

  const stream: RtcMediaStreamLike = {
    getTracks: () => audioTracks as Array<RtcAudioTrackLike & { kind?: string }>,
    getAudioTracks: () => audioTracks,
  };

  const shim: RtcShim = {
    newPeerConnection: () => peer,
    newSessionDescription: (init) => init,
    newIceCandidate: (init) => init,
    getUserMedia: jest.fn().mockResolvedValue(stream),
  };
  return { shim, peer };
}

interface FakeGateway extends VoiceSignalingGateway {
  __sent: Array<{ sessionId: string; signal: VoiceSignal }>;
  __subscribers: Map<string, Array<(s: VoiceSignal) => void>>;
  __emit(sessionId: string, signal: VoiceSignal): void;
}

function makeFakeGateway(): FakeGateway {
  const gw: FakeGateway = {
    __sent: [],
    __subscribers: new Map(),
    async sendVoiceSignal(sessionId, signal) {
      gw.__sent.push({ sessionId, signal });
    },
    onVoiceSignal(sessionId, handler): Unsubscribe {
      let list = gw.__subscribers.get(sessionId);
      if (!list) {
        list = [];
        gw.__subscribers.set(sessionId, list);
      }
      list.push(handler);
      return () => {
        const arr = gw.__subscribers.get(sessionId);
        if (!arr) return;
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      };
    },
    __emit(sessionId, signal) {
      const list = gw.__subscribers.get(sessionId) ?? [];
      for (const handler of [...list]) handler(signal);
    },
  };
  return gw;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('openVoicePeer signaling round-trip', () => {
  it('sends an offer envelope and routes inbound answer + ice', async () => {
    const track: RtcAudioTrackLike = { enabled: true, stop: jest.fn() };
    const { shim, peer } = makeShim([track]);
    const gateway = makeFakeGateway();

    const handle = await openVoicePeer({
      sessionId: 'vs_test',
      opts: { agentId: 'openclaw.default', format: 'opus', sampleRate: 16000 },
      gateway,
      shim,
    });

    // 1. Mic was opened with audio-only constraints.
    expect(shim.getUserMedia).toHaveBeenCalledWith({ audio: true });

    // 2. Local audio track was added to the peer and initially disabled
    //    (the FSM enables it on PTT press).
    expect(peer.__trackAdds).toBe(1);
    expect(track.enabled).toBe(false);

    // 3. Offer envelope was sent.
    const sent = gateway.__sent;
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0]!.sessionId).toBe('vs_test');
    expect(sent[0]!.signal.type).toBe('offer');
    expect(sent[0]!.signal.sdp).toBe('mock-sdp');

    // 4. Local description was set with the same offer.
    expect(peer.__localDescription).toEqual({ type: 'offer', sdp: 'mock-sdp' });

    // 5. Inbound `answer` → `setRemoteDescription`.
    gateway.__emit('vs_test', { type: 'answer', sdp: 'remote-sdp' });
    expect(peer.__remoteDescription).toEqual({ type: 'answer', sdp: 'remote-sdp' });

    // 6. Inbound `ice` → `addIceCandidate`.
    gateway.__emit('vs_test', { type: 'ice', candidate: 'candidate:1 1 UDP …' });
    expect(peer.__addedIce).toEqual([{ candidate: 'candidate:1 1 UDP …' }]);

    // 7. Local ICE candidate trickles back out through `sendVoiceSignal`.
    peer.__emitIceCandidate('candidate:local 1 UDP …');
    const lastSent = sent[sent.length - 1]!;
    expect(lastSent.signal.type).toBe('ice');
    expect(lastSent.signal.candidate).toBe('candidate:local 1 UDP …');

    // 8. End-of-candidates emits an empty-candidate marker.
    peer.__emitIceCandidate(null);
    const eoc = sent[sent.length - 1]!;
    expect(eoc.signal.type).toBe('ice');
    expect(eoc.signal.candidate).toBe('');

    // 9. `setSending(true)` flips the track on; `close()` stops it.
    handle.setSending(true);
    expect(track.enabled).toBe(true);
    handle.setSending(false);
    expect(track.enabled).toBe(false);

    await handle.close();
    expect(peer.__closed).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it('ignores empty-candidate ice frames inbound (EOC marker)', async () => {
    const { shim, peer } = makeShim([]);
    const gateway = makeFakeGateway();
    await openVoicePeer({
      sessionId: 'vs_eoc',
      opts: { agentId: 'a', format: 'opus', sampleRate: 16000 },
      gateway,
      shim,
    });

    gateway.__emit('vs_eoc', { type: 'ice', candidate: '' });
    expect(peer.__addedIce).toHaveLength(0);

    gateway.__emit('vs_eoc', { type: 'ice' });
    expect(peer.__addedIce).toHaveLength(0);
  });

  it('falls back to the real shim when none is injected (mock keeps native untouched)', async () => {
    // No `shim:` argument — the default `createRtcShim()` path runs and
    // resolves the jest.mock above. We assert the round-trip completes.
    const gateway = makeFakeGateway();
    const handle = await openVoicePeer({
      sessionId: 'vs_real',
      opts: { agentId: 'a', format: 'opus', sampleRate: 16000 },
      gateway,
    });
    expect(handle.sessionId).toBe('vs_real');
    expect(handle.connectionState).toBe('new');
    await handle.close();
  });
});

describe('codec/format negotiation (v1 contract)', () => {
  it('VoiceOpts validate for opus @ 16kHz mono', () => {
    expect(() =>
      VoiceOptsSchema.parse({ agentId: 'openclaw.default', format: 'opus', sampleRate: 16000 }),
    ).not.toThrow();
  });

  it('VoiceOpts reject formats outside the v1 enum', () => {
    expect(() =>
      VoiceOptsSchema.parse({ agentId: 'a', format: 'mp3', sampleRate: 16000 }),
    ).toThrow();
  });
});
