// WebRTC peer for the mobile voice surface (P07A).
//
// Opens an `RTCPeerConnection` to the desktop using the gateway's WebSocket
// as the signaling channel (topics `voice.<sessionId>.signal`, see
// `packages/protocol/VOICE.md`). Trickles ICE candidates as they're
// discovered. STUN/TURN servers are intentionally omitted — v1 voice is
// LAN-only between the phone and the always-on Mac host (per
// `host-target.md`). When a remote-via-Tailscale flow lands we'll add the
// `iceServers` list at that time.
//
// The module exposes:
//
//   - {@link openVoicePeer} — start a session: dial gateway-signaling →
//     send offer → wait for answer → fire-and-forget trickle ICE. Returns
//     a {@link VoicePeerHandle} with `start()`, `stop()`, and `close()` so
//     the state machine in `usePushToTalk.ts` can drive the local mic
//     track enabled/disabled flag without rebuilding the peer per turn.
//
//   - {@link createRtcShim} — typed wrapper around the `react-native-webrtc`
//     imports. Exposed as a parameter so jest tests can inject a stub
//     implementation (the real module loads a native library that doesn't
//     exist in node). Production callers omit the parameter.
//
// The signaling round-trip is built on `voiceTopics.signal()` from
// `@openclaw/protocol`; both peers exchange `VoiceSignal` envelopes via
// `Gateway.sendVoiceSignal`/`onVoiceSignal`. The gateway is a relay — it
// doesn't speak SDP. P07B lands the desktop-side peer; until then the
// signaling round-trip can be exercised end-to-end against the stub.

import type { Envelope, Unsubscribe, VoiceOpts, VoiceSignal } from '@openclaw/protocol';
import { voiceTopics } from '@openclaw/protocol';

/**
 * Minimal subset of `react-native-webrtc`'s `RTCPeerConnection` we touch.
 * We type by intersection so the real module is assignable without a
 * `@types/react-native-webrtc` install, and so tests can implement just
 * enough to drive the tests.
 */
export interface RtcPeerConnectionLike {
  createOffer(options?: unknown): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(desc: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(desc: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  }): Promise<void>;
  addTrack(track: unknown, ...streams: unknown[]): unknown;
  close(): void;
  /** Set by us so the peer pushes new candidates back through signaling. */
  onicecandidate:
    | ((ev: {
        candidate: { candidate: string; sdpMid?: string; sdpMLineIndex?: number } | null;
      }) => void)
    | null;
  /** Connection state changes drive the state machine's `failed`/`closed` transitions. */
  oniceconnectionstatechange: (() => void) | null;
  /** Inbound audio track from the desktop — wired into the speaker. */
  ontrack: ((ev: { streams: Array<{ getTracks(): unknown[] }>; track: unknown }) => void) | null;
  /** Read-only string — `"new" | "checking" | "connected" | "completed" | "failed" | …`. */
  readonly iceConnectionState: string;
}

/** Audio track wrapper subset we need from `MediaStream.getAudioTracks()`. */
export interface RtcAudioTrackLike {
  enabled: boolean;
  stop(): void;
}

/** `MediaStream`-like — what `getUserMedia({ audio: true })` returns. */
export interface RtcMediaStreamLike {
  getTracks(): Array<RtcAudioTrackLike & { kind?: string }>;
  getAudioTracks(): RtcAudioTrackLike[];
}

/**
 * Wrapper around the `react-native-webrtc` module so tests can stub it.
 * Production code calls `createRtcShim()` with no args, which returns the
 * real bindings. Tests pass `{ shim }` to {@link openVoicePeer}.
 */
export interface RtcShim {
  /** Build a new `RTCPeerConnection` with no iceServers (LAN-only for v1). */
  newPeerConnection(config?: { iceServers?: unknown[] }): RtcPeerConnectionLike;
  /** Build a session description object. */
  newSessionDescription(init: { type: string; sdp?: string }): { type: string; sdp?: string };
  /** Build an ICE candidate object. */
  newIceCandidate(init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): {
    candidate: string;
    sdpMid?: string;
    sdpMLineIndex?: number;
  };
  /** Open the microphone. Returns a `MediaStream`-like. */
  getUserMedia(constraints: {
    audio: boolean | unknown;
    video?: boolean;
  }): Promise<RtcMediaStreamLike>;
}

/** Lazily loaded production shim. */
let cachedRealShim: RtcShim | null = null;

/**
 * Return the real `react-native-webrtc`-backed shim. Loads lazily so jest
 * runs that pass their own stub don't pay the native-module cost on import.
 */
