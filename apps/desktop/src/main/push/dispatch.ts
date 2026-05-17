// Gateway-event → push-notification dispatcher.
//
// Per P08B step 4: subscribe to the gateway events that warrant nudging
// the user, look up paired devices that have registered an Expo push
// token, build a payload, and hand it to the push client.
//
// Which events warrant a push?
//
//   - `threads.event` of type `message` whose role is `assistant`. Mobile
//     wants a banner when an agent replies while the app is backgrounded.
//   - Voice-request signals (`voice.<sid>.signal` with `type: 'offer'`
//     coming *from the desktop side*). For v1 the stub gateway never
//     emits these — the offer always originates at the phone — but the
//     subscription is in place so a future "agent wants to speak" flow
//     just works.
//   - `threads.event` of type `done` is the closest stand-in for "long
//     task finished" in the current protocol. We notify on `done` for
//     assistant messages whose content is non-trivial. This is the
//     trigger the plan refers to as "long-task finished"; the real
//     gateway can later swap it for an explicit `tasks.finished` topic
//     and we update the matcher.
//
// Throttle: max one notification per thread per `THROTTLE_WINDOW_MS`. A
// flurry of token deltas + a final `done` for the same thread collapses
// to a single push. Implemented as an in-memory `Map<threadId, lastTs>`
// — process restart resets the throttle, which is fine because devices
// drop notifications across restarts anyway.

import type { Message, ThreadEvent } from '@openclaw/protocol';
import type { InboundFrame, Router } from '../transport/router';
import type { PushDeviceRegistry } from './devices';
import type { PushClient, PushNotification } from './expoClient';

/** Window during which a second push for the same thread is suppressed. */
export const THROTTLE_WINDOW_MS = 30_000;

/** Max characters of the user-visible body before we truncate with an ellipsis. */
export const BODY_SNIPPET_MAX = 140;

