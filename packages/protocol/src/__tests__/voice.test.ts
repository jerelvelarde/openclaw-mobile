// Tests for the v1 Voice schema (P07.0).
//
// Coverage:
//  - Round-trip: `VoiceOpts`, `VoiceSignal`, `VoiceFrame`, `VoiceTranscript`
//    serialize and re-parse to deep-equal values.
//  - Topic helpers produce the expected `voice.<sessionId>.*` strings.
//  - Schema rejection: invalid options, signals, frames, transcripts and
//    envelope-wrapped voice frames produce Zod errors with informative
//    issue paths.
//  - Envelope decoding: a voice signal / transcript wrapped in the standard
//    `{ id, topic, type, payload, ts }` envelope round-trips through
//    `encode` + `decode` against the topic's payload schema.

import { describe, expect, it } from 'vitest';

import {
  decode,
  encode,
  envelopeSchema,
  VOICE_SCHEMA_VERSION,
  VoiceFormatSchema,
  VoiceFrameSchema,
  VoiceOptsSchema,
  VoiceSignalSchema,
  VoiceSignalTypeSchema,
  VoiceTranscriptSchema,
  voiceTopics,
  type VoiceFrame,
  type VoiceOpts,
  type VoiceSignal,
  type VoiceTranscript,
} from '../index';

