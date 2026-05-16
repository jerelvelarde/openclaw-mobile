// Voice v1 schema — TS types.
//
// The voice transport for v1 is **WebRTC** between the mobile/desktop client
// and the always-on Mac host running the gateway. WS-frames remain available
// as a per-call fallback for environments where WebRTC fails to establish.
// See `packages/protocol/VOICE.md` for the decision rationale, sequence
// diagrams, and agent-author notes.
//
// All shapes in this file have a Zod schema in `./schemas.ts`. The wire
// envelope (`{ id, topic, type, payload, ts }`) defined in `../envelope.ts`
// wraps every voice payload on the `voice.<sessionId>.*` topics. The plain
// interfaces here exist so consumers can opt out of pulling Zod into their
// type graph.
//
// Notes:
//  - This module defines the **wire shapes** only. Implementations of
//    signaling, frame encoding, peer setup, and transcript rendering live
//    in the per-app transport plans (P07A gateway / P07B clients).
//  - `Uint8Array` is represented in Zod via `z.instanceof(Uint8Array)`; see
//    `./schemas.ts` for the runtime contract and serialization notes.

/** Current voice schema version. Bump on any breaking wire change. */
export const VOICE_SCHEMA_VERSION = 1;

// ── Session options ─────────────────────────────────────────────────────────

/** Audio frame format the client will send. */
export type VoiceFormat = 'opus' | 'pcm16';

/**
 * Caller options for opening a voice session. The gateway uses `agentId` to
 * route audio to the right skill / Hermes process; `format` + `sampleRate`
 * describe the encoding the client will produce (the agent is expected to
 * decode accordingly, or the gateway transcodes — see `VOICE.md`).
 */
export interface VoiceOpts {
  /** Routing target, e.g. `"openclaw.default"` or `"hermes"`. */
  agentId: string;
  /** Audio codec the client will emit. */
  format: VoiceFormat;
  /** Sample rate in Hz, e.g. `16000` or `48000`. */
  sampleRate: number;
}

// ── WebRTC signaling ────────────────────────────────────────────────────────

/** Discriminator for the three steps of the WebRTC handshake. */
export type VoiceSignalType = 'offer' | 'answer' | 'ice';

/**
 * One frame in the WebRTC handshake exchanged on
 * `voice.<sessionId>.signal`. The gateway relays signals between the client
 * peer (mobile/desktop) and the agent peer (running alongside the gateway
 * on the host). Either side may emit any of the three message types — for
 * example, both peers send `ice` candidates as they're discovered.
 *
 *  - `offer` / `answer`: `sdp` is the session description.
 *  - `ice`: `candidate` is a single ICE candidate string. End-of-candidates
 *    is signaled by `candidate: ""` (or by omission — both are accepted to
 *    keep the schema forgiving).
 */
export interface VoiceSignal {
  type: VoiceSignalType;
  /** SDP body. Required for `offer` and `answer`; absent for `ice`. */
  sdp?: string;
  /** ICE candidate string. Required for `ice`; absent for `offer`/`answer`. */
  candidate?: string;
}

// ── WS-frame fallback ───────────────────────────────────────────────────────

/**
 * One audio frame sent over the WebSocket on `voice.<sessionId>.frame` when
 * WebRTC isn't available. `seq` is monotonic per-session so receivers can
 * detect drops; `data` is the raw codec payload (Opus packet or interleaved
 * PCM16 samples — agreed via the surrounding `VoiceOpts.format`).
 *
 * Frames are intentionally minimal: timing is per-frame implicit from the
 * negotiated `sampleRate` + frame size. We can add explicit timestamps in a
 * future schema version if we discover a sync issue in production.
 */
export interface VoiceFrame {
  /** Monotonic frame counter; receivers MAY drop frames with `seq < lastSeen`. */
  seq: number;
  /** Encoded audio bytes. */
  data: Uint8Array;
}

// ── Live transcript ─────────────────────────────────────────────────────────

/**
 * Live transcript fragment streamed from the agent on
 * `voice.<sessionId>.transcript`. The client renders interim (`isFinal:false`)
 * fragments in a "ghost" style and replaces them once the matching final
 * arrives. Multiple final fragments concatenate to form the running
 * transcript for the session.
 */
export interface VoiceTranscript {
  /** Recognized text. May be empty if the recognizer hasn't decided yet. */
  text: string;
  /** `true` once the recognizer has committed; `false` for interim hypotheses. */
  isFinal: boolean;
  /** Sender's clock as epoch ms. */
  ts: number;
}

// ── Session handle ──────────────────────────────────────────────────────────

/**
 * Handle returned by `GatewayClient.openVoice`. Implementation-defined —
 * concrete transports (WebRTC peer in P07B, WS frame loop as fallback)
 * decorate this with their own internal state. The protocol package only
 * promises `id` and a `close()` so callers can tear down deterministically.
 */
export interface VoiceSession {
  /** Unique session id; also the `<sessionId>` interpolated into topics. */
  id: string;
  /** Agent the session is bound to (echo of `VoiceOpts.agentId`). */
  agentId: string;
  /** Tear down the session (closes peer / stops frame loop). */
  close(): Promise<void>;
}

// ── Topics ──────────────────────────────────────────────────────────────────

/**
 * Topic-name builders. Voice messages flow on three sub-topics keyed by
 * session id:
 *
 *   `voice.<sessionId>.signal`      — WebRTC SDP + ICE.
 *   `voice.<sessionId>.frame`       — WS-frame audio fallback.
 *   `voice.<sessionId>.transcript`  — live transcript from agent.
 *
 * These helpers keep the naming centralized — transports and tests should
 * call them rather than concatenate strings inline.
 */
export const voiceTopics = {
  signal: (sessionId: string): string => `voice.${sessionId}.signal`,
  frame: (sessionId: string): string => `voice.${sessionId}.frame`,
  transcript: (sessionId: string): string => `voice.${sessionId}.transcript`,
} as const;
