// Bridge between a per-session WebRTC peer and the in-process gateway.
//
// P07B step 3: the agent bridge translates between the peer's audio
// world and the gateway's envelope world:
//
//   peer (RTCPeerConnection)  ──►  agentBridge  ──►  router publish
//   "PCM16 frame from phone"        forwards as       voice.<sid>.frame
//                                                     type: voice.frame
//
//   router subscribe   ──►  agentBridge  ──►  peer
//   "PCM16 reply frame      pushes onto the   pushReplyFrame()
//    or transcript from     reply track /
//    the agent"             passes transcript
//                           through to client
//                           on voice.<sid>.transcript
//
// Direction discrimination on the shared `voice.<sid>.frame` topic uses
// the envelope `type` field:
//
//   - `voice.frame`         — phone → agent (the desktop publishes this).
//   - `voice.frame.reply`   — agent → phone (the stub / real agent emits).
//
// Keeping both directions on one topic keeps the routing key set small
// (matching the protocol module's `voiceTopics` helper) at the cost of
// one extra `type` discriminator per frame. A future real agent that
// runs in a separate process is expected to follow the same convention.

import type { Envelope } from '@openclaw/protocol';
import { voiceTopics, VOICE_SCHEMA_VERSION } from '@openclaw/protocol';
import type { Router } from '../transport/router';
import type { AudioFrame, VoicePeer } from './peer';

/** Envelope `type` discriminator: phone → agent audio frame. */
export const VOICE_FRAME_TYPE = 'voice.frame';
/** Envelope `type` discriminator: agent → phone audio frame. */
export const VOICE_FRAME_REPLY_TYPE = 'voice.frame.reply';
/** Envelope `type` discriminator: agent → phone transcript fragment. */
export const VOICE_TRANSCRIPT_TYPE = 'voice.transcript';
/** Envelope `type` discriminator: WebRTC signaling. */
export const VOICE_SIGNAL_TYPE = 'voice.signal';

/**
 * JSON-safe shape we publish on the frame topic. Note that
 * `@openclaw/protocol`'s `VoiceFrame.data` is a `Uint8Array`, but the
 * standard envelope path is JSON-encoded over WS — so when an in-process
 * router carries the payload we keep the raw `samples` Int16Array
 * structure on a separate field. Cross-process transports (real agent,
 * future SFU) MUST base64-encode `samples` before serializing. We
 * surface both fields on the wire so the consumer can pick.
 */
export interface VoiceFrameWire {
  /** Monotonic counter, matches `VoiceFrame.seq`. */
  seq: number;
  /** Audio format hint — `"pcm16"` for the data the desktop emits. */
  format: 'pcm16' | 'opus';
  /** Hz. Stable for the lifetime of the session. */
  sampleRate: number;
  /** Mono in v1. */
  channelCount: number;
  /** Samples per frame (typically `sampleRate / 100`). */
  numberOfFrames: number;
  /**
   * PCM16 samples as a regular array of numbers. We avoid `Int16Array`
   * on the wire because JSON.stringify of a typed array drops the
   * buffer. In-process subscribers reconstruct via `Int16Array.from`.
   */
  samples: number[];
}

/** Public surface returned by `createAgentBridge`. */
export interface AgentBridge {
  readonly sessionId: string;
  /** Forward an audio frame from the peer onto the gateway. */
  handleInboundAudio(frame: AudioFrame): void;
  /** Detach the router subscriptions. Idempotent. */
  detach(): void;
  /** Test-only: number of frames forwarded outward (to the gateway). */
  _outboundCount(): number;
  /** Test-only: number of reply frames pushed to the peer. */
  _replyCount(): number;
}

/** Options for `createAgentBridge`. */
export interface CreateAgentBridgeOpts {
  /** Unique session id (matches `voice.<sessionId>.*` topic). */
  sessionId: string;
  /** Owning device id — replies from the stub publish back to this device. */
  deviceId: string;
  /** Router providing publish + subscribe. */
  router: Router;
  /** The peer owning the inbound/outbound audio tracks. */
  peer: VoicePeer;
  /** Optional clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Wire the bridge for one voice session. Returns a handle whose
 * `detach()` removes router subscriptions and is called by the voice
 * router when the session tears down.
 */
export function createAgentBridge(opts: CreateAgentBridgeOpts): AgentBridge {
  const { sessionId, deviceId, router, peer, now = (): number => Date.now() } = opts;
  const frameTopic = voiceTopics.frame(sessionId);
  const transcriptTopic = voiceTopics.transcript(sessionId);

  let outboundSeq = 0;
  let outboundCount = 0;
  let replyCount = 0;
  let detached = false;
  const unsubs: Array<() => void> = [];

  // Subscribe to the agent's reply frames on `voice.<sid>.frame`,
  // filtering by `type: voice.frame.reply` so we don't loop our own
  // inbound publish back onto the peer.
  unsubs.push(
    router.subscribe(frameTopic, (frame) => {
      if (frame.type !== VOICE_FRAME_REPLY_TYPE) return;
      const wire = frame.payload as VoiceFrameWire | null;
      if (!wire || !Array.isArray(wire.samples)) return;
      try {
        peer.pushReplyFrame({
          samples: Int16Array.from(wire.samples),
          sampleRate: wire.sampleRate,
          bitsPerSample: 16,
          channelCount: wire.channelCount,
          numberOfFrames: wire.numberOfFrames,
        });
        replyCount += 1;
      } catch {
        // Best-effort: a bad frame from the agent shouldn't crash the
        // router.
      }
    }),
  );

  // Transcripts are subscribe-only on this side — the agent publishes
  // them; we don't read them (the phone does), but we expose a hook so
  // the voice router can log / forward to the renderer for the desktop
  // chat surface. The actual fan-out to the phone happens through
  // `router.publish` upstream of us; we just count for tests.
  unsubs.push(
    router.subscribe(transcriptTopic, () => {
      // No-op on the desktop side; the WS transport already forwards
      // published frames to every subscribed session including the
      // originator.
    }),
  );

  function handleInboundAudio(frame: AudioFrame): void {
    if (detached) return;
    const wire: VoiceFrameWire = {
      seq: outboundSeq++,
      format: 'pcm16',
      sampleRate: frame.sampleRate,
      channelCount: frame.channelCount ?? 1,
      numberOfFrames: frame.numberOfFrames ?? frame.samples.length,
      samples: Array.from(frame.samples),
    };
    const envelope: Envelope<VoiceFrameWire> = {
      id: `vf_${sessionId}_${wire.seq}`,
      topic: frameTopic,
      type: VOICE_FRAME_TYPE,
      payload: wire,
      ts: now(),
    };
    router.publish(envelope.topic, envelope.type, envelope.payload, {
      id: envelope.id,
      ts: envelope.ts,
      target: { deviceId },
    });
    outboundCount += 1;
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    for (const off of unsubs) {
      try {
        off();
      } catch {
        // ignore
      }
    }
    unsubs.length = 0;
  }

  return {
    sessionId,
    handleInboundAudio,
    detach,
    _outboundCount: (): number => outboundCount,
    _replyCount: (): number => replyCount,
  };
}

/** Re-export so callers don't need a second import line. */
export { VOICE_SCHEMA_VERSION };
