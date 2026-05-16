// Voice v1 schema — Zod schemas.
//
// Mirrors the TS interfaces in `./types.ts`. Schemas validate inbound voice
// frames at the WS / WebRTC boundary; the plain interfaces in `./types.ts`
// remain the type-source-of-truth so consumers can opt out of Zod.
//
// `Uint8Array` in Zod: we use `z.instanceof(Uint8Array)`. This is the
// idiomatic Zod 4 way to validate a binary payload and produces a clean
// `Uint8Array` after `.parse()`. Important properties:
//  - Works in both Node and browser globals.
//  - Does **not** auto-decode from base64 / JSON arrays — voice frames are
//    expected to arrive as binary WS messages (`BufferSource`) or out-of-
//    band over a WebRTC data channel. Transports MUST coerce to
//    `Uint8Array` before calling `VoiceFrameSchema.parse`.
//  - JSON.stringify of a `Uint8Array` would produce `{}`; voice frames are
//    therefore never JSON-encoded as part of the envelope payload — the
//    envelope `type` says "voice.frame" and the WS message is binary.

import { z } from 'zod';

import {
  VOICE_SCHEMA_VERSION,
  type VoiceFrame,
  type VoiceOpts,
  type VoiceSignal,
  type VoiceTranscript,
} from './types';

// ── Session options ─────────────────────────────────────────────────────────

export const VoiceFormatSchema = z.enum(['opus', 'pcm16']);

export const VoiceOptsSchema: z.ZodType<VoiceOpts> = z.object({
  agentId: z.string().min(1),
  format: VoiceFormatSchema,
  sampleRate: z.number().int().positive(),
});

// ── WebRTC signaling ────────────────────────────────────────────────────────

export const VoiceSignalTypeSchema = z.enum(['offer', 'answer', 'ice']);

/**
 * Note: the schema intentionally allows the un-typed combinations (e.g. an
 * `offer` without `sdp`) so that a forgiving relay can pass partial frames
 * through. Peers MUST themselves reject incoherent signals. We picked
 * "validate the wire shape, leave semantics to the peer" to match the rest
 * of `@openclaw/protocol`.
 */
export const VoiceSignalSchema: z.ZodType<VoiceSignal> = z.object({
  type: VoiceSignalTypeSchema,
  sdp: z.string().optional(),
  candidate: z.string().optional(),
});

// ── WS-frame fallback ───────────────────────────────────────────────────────

/**
 * `data` is a `Uint8Array`. See the file-level note above for the rationale
 * and the transport contract around binary coercion.
 */
export const VoiceFrameSchema: z.ZodType<VoiceFrame> = z.object({
  seq: z.number().int().nonnegative(),
  data: z.instanceof(Uint8Array),
});

// ── Live transcript ─────────────────────────────────────────────────────────

export const VoiceTranscriptSchema: z.ZodType<VoiceTranscript> = z.object({
  text: z.string(),
  isFinal: z.boolean(),
  ts: z.number().int().nonnegative(),
});

// ── Re-export the version constant alongside the schemas ────────────────────

export { VOICE_SCHEMA_VERSION };
