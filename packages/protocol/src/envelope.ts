// WS frame envelope. The desktop app's protocol surface (see
// `.chalk/desktop-app.md` §5) sends every payload wrapped in:
//
//     { id, topic, type, payload, ts }
//
// `id` is a per-frame correlation id (set by the sender), `topic` is the
// coarse routing key (`threads.*`, `agents.*`, `canvas.*`, `voice.*`,
// `system.*`), `type` is the discriminator inside that topic, `payload` is
// the body, and `ts` is the sender's clock as epoch ms.
//
// This file only handles JSON (en|de)coding + Zod validation. Transport
// (WebSocket framing, heartbeats, reconnect) lives in the per-app
// transport plans (P04A / P04B) — see the constraints in
// `.chalk/plans/P01A-protocol-package.md`.

import { z, type ZodType } from 'zod';

/** Frame envelope wrapping every WS payload. */
export interface Envelope<T> {
  id: string;
  topic: string;
  type: string;
  payload: T;
  ts: number;
}

/**
 * Build a Zod schema for an `Envelope<T>` given a schema for the payload.
 * Exposed for callers (e.g. transports in P04A/P04B) that want to validate
 * the entire frame in one call instead of two.
 */
export function envelopeSchema<T>(payload: ZodType<T>): ZodType<Envelope<T>> {
  return z.object({
    id: z.string().min(1),
    topic: z.string().min(1),
    type: z.string().min(1),
    payload,
    ts: z.number().int().nonnegative(),
  }) as ZodType<Envelope<T>>;
}

/** Serialize an envelope to a JSON string for sending over the wire. */
export function encode<T>(e: Envelope<T>): string {
  return JSON.stringify(e);
}

/**
 * Parse a raw JSON string into a validated envelope. Throws `ZodError` if the
 * envelope shape or payload don't match. Throws `SyntaxError` if `raw` is
 * not valid JSON.
 */
export function decode<T>(raw: string, payloadSchema: ZodType<T>): Envelope<T> {
  const parsed: unknown = JSON.parse(raw);
  return envelopeSchema(payloadSchema).parse(parsed);
}
