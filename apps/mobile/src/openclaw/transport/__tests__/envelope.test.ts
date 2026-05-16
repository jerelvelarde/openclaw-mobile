// Envelope encode/decode round-trip tests against the protocol package.
//
// Even though the canonical envelope tests live in `@openclaw/protocol`,
// we keep a mobile-side suite to verify that the workspace link resolves
// from inside `apps/mobile` AND that the transport layer (`ws.decodeFrame`)
// validates against the right schemas. The latter is the part most likely
// to drift if someone adds a new payload type without updating the WS
// validator.

import {
  encode,
  ThreadEventSchema,
  decode,
  type Envelope,
  type ThreadEvent,
} from '@openclaw/protocol';

import { decodeFrame } from '../ws';

const ThreadEventEnvelopeSchema = ThreadEventSchema;

describe('envelope round-trip', () => {
  it('encodes + decodes a thread message frame without loss', () => {
    const frame: Envelope<ThreadEvent> = {
      id: 'frame_1',
      topic: 'threads.thread_42',
      type: 'message',
      payload: {
        type: 'message',
        message: {
          id: 'msg_1',
          threadId: 'thread_42',
          role: 'assistant',
          content: 'hello',
          createdAt: 1_700_000_000_000,
        },
      },
      ts: 1_700_000_000_000,
    };
    const raw = encode(frame);
    const decoded = decode(raw, ThreadEventEnvelopeSchema);
    expect(decoded).toEqual(frame);
  });

  it('decodeFrame rejects a frame with a payload that does not match the schema', () => {
    // `type` is required on every ThreadEvent variant; an empty payload
    // can't satisfy any of the discriminated-union branches.
    const malformed = JSON.stringify({
      id: 'frame_2',
      topic: 'threads.x',
      type: 'unknown',
      payload: {},
      ts: 1,
    });
    expect(() => decodeFrame(malformed, ThreadEventEnvelopeSchema)).toThrow();
  });

  it('decodeFrame rejects malformed JSON with a clear error message', () => {
    expect(() => decodeFrame('{not-json', ThreadEventEnvelopeSchema)).toThrow(/Malformed JSON/);
  });

  it('decodeFrame rejects an envelope missing required fields', () => {
    // No `id` / `topic` — the envelope schema fails before the payload.
    const malformed = JSON.stringify({ type: 'message', payload: {} });
    expect(() => decodeFrame(malformed, ThreadEventEnvelopeSchema)).toThrow();
  });
});