describe('Voice schemas (P07.0)', () => {
  it('exports a schema version constant', () => {
    expect(VOICE_SCHEMA_VERSION).toBe(1);
  });

  it('round-trips VoiceOpts', () => {
    const opts: VoiceOpts = {
      agentId: 'openclaw.default',
      format: 'opus',
      sampleRate: 48000,
    };
    const encoded = JSON.stringify(opts);
    expect(VoiceOptsSchema.parse(JSON.parse(encoded))).toEqual(opts);
  });

  it('accepts both supported audio formats', () => {
    expect(VoiceFormatSchema.parse('opus')).toBe('opus');
    expect(VoiceFormatSchema.parse('pcm16')).toBe('pcm16');
  });

  it('rejects an unsupported audio format', () => {
    expect(() =>
      VoiceOptsSchema.parse({ agentId: 'a', format: 'mp3', sampleRate: 44100 }),
    ).toThrowError();
  });

  it('rejects a non-positive sample rate', () => {
    expect(() =>
      VoiceOptsSchema.parse({ agentId: 'a', format: 'opus', sampleRate: 0 }),
    ).toThrowError();
    expect(() =>
      VoiceOptsSchema.parse({ agentId: 'a', format: 'opus', sampleRate: -1 }),
    ).toThrowError();
  });

  it('rejects an empty agent id', () => {
    expect(() =>
      VoiceOptsSchema.parse({ agentId: '', format: 'opus', sampleRate: 48000 }),
    ).toThrowError();
  });

  it('round-trips a WebRTC offer signal', () => {
    const sig: VoiceSignal = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n' };
    expect(VoiceSignalSchema.parse(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
  });

  it('round-trips a WebRTC answer signal', () => {
    const sig: VoiceSignal = { type: 'answer', sdp: 'v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\n' };
    expect(VoiceSignalSchema.parse(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
  });

  it('round-trips an ICE candidate signal', () => {
    const sig: VoiceSignal = {
      type: 'ice',
      candidate: 'candidate:1 1 UDP 2122194687 192.168.1.10 50000 typ host',
    };
    expect(VoiceSignalSchema.parse(JSON.parse(JSON.stringify(sig)))).toEqual(sig);
  });

  it('accepts an end-of-candidates ICE signal (empty candidate)', () => {
    const sig: VoiceSignal = { type: 'ice', candidate: '' };
    expect(VoiceSignalSchema.parse(sig)).toEqual(sig);
  });

  it('exports the signal-type enum schema', () => {
    expect(VoiceSignalTypeSchema.parse('offer')).toBe('offer');
    expect(VoiceSignalTypeSchema.parse('answer')).toBe('answer');
    expect(VoiceSignalTypeSchema.parse('ice')).toBe('ice');
    expect(() => VoiceSignalTypeSchema.parse('hangup')).toThrowError();
  });

  it('rejects a signal with an unknown type', () => {
    expect(() => VoiceSignalSchema.parse({ type: 'hangup', sdp: '' })).toThrowError();
  });

  it('round-trips a VoiceFrame with a Uint8Array payload', () => {
    const frame: VoiceFrame = { seq: 7, data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) };
    // Note: we don't JSON.stringify here — voice frames travel as binary, not
    // JSON. The schema validates whatever the transport hands us after binary
    // coercion. See `voice/schemas.ts` for the contract.
    const parsed = VoiceFrameSchema.parse(frame);
    expect(parsed.seq).toBe(7);
    expect(Array.from(parsed.data)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('rejects a frame whose data is not a Uint8Array', () => {
    expect(() =>
      VoiceFrameSchema.parse({ seq: 0, data: [0xde, 0xad] as unknown as Uint8Array }),
    ).toThrowError();
    expect(() =>
      VoiceFrameSchema.parse({
        seq: 0,
        data: new ArrayBuffer(4) as unknown as Uint8Array,
      }),
    ).toThrowError();
  });

  it('rejects a frame with a negative or non-integer seq', () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(() => VoiceFrameSchema.parse({ seq: -1, data })).toThrowError();
    expect(() => VoiceFrameSchema.parse({ seq: 1.5, data })).toThrowError();
  });

  it('round-trips a final VoiceTranscript fragment', () => {
    const t: VoiceTranscript = { text: 'Hello world.', isFinal: true, ts: 1730000000000 };
    expect(VoiceTranscriptSchema.parse(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('accepts an interim transcript with empty text', () => {
    const t: VoiceTranscript = { text: '', isFinal: false, ts: 1730000000000 };
    expect(VoiceTranscriptSchema.parse(t)).toEqual(t);
  });

  it('rejects a transcript with a non-boolean isFinal', () => {
    expect(() => VoiceTranscriptSchema.parse({ text: 'x', isFinal: 'yes', ts: 0 })).toThrowError();
  });

  it('builds voice topics keyed by session id', () => {
    expect(voiceTopics.signal('sess_1')).toBe('voice.sess_1.signal');
    expect(voiceTopics.frame('sess_1')).toBe('voice.sess_1.frame');
    expect(voiceTopics.transcript('sess_1')).toBe('voice.sess_1.transcript');
  });

  it('round-trips an envelope wrapping a VoiceSignal', () => {
    const sig: VoiceSignal = { type: 'offer', sdp: 'v=0\r\n' };
    const raw = encode({
      id: 'frame_1',
      topic: voiceTopics.signal('sess_1'),
      type: 'voice.signal',
      payload: sig,
      ts: 1730000000000,
    });
    const decoded = decode(raw, VoiceSignalSchema);
    expect(decoded.topic).toBe('voice.sess_1.signal');
    expect(decoded.payload).toEqual(sig);
  });

  it('round-trips an envelope wrapping a VoiceTranscript', () => {
    const t: VoiceTranscript = { text: 'partial', isFinal: false, ts: 1730000000001 };
    const raw = encode({
      id: 'frame_2',
      topic: voiceTopics.transcript('sess_2'),
      type: 'voice.transcript',
      payload: t,
      ts: 1730000000002,
    });
    const decoded = decode(raw, VoiceTranscriptSchema);
    expect(decoded.topic).toBe('voice.sess_2.transcript');
    expect(decoded.payload).toEqual(t);
  });

  it('envelopeSchema rejects a voice signal envelope with a bad payload', () => {
    const schema = envelopeSchema(VoiceSignalSchema);
    expect(() =>
      schema.parse({
        id: 'x',
        topic: 'voice.sess.signal',
        type: 'voice.signal',
        // Missing required `type` discriminator — must be offer|answer|ice.
        payload: { sdp: 'v=0' },
        ts: 0,
      }),
    ).toThrowError();
  });
});