/** Inputs the dispatcher needs at construction time. */
export interface DispatcherOptions {
  router: Router;
  /** Source of paired devices + their push tokens. */
  registry: PushDeviceRegistry;
  /** Push transport. May be `null` if the SDK failed to load — dispatch becomes a no-op. */
  pushClient: PushClient | null;
  /**
   * Agent display name resolver. Defaults to "OpenClaw" if not provided.
   * Dispatch passes the inbound frame so a future caller can look at
   * `payload.agentId` / `payload.threadId` to scope the lookup. The
   * current stub gateway always uses the same agent name so the default
   * is fine for v1.
   */
  resolveAgentName?: (frame: InboundFrame) => string;
  /** Override the throttle window (ms). Tests use 0 to disable. */
  throttleWindowMs?: number;
  /** Test seam for the current time. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam for logging. Defaults to `console.warn`. */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/** Handle returned by `attachPushDispatcher` so the main process can detach. */
export interface PushDispatcher {
  /** Drop every router subscription. */
  detach(): void;
  /**
   * Synchronously fire a notification for a hand-crafted payload — used
   * by tests + by future code paths that want to push without going
   * through the gateway loop (e.g. a "pair approved" toast).
   */
  notify(payload: NotifyPayload): Promise<void>;
  /** Test/diagnostic: peek the throttle map. */
  _throttleSnapshot(): Map<string, number>;
}

/**
 * Payload used by `notify`. Mirrors what dispatch builds internally so
 * the unit tests can drive the dispatcher without forging an inbound
 * gateway frame.
 */
export interface NotifyPayload {
  threadId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Wire the dispatcher into the given router. Returns a handle whose
 * `detach()` removes the subscriptions — necessary for tests that build
 * a fresh router per case, and for clean shutdown in `index.ts`.
 */
export function attachPushDispatcher(opts: DispatcherOptions): PushDispatcher {
  const throttleWindow = opts.throttleWindowMs ?? THROTTLE_WINDOW_MS;
  const resolveAgentName = opts.resolveAgentName ?? ((): string => 'OpenClaw');
  const now = opts.now ?? ((): number => Date.now());
  const log = opts.logger ?? defaultLogger;
  const lastSent = new Map<string, number>();
  const unsubs: Array<() => void> = [];

  function shouldThrottle(threadId: string): boolean {
    if (throttleWindow <= 0) return false;
    const prev = lastSent.get(threadId);
    if (prev === undefined) return false;
    return now() - prev < throttleWindow;
  }

  function markSent(threadId: string): void {
    lastSent.set(threadId, now());
  }

  async function notify(payload: NotifyPayload): Promise<void> {
    if (!opts.pushClient) {
      log('info', '[push] no push client; dropping notification', { threadId: payload.threadId });
      return;
    }
    if (shouldThrottle(payload.threadId)) {
      log('info', '[push] throttled', { threadId: payload.threadId });
      return;
    }
    const targets = opts.registry.listPushTargets();
    if (targets.length === 0) return;
    const notifs: PushNotification[] = targets.map((t) => ({
      token: t.pushToken,
      title: payload.title,
      body: payload.body,
      data: payload.data,
    }));
    markSent(payload.threadId);
    try {
      const result = await opts.pushClient.sendNotifications(notifs);
      if (result.error) {
        log('warn', '[push] sendNotifications surfaced error', result.error.message);
      }
    } catch (err) {
      // Defensive: createPushClient catches its own errors but a fake or
      // a future variant might throw — never let one bad batch take down
      // the gateway loop.
      log('error', '[push] sendNotifications threw', err);
    }
  }

  // We hook the router's *outbound* path rather than `subscribe`. The
  // gateway → mobile direction (assistant messages, voice signals from
  // an agent) flows through `router.publish` / `ctx.reply`, both of
  // which fan out via the broadcaster + every registered outbound
  // observer. Subscribing to topics would only fire on *inbound* mobile
  // frames (the wrong direction for a notification).
  unsubs.push(
    opts.router.onOutbound((frame) => {
      // ---- thread events ------------------------------------------------
      // `threads.event` envelopes carry the `ThreadEvent` discriminated
      // union we re-export from `@openclaw/protocol`. We only notify on
      // the two shapes the user actually wants to know about: a fresh
      // assistant message and the `done` marker that closes a streamed
      // reply (our current proxy for "task finished").
      if (frame.type === 'threads.event') {
        const event = frame.payload as ThreadEvent | undefined;
        if (!event || typeof event !== 'object') return;
        if (event.type === 'message' && isAssistantMessage(event.message)) {
          const threadId = event.message.threadId;
          if (!threadId) return;
          void notify({
            threadId,
            title: resolveAgentName(frame),
            body: snippet(event.message.content),
            data: { threadId, kind: 'assistant_message' },
          });
          return;
        }
        if (event.type === 'done') {
          // We don't have the message text on a `done`, but we still
          // want to nudge the user. The throttle map will collapse a
          // back-to-back `message` → `done` pair into a single push,
          // which is what we want.
          void notify({
            threadId: event.messageId ?? 'unknown',
            title: resolveAgentName(frame),
            body: 'Agent finished.',
            data: { kind: 'task_finished' },
          });
        }
        return;
      }

      // ---- Voice request from desktop side ------------------------------
      // The stub gateway never emits a desktop-originated offer, but a
      // real agent could. Only react to `offer` signals tagged with
      // `from: 'agent'` so we don't push on every phone-initiated PTT.
      if (frame.type === 'voice.signal') {
        const payload = (frame.payload ?? {}) as { type?: unknown; from?: unknown };
        if (payload.type !== 'offer') return;
        if (payload.from !== 'agent') return;
        const sessionId = frame.topic.split('.')[1] ?? 'voice';
        void notify({
          threadId: `voice:${sessionId}`,
          title: resolveAgentName(frame),
          body: 'Agent is requesting voice.',
          data: { sessionId, kind: 'voice_request' },
        });
      }
    }),
  );

  return {
    detach() {
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      unsubs.length = 0;
    },
    notify,
    _throttleSnapshot() {
      return new Map(lastSent);
    },
  };
}

function isAssistantMessage(message: Message | undefined): message is Message {
  return !!message && message.role === 'assistant' && typeof message.content === 'string';
}

function snippet(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= BODY_SNIPPET_MAX) return trimmed;
  return `${trimmed.slice(0, BODY_SNIPPET_MAX - 1)}…`;
}

function defaultLogger(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  // eslint-disable-next-line no-console
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) sink(msg, meta);
  else sink(msg);
}
