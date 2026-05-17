// Topic-based dispatch router for the desktop WS server.
//
// Per P04B step 4: the router owns three things:
//
//   1. A subscribe(topic, handler) API for in-process consumers (the stub
//      gateway, future agent bridges) to receive incoming frames.
//   2. A publish(topic, payload) API for those consumers to push frames
//      back out to every subscribed WS session.
//   3. Envelope-level validation (via `@openclaw/protocol`'s
//      `envelopeSchema`) before any handler sees a frame.
//
// "Topic" is the coarse routing key from the envelope (`threads.*`,
// `agents.*`, `canvas.*`, `voice.*`, `system.*`). Subscribers can listen
// to a prefix (e.g. `threads`) which fans out to every dotted child
// (`threads.list`, `threads.post`, …) — keeps the gateway's handler
// surface small without forcing it to subscribe per-type.
//
// The router is transport-agnostic on the *publish* side: callers pass
// `(topic, payload)` and an optional `{ id, type, ts }` override. The
// WS server is what actually serialises envelopes and pushes them to
// sockets — see `wsServer.ts`'s `Sessions` map for the fan-out.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { envelopeSchema, type Envelope } from '@openclaw/protocol';

/** Frame schema with an `unknown` payload — handlers cast as they see fit. */
const FrameSchema = envelopeSchema(z.unknown());

/** Decoded inbound frame, as seen by a topic handler. */
export type InboundFrame = Envelope<unknown>;

/** Subscriber callback. May be async. */
export type TopicHandler = (frame: InboundFrame, ctx: HandlerContext) => void | Promise<void>;

/** Per-frame context handed to handlers — lets them publish back out. */
export interface HandlerContext {
  /** Device id of the session that sent the frame (from the bearer token). */
  deviceId: string;
  /** Publish a frame back to the *originating* session only. */
  reply: (
    type: string,
    payload: unknown,
    overrides?: { id?: string; topic?: string; ts?: number },
  ) => void;
}

/** Fan-out hook owned by the WS server: send `frame` to every relevant socket. */
export type Broadcaster = (frame: InboundFrame, target?: { deviceId?: string }) => void;

/**
 * Observer for *outbound* frames — i.e. anything the desktop side emits
 * via `router.publish` or `ctx.reply`. Used by the push dispatcher
 * (P08B) to translate agent events into Expo notifications without
 * fighting with the broadcaster (which the WS server owns).
 */
export type OutboundObserver = (frame: InboundFrame, target?: { deviceId?: string }) => void;

/** Public surface of the router. */
export interface Router {
  /**
   * Subscribe to a topic. The `topic` can be a full topic
   * (`threads.post`) or a prefix (`threads`); the latter matches any
   * dotted child. Returns an unsubscribe fn.
   */
  subscribe(topic: string, handler: TopicHandler): () => void;
  /**
   * Publish a frame to every subscribed *session* (i.e. broadcast over
   * WS). Use `target.deviceId` to scope the publish to one device.
   */
  publish(
    topic: string,
    type: string,
    payload: unknown,
    overrides?: { id?: string; ts?: number; target?: { deviceId?: string } },
  ): InboundFrame;
  /**
   * Feed an inbound raw string (as received from a WS socket) through
   * the router. Returns an error message on validation failure, or
   * `null` if the frame was dispatched (or quietly dropped because no
   * handler matched — that's not a protocol error).
   */
  dispatchRaw(raw: string, ctx: { deviceId: string }): string | null;
  /** Attach the WS-side broadcaster. The WS server wires this on boot. */
  setBroadcaster(fn: Broadcaster | null): void;
  /**
   * Register a passive observer that sees every outbound frame *before*
   * the broadcaster runs. Multiple observers may be attached. Returns an
   * unsubscribe fn. Used by the push dispatcher to mirror outbound
   * frames into Expo notifications; can be re-used by future
   * telemetry / debug tooling.
   */
  onOutbound(fn: OutboundObserver): () => void;
  /** Test-only: list registered topic prefixes (for assertions). */
  _topics(): string[];
}

function matches(subscription: string, topic: string): boolean {
  // Exact match.
  if (subscription === topic) return true;
  // Prefix match: subscriber `threads` should fire for `threads.post` etc.
  return topic.startsWith(`${subscription}.`);
}

/** Build a fresh router. Pure factory — no global state. */
export function createRouter(): Router {
  const handlers = new Map<string, Set<TopicHandler>>();
  let broadcaster: Broadcaster | null = null;
  const outboundObservers = new Set<OutboundObserver>();

  function emitOutbound(frame: InboundFrame, target?: { deviceId?: string }): void {
    // Observers see the frame first. Errors are isolated so a misbehaving
    // observer can't take down the WS fan-out path.
    for (const obs of [...outboundObservers]) {
      try {
        obs(frame, target);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[openclaw] router outbound observer error:', err);
      }
    }
    broadcaster?.(frame, target);
  }

  function buildContext(deviceId: string): HandlerContext {
    return {
      deviceId,
      reply: (type, payload, overrides) => {
        const inferredTopic = type.split('.').slice(0, -1).join('.') || type;
        const frame: InboundFrame = {
          id: overrides?.id ?? randomUUID(),
          topic: overrides?.topic ?? inferredTopic,
          type,
          payload,
          ts: overrides?.ts ?? Date.now(),
        };
        emitOutbound(frame, { deviceId });
      },
    };
  }

  async function dispatch(frame: InboundFrame, deviceId: string): Promise<void> {
    const ctx = buildContext(deviceId);
    // Run every matching subscription. We snapshot the set to avoid
    // re-entrancy issues if a handler subscribes / unsubscribes mid-fire.
    for (const [subscription, set] of handlers) {
      if (!matches(subscription, frame.topic)) continue;
      for (const handler of [...set]) {
        try {
          await handler(frame, ctx);
        } catch (err) {
          // Handler errors are logged but never crash the router — the
          // WS loop must stay alive even if one subscriber misbehaves.
          // eslint-disable-next-line no-console
          console.error('[openclaw] router handler error:', err);
        }
      }
    }
  }

  return {
    subscribe(topic, handler) {
      let set = handlers.get(topic);
      if (!set) {
        set = new Set();
        handlers.set(topic, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) handlers.delete(topic);
      };
    },
    publish(topic, type, payload, overrides) {
      const frame: InboundFrame = {
        id: overrides?.id ?? randomUUID(),
        topic,
        type,
        payload,
        ts: overrides?.ts ?? Date.now(),
      };
      emitOutbound(frame, overrides?.target);
      return frame;
    },
    dispatchRaw(raw, ctx) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return 'malformed JSON';
      }
      const result = FrameSchema.safeParse(parsed);
      if (!result.success) {
        return `envelope validation failed: ${result.error.issues[0]?.message ?? 'unknown'}`;
      }
      void dispatch(result.data, ctx.deviceId);
      return null;
    },
    setBroadcaster(fn) {
      broadcaster = fn;
    },
    onOutbound(fn) {
      outboundObservers.add(fn);
      return () => {
        outboundObservers.delete(fn);
      };
    },
    _topics() {
      return [...handlers.keys()];
    },
  };
}