export function createRtcShim(): RtcShim {
  if (cachedRealShim) return cachedRealShim;
  // The require is intentional: a static `import` would force jest to
  // resolve the native module on test load even when callers override the
  // shim. We narrow with `unknown` casts because `react-native-webrtc`'s
  // typings expose classes via the module's default export.
  //
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require('react-native-webrtc') as {
    RTCPeerConnection: new (config?: { iceServers?: unknown[] }) => RtcPeerConnectionLike;
    RTCSessionDescription: new (init: { type: string; sdp?: string }) => {
      type: string;
      sdp?: string;
    };
    RTCIceCandidate: new (init: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }) => {
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
    };
    mediaDevices: { getUserMedia(constraints: { audio: unknown }): Promise<RtcMediaStreamLike> };
  };
  cachedRealShim = {
    newPeerConnection: (config) => new rn.RTCPeerConnection(config),
    newSessionDescription: (init) => new rn.RTCSessionDescription(init),
    newIceCandidate: (init) => new rn.RTCIceCandidate(init),
    getUserMedia: (constraints) => rn.mediaDevices.getUserMedia(constraints),
  };
  return cachedRealShim;
}

/**
 * Minimal contract `webrtc.ts` needs from the gateway: a way to send a
 * voice-signal envelope and a way to subscribe to inbound signal frames
 * for a given session. The actual `RealGateway` exposes wider surface; we
 * narrow here so tests can inject a fake without re-implementing the whole
 * `GatewayClient`.
 */
export interface VoiceSignalingGateway {
  /** Send a `VoiceSignal` envelope over the WS to topic `voice.<id>.signal`. */
  sendVoiceSignal(sessionId: string, signal: VoiceSignal): Promise<void>;
  /** Subscribe to inbound `VoiceSignal` frames for the session. */
  onVoiceSignal(sessionId: string, handler: (signal: VoiceSignal) => void): Unsubscribe;
}

/** Parameters to {@link openVoicePeer}. */
export interface OpenVoicePeerOptions {
  /** Unique session id; interpolated into `voice.<id>.signal` etc. */
  sessionId: string;
  /** Caller options — agentId + codec + sample rate. */
  opts: VoiceOpts;
  /** Signaling channel (the gateway). */
  gateway: VoiceSignalingGateway;
  /** Override the `react-native-webrtc` bindings; tests pass a stub here. */
  shim?: RtcShim;
  /**
   * Called whenever the peer's ICE state transitions. Wired by the state
   * machine in `usePushToTalk.ts` to advance `arming → listening → idle`.
   */
  onConnectionStateChange?: (state: string) => void;
  /** Called when the remote peer pushes an audio track to us. */
  onRemoteTrack?: (track: unknown) => void;
}

/**
 * Live voice peer handle. The state machine in `usePushToTalk.ts` owns one
 * of these per session and toggles `setSending()` to gate mic capture
 * during the push-to-talk gesture.
 */
export interface VoicePeerHandle {
  /** Echoes the input session id; convenience accessor for callers. */
  readonly sessionId: string;
  /**
   * Enable or disable outbound mic capture. True while the user holds PTT.
   * Backed by `MediaStreamTrack.enabled` so the peer connection stays up
   * across turns (saving the ICE renegotiation cost).
   */
  setSending(sending: boolean): void;
  /** Tear down the peer, stop the mic track, unsubscribe from signaling. */
  close(): Promise<void>;
  /** Current ICE connection state; useful for diagnostics + tests. */
  readonly connectionState: string;
}

/**
 * Open a WebRTC peer for a voice session. The function:
 *
 *  1. Requests the mic via `getUserMedia({ audio: true })`.
 *  2. Builds an `RTCPeerConnection` (no iceServers; LAN-only).
 *  3. Adds the mic audio track.
 *  4. Subscribes to inbound `signal` frames; routes `answer`/`ice` to the
 *     peer. ICE candidates are trickled both ways.
 *  5. Creates and posts an offer.
 *
 * The returned handle starts with `sending: false` — the state machine
 * flips it true once the user holds the PTT button. Closing the handle
 * stops the local track AND closes the peer, so a follow-up call must
 * build a fresh handle.
 */
