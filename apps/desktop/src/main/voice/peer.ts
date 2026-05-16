// Per-session server-side WebRTC peer for the desktop voice route.
//
// P07B step 2: the desktop sits between the phone (WebRTC peer) and the
// active agent. For each phone-initiated voice session we spin up an
// `RTCPeerConnection` on this side, accept the phone's SDP offer, emit an
// answer, exchange ICE candidates, and pipe the inbound audio track into
// the agent bridge as raw PCM16 frames. The bridge gives us a track we
// publish back out to the phone for the agent's reply audio.
//
// We use `@roamhq/wrtc@0.10.0` for the Node-side WebRTC implementation —
// the actively-maintained fork of the original `node-webrtc` project with
// current prebuilt binaries for darwin-arm64/darwin-x64/linux-x64. It
// exposes the standard `RTCPeerConnection` surface and a nonstandard
// `RTCAudioSink`/`RTCAudioSource` pair (under `lib/nonstandard.js`) that
// is the only practical way to read or write raw PCM samples to / from a
// `MediaStreamTrack` from Node. The audio data shape is fixed:
//
//   { samples: Int16Array, sampleRate, bitsPerSample, channelCount,
//     numberOfFrames }
//
// — 10ms of mono PCM16 per callback (`numberOfFrames === sampleRate / 100`
// on the default).
//
// The peer module is intentionally decoupled from the router and the
// gateway: the caller wires inbound frames to whatever consumer makes
// sense (see `agentBridge.ts`) and signals offers/answers/ICE through
// `applySignal` + the `onLocalSignal` callback. This keeps the unit
// tests in `__tests__/peer.test.ts` runnable with two real peers, no
// router, no agent.

import { VOICE_SCHEMA_VERSION, type VoiceSignal } from '@openclaw/protocol';

// Minimal structural types so this module compiles even when the wrtc
// native binary isn't available at type-check time (Linux CI hosts
// without libcrypto3 etc.). The real shapes come from `@roamhq/wrtc`
// and `@roamhq/wrtc/lib/nonstandard`; we keep our reliance to the
// standard W3C surface so a future switch back to upstream `wrtc` is
// a one-line `require()` change.