export async function openVoicePeer(options: OpenVoicePeerOptions): Promise<VoicePeerHandle> {
  const shim = options.shim ?? createRtcShim();
  const stream = await shim.getUserMedia({ audio: true });
  const peer = shim.newPeerConnection({ iceServers: [] });

  // Add the local mic track(s) onto the peer. `addTrack` returns an
  // `RTCRtpSender` we don't need to track; the peer keeps the reference.
  // `react-native-webrtc`'s `getTracks()` covers both audio + video, but
  // we only requested audio so it's effectively `getAudioTracks()`.
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }
  // Start with the mic muted — the state machine flips `enabled` to true
  // on PTT press. Capturing only the audio tracks keeps the loop tight.
  for (const audioTrack of stream.getAudioTracks()) {
    audioTrack.enabled = false;
  }

  // Trickle local ICE candidates back to the desktop via the gateway.
  peer.onicecandidate = (ev): void => {
    // `null` candidate means end-of-candidates. We send an empty-candidate
    // signal as the closing marker per `VoiceSignal`'s schema (which
    // accepts `candidate: ""` or `undefined` as the EOC sentinel).
    if (!ev.candidate) {
      void options.gateway.sendVoiceSignal(options.sessionId, { type: 'ice', candidate: '' });
      return;
    }
    void options.gateway.sendVoiceSignal(options.sessionId, {
      type: 'ice',
      candidate: ev.candidate.candidate,
    });
  };

  peer.oniceconnectionstatechange = (): void => {
    options.onConnectionStateChange?.(peer.iceConnectionState);
  };

  peer.ontrack = (ev): void => {
    options.onRemoteTrack?.(ev.track);
  };

  // Wire inbound signaling — answer + remote ICE candidates.
  const unsubscribeSignal = options.gateway.onVoiceSignal(options.sessionId, (signal) => {
    if (signal.type === 'answer' && typeof signal.sdp === 'string') {
      void peer.setRemoteDescription(
        shim.newSessionDescription({ type: 'answer', sdp: signal.sdp }),
      );
      return;
    }
    if (signal.type === 'ice') {
      const cand = signal.candidate;
      if (!cand) return; // EOC marker — peer reads it via its own listeners.
      void peer.addIceCandidate(shim.newIceCandidate({ candidate: cand }));
      return;
    }
    // `offer` from the remote isn't expected in the client-initiates path;
    // a future "agent initiates a call" feature would handle it here.
  });

  // Create offer + post it. `setLocalDescription` is paired with the
  // outbound send so the peer can start gathering ICE candidates.
  const offer = await peer.createOffer({ offerToReceiveAudio: true });
  await peer.setLocalDescription(offer);
  await options.gateway.sendVoiceSignal(options.sessionId, { type: 'offer', sdp: offer.sdp });

  const audioTracks = stream.getAudioTracks();

  let closed = false;
  return {
    sessionId: options.sessionId,
    get connectionState(): string {
      return peer.iceConnectionState;
    },
    setSending(sending) {
      if (closed) return;
      for (const track of audioTracks) {
        track.enabled = sending;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      unsubscribeSignal();
      for (const track of audioTracks) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Build a `VoiceSignalingGateway` from a `RealGateway`-like socket-sender
 * + `_injectInboundFrame` subscribers. This is the **adapter** the screen
 * uses to plug the `RealGateway` into {@link openVoicePeer} without
 * extending the protocol-level `GatewayClient` interface.
 *
 * `send` builds the envelope on `voiceTopics.signal(sessionId)` and routes
 * it through the gateway's raw socket via the provided sender; `subscribe`
 * registers a listener that the gateway calls when an inbound frame on
 * the same topic arrives.
 *
 * This indirection keeps `webrtc.ts` test-friendly (we never need a real
 * `RealGateway` instance in unit tests) while still letting the production
 * `voice.tsx` screen wire the two together.
 */
export interface VoiceSignalingAdapterOptions {
  /** Underlying send: emit an envelope to the gateway WS. */
  sendEnvelope: (envelope: Envelope<VoiceSignal>) => Promise<void> | void;
  /** Subscribe to inbound voice-signal frames for a session. */
  subscribeInbound: (sessionId: string, handler: (signal: VoiceSignal) => void) => Unsubscribe;
  /** Optional clock injection for deterministic ids in tests. */
  now?: () => number;
}

/**
 * Create the small `VoiceSignalingGateway` an `openVoicePeer` call needs,
 * given a generic envelope-sender + subscriber pair. See
 * {@link VoiceSignalingAdapterOptions}.
 */
export function createVoiceSignalingAdapter(
  options: VoiceSignalingAdapterOptions,
): VoiceSignalingGateway {
  const now = options.now ?? (() => Date.now());
  return {
    async sendVoiceSignal(sessionId, signal) {
      const envelope: Envelope<VoiceSignal> = {
        id: `voice_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        topic: voiceTopics.signal(sessionId),
        type: 'voice.signal',
        payload: signal,
        ts: now(),
      };
      await Promise.resolve(options.sendEnvelope(envelope));
    },
    onVoiceSignal(sessionId, handler) {
      return options.subscribeInbound(sessionId, handler);
    },
  };
}