/** Tiny structural slice of `RTCPeerConnection` we actually use. */
export interface PeerLike {
  signalingState: string;
  connectionState: string;
  addTransceiver(kind: 'audio', init?: { direction?: string }): unknown;
  setRemoteDescription(desc: { type: string; sdp?: string }): Promise<void>;
  setLocalDescription(desc?: { type: string; sdp?: string }): Promise<void>;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  addIceCandidate(cand: { candidate: string } | string): Promise<void>;
  addTrack(track: unknown, stream?: unknown): unknown;
  removeTrack(sender: unknown): void;
  close(): void;
  // EventTarget-ish surface — wrtc's pc is a real EventTarget on top of
  // the .on… properties.
  ontrack: ((ev: { track: TrackLike; streams?: unknown[] }) => void) | null;
  onicecandidate: ((ev: { candidate: { candidate: string } | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  localDescription: { type: string; sdp?: string } | null;
  remoteDescription: { type: string; sdp?: string } | null;
}

/** Minimal slice of `MediaStreamTrack` we consume. */
export interface TrackLike {
  kind: string;
  id: string;
  stop(): void;
}

/** Audio data shape emitted by `RTCAudioSink.ondata`. */
export interface AudioFrame {
  /** Interleaved PCM16 samples (mono in our config, so just samples). */
  samples: Int16Array;
  /** Hz. Stable per-session; we negotiate Opus@48k in production. */
  sampleRate: number;
  /** Defaults to 16 — we only ever see 16. */
  bitsPerSample?: number;
  /** Defaults to 1 — mono. */
  channelCount?: number;
  /** Samples per frame. Defaults to 10ms (`sampleRate / 100`). */
  numberOfFrames?: number;
}

/** Constructor for an `RTCAudioSink` (nonstandard wrtc surface). */
export type AudioSinkCtor = new (track: TrackLike) => {
  ondata: ((data: AudioFrame) => void) | null;
  stop(): void;
};

/** Constructor for an `RTCAudioSource` (nonstandard wrtc surface). */
export type AudioSourceCtor = new () => {
  createTrack(): TrackLike;
  onData(data: AudioFrame): void;
};

/** Constructor for `RTCPeerConnection`. */
export type PeerCtor = new (config?: { iceServers?: Array<{ urls: string }> }) => PeerLike;

/** Injection seam — tests pass mock ctors; production wires `@roamhq/wrtc`. */
export interface PeerDeps {
  PeerConnection: PeerCtor;
  AudioSink: AudioSinkCtor;
  AudioSource: AudioSourceCtor;
  /** Optional `iceServers`. Defaults to none (LAN-only). */
  iceServers?: Array<{ urls: string }>;
}

/** Callback handed to a peer; called when this side wants to send a signal. */
export type LocalSignalEmitter = (signal: VoiceSignal) => void;

/** Callback the agent bridge supplies to receive inbound audio data. */
export type InboundAudioHandler = (frame: AudioFrame) => void;

/** Public surface of a single per-session peer. */
export interface VoicePeer {
  /** Schema version of the voice protocol this peer speaks. */
  readonly schemaVersion: number;
  /** Session id (echoed in the routing topic). */
  readonly sessionId: string;
  /** Apply an inbound signaling message from the remote peer. */
  applySignal(signal: VoiceSignal): Promise<void>;
  /**
   * Push an outbound audio frame onto this peer's reply track. The first
   * call lazily allocates an `RTCAudioSource`/track and adds it to the
   * `RTCPeerConnection`. Note: in WebRTC, adding a track after
   * negotiation requires renegotiation; we keep the API simple here and
   * leave that as a TODO — for v1 the desktop pre-adds a transceiver
   * up-front so the audio source can be attached without a fresh O/A.
   */
  pushReplyFrame(frame: AudioFrame): void;
  /** Tear down: stop sinks, close the underlying peer. */
  close(): Promise<void>;
  /** Diagnostics: current signaling/connection state. */
  state(): { signaling: string; connection: string; hasInboundTrack: boolean };
  /** Test-only: expose the underlying peer for assertions. */
  _peer(): PeerLike;
}

/** Options for `createVoicePeer`. */
export interface CreateVoicePeerOpts {
  /** Unique session id (matches the `<sessionId>` in the topic). */
  sessionId: string;
  /** Implementation seam — pass `@roamhq/wrtc` ctors in production. */
  deps: PeerDeps;
  /** Where outbound signals (local SDP / ICE) get pushed. */
  onLocalSignal: LocalSignalEmitter;
  /** Called when an inbound audio frame arrives from the remote peer. */
  onInboundAudio: InboundAudioHandler;
  /** Called when the connection closes / fails so the router can clean up. */
  onClose?: () => void;
}

/**
 * Build a per-session voice peer wired to the supplied callbacks. The
 * caller (typically `voice/router.ts`) owns the lifecycle.
 */
export function createVoicePeer(opts: CreateVoicePeerOpts): VoicePeer {
  const { sessionId, deps, onLocalSignal, onInboundAudio, onClose } = opts;
  const pc = new deps.PeerConnection({ iceServers: deps.iceServers ?? [] });

  // Pre-create a transceiver in sendrecv mode so:
  //  - The remote peer's audio track lands on `ontrack` immediately after
  //    `setRemoteDescription(offer)` — no renegotiation needed.
  //  - We have a sender slot ready to receive an `RTCAudioSource` track
  //    when the agent's first reply frame arrives.
  pc.addTransceiver('audio', { direction: 'sendrecv' });

  let inboundSink: { stop(): void; ondata: ((d: AudioFrame) => void) | null } | null = null;
  let inboundTrack: TrackLike | null = null;
  let replySource: InstanceType<AudioSourceCtor> | null = null;
  let replyTrack: TrackLike | null = null;
  let closed = false;

  pc.ontrack = (ev): void => {
    // We only attach one inbound sink per peer; if the remote peer emits
    // multiple audio tracks (unusual), we keep the first and drop later
    // ones — voice is mono in v1.
    if (inboundSink || ev.track.kind !== 'audio') return;
    inboundTrack = ev.track;
    const sink = new deps.AudioSink(ev.track);
    sink.ondata = (frame): void => {
      if (closed) return;
      try {
        onInboundAudio(frame);
      } catch {
        // Audio handlers are best-effort — never crash the peer loop.
      }
    };
    inboundSink = sink;
  };

  pc.onicecandidate = (ev): void => {
    // wrtc emits a final `{ candidate: null }` to mark end-of-candidates.
    // We mirror the WebRTC pattern by sending an empty-string `candidate`
    // (`VoiceSignal.candidate === ""`) so the remote peer can flush its
    // gathering queue.
    if (!ev.candidate) {
      onLocalSignal({ type: 'ice', candidate: '' });
      return;
    }
    onLocalSignal({ type: 'ice', candidate: ev.candidate.candidate });
  };

  pc.onconnectionstatechange = (): void => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed' || s === 'disconnected') {
      void teardown();
    }
  };

  async function teardown(): Promise<void> {
    if (closed) return;
    closed = true;
    try {
      inboundSink?.stop();
    } catch {
      // ignore
    }
    inboundSink = null;
    try {
      inboundTrack?.stop();
    } catch {
      // ignore
    }
    inboundTrack = null;
    try {
      replyTrack?.stop();
    } catch {
      // ignore
    }
    replyTrack = null;
    replySource = null;
    try {
      pc.close();
    } catch {
      // ignore
    }
    onClose?.();
  }

  async function applySignal(signal: VoiceSignal): Promise<void> {
    if (closed) return;
    switch (signal.type) {
      case 'offer': {
        if (!signal.sdp) throw new Error('voice signal: offer missing sdp');
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const localSdp = pc.localDescription?.sdp ?? answer.sdp;
        onLocalSignal({ type: 'answer', sdp: localSdp });
        break;
      }
      case 'answer': {
        if (!signal.sdp) throw new Error('voice signal: answer missing sdp');
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        break;
      }
      case 'ice': {
        // Empty candidate = end-of-candidates. wrtc accepts an empty
        // string by treating it as a null candidate; we filter to keep
        // semantics consistent with browser implementations.
        if (!signal.candidate) return;
        await pc.addIceCandidate({ candidate: signal.candidate });
        break;
      }
      default: {
        // Exhaustiveness: VoiceSignalType only has the three variants.
        const _exhaustive: never = signal.type;
        void _exhaustive;
      }
    }
  }

  function ensureReplyTrack(): void {
    if (replySource && replyTrack) return;
    const src = new deps.AudioSource();
    const track = src.createTrack();
    replySource = src;
    replyTrack = track;
    // Add the track to the peer so the remote receives it. Because we
    // pre-created a transceiver above, this re-uses the existing sender
    // slot in many implementations — but wrtc treats it as a fresh
    // `addTrack` and will require renegotiation for the remote to pick
    // up the new SSRC. P07A's mobile client triggers that renegotiation
    // by listening for `negotiationneeded` (real WebRTC API). The
    // returned sender is dropped here; teardown closes the whole peer.
    void pc.addTrack(track);
  }

  function pushReplyFrame(frame: AudioFrame): void {
    if (closed) return;
    ensureReplyTrack();
    try {
      replySource?.onData(frame);
    } catch {
      // Never crash the peer if the agent supplies a bad frame.
    }
  }

  return {
    schemaVersion: VOICE_SCHEMA_VERSION,
    sessionId,
    applySignal,
    pushReplyFrame,
    state(): { signaling: string; connection: string; hasInboundTrack: boolean } {
      return {
        signaling: pc.signalingState,
        connection: pc.connectionState,
        hasInboundTrack: inboundSink !== null,
      };
    },
    async close(): Promise<void> {
      await teardown();
    },
    _peer(): PeerLike {
      return pc;
    },
  };
}

/**
 * Production helper — load `@roamhq/wrtc` at runtime so the import only
 * fails when voice is actually exercised (not at every desktop boot).
 * The main process should call this once during startup and pass the
 * resulting `PeerDeps` into `createVoiceRouter`.
 *
 * Tests don't call this — they inject mock ctors directly into
 * `createVoicePeer`. The Linux dev container has a working
 * `@roamhq/wrtc-linux-x64` prebuilt, so the dynamic require resolves;
 * on Apple Silicon (the v1 production target) it resolves to
 * `@roamhq/wrtc-darwin-arm64`.
 */
export async function loadWrtcDeps(): Promise<PeerDeps> {
  // Use `await import` so bundlers can lazy-load this even when the
  // module graph is built ahead-of-time. The cast through `unknown`
  // matches our local structural types declared above.
  const mod = (await import('@roamhq/wrtc')) as unknown as {
    RTCPeerConnection: PeerCtor;
    nonstandard: { RTCAudioSink: AudioSinkCtor; RTCAudioSource: AudioSourceCtor };
  };
  return {
    PeerConnection: mod.RTCPeerConnection,
    AudioSink: mod.nonstandard.RTCAudioSink,
    AudioSource: mod.nonstandard.RTCAudioSource,
  };
}
