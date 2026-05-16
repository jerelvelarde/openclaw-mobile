// TODO: replace with real OpenClaw gateway bridge.
//
// Stub in-process gateway. Subscribes to the topics mobile cares about
// and returns shapes that match `@openclaw/protocol`'s mock so the
// mobile end-to-end works before the real gateway WS is wired (P05C
// + the OpenClaw integration effort).
//
// Wire format per `desktop-app.md` §5: every frame is an `Envelope<T>`
// with `topic` ∈ {`threads.*`, `agents.*`, `canvas.*`, `voice.*`,
// `system.*`}, `type` discriminating inside the topic. Mobile sends a
// frame; this module replies via `ctx.reply` (single-session) or
// `router.publish` (broadcast). Replies are scoped to the session that
// asked: every handler gets `ctx.deviceId` from the bearer token claim,
// and `ctx.reply` only fans out to that device.

import { randomUUID } from 'node:crypto';
import type { Agent, CanvasSurface, Message, ThreadEvent } from '@openclaw/protocol';
import { CANVAS_SCHEMA_VERSION } from '@openclaw/protocol';
import type { Router } from '../transport/router';

/** Fake agents — same ids as `InMemoryMockGateway`'s defaults. */
const STUB_AGENTS: Agent[] = [
  {
    id: 'openclaw.default',
    name: 'OpenClaw',
    description: 'Default OpenClaw skill agent (stub).',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Hermes Agent (Nous Research) via OpenClaw routing (stub).',
  },
];

/** Trigger phrase that causes the stub to emit a `canvas.surface` event. */
const CANVAS_TRIGGER = 'canvas';

/** Tunable knobs — exposed so tests can disable timers. */
export interface StubOptions {
  /** Milliseconds between user post and streamed reply. Default 50. */
  replyDelayMs?: number;
}

/** Public surface: subscribe to the router, return a teardown handle. */
export interface StubGateway {
  /** Unwire every subscription set up by `attachStubGateway`. */
  detach(): void;
  /** Current agent list (exposed for tests + diagnostics). */
  readonly agents: Agent[];
}

interface StubPostPayload {
  threadId?: unknown;
  content?: unknown;
  agentId?: unknown;
}

interface StubSetActiveAgentPayload {
  agentId?: unknown;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Wire the stub gateway into the given router. Returns a handle whose
 * `detach()` unsubscribes everything — useful for tests that build a
 * fresh router per case.
 */
export function attachStubGateway(router: Router, opts: StubOptions = {}): StubGateway {
  const replyDelayMs = opts.replyDelayMs ?? 50;
  const agents = [...STUB_AGENTS];
  const unsubs: Array<() => void> = [];

  unsubs.push(
    router.subscribe('agents.list', (frame, ctx) => {
      ctx.reply('agents.list.response', { agents }, { id: frame.id });
    }),
  );

  unsubs.push(
    router.subscribe('agents.setActive', (frame, ctx) => {
      const payload = (frame.payload ?? {}) as StubSetActiveAgentPayload;
      const agentId = asString(payload.agentId);
      const ok = agentId !== null && agents.some((a) => a.id === agentId);
      ctx.reply(
        'agents.setActive.response',
        ok ? { ok: true, agentId } : { ok: false, reason: 'unknown agent' },
        { id: frame.id },
      );
    }),
  );

  unsubs.push(
    router.subscribe('threads.post', (frame, ctx) => {
      const payload = (frame.payload ?? {}) as StubPostPayload;
      const threadId = asString(payload.threadId) ?? 'thread_stub';
      const content = asString(payload.content) ?? '';
      const userMessage: Message = {
        id: `msg_${randomUUID()}`,
        threadId,
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      // 1. Acknowledge the user message immediately.
      ctx.reply('threads.event', { type: 'message', message: userMessage } satisfies ThreadEvent, {
        id: frame.id,
      });

      // 2. Schedule a streamed echo reply.
      const assistantId = `msg_${randomUUID()}`;
      const fire = (): void => {
        const reply: Message = {
          id: assistantId,
          threadId,
          role: 'assistant',
          content: `Echo: ${content}`,
          createdAt: Date.now(),
        };
        ctx.reply('threads.event', {
          type: 'message',
          message: reply,
        } satisfies ThreadEvent);
        ctx.reply('threads.event', {
          type: 'token',
          messageId: assistantId,
          delta: reply.content,
        } satisfies ThreadEvent);
        ctx.reply('threads.event', {
          type: 'tool_call',
          messageId: assistantId,
          toolName: 'echo.lookup',
          args: { input: content },
        } satisfies ThreadEvent);
        ctx.reply('threads.event', {
          type: 'done',
          messageId: assistantId,
        } satisfies ThreadEvent);

        // 3. If the user message contains the canvas trigger, emit a
        // surface event so renderer Canvas plumbing has something to
        // render in dev. Real surface schema lands in P06.0.
        if (content.toLowerCase().includes(CANVAS_TRIGGER)) {
          const surfaceId = `surface_${randomUUID()}`;
          const surface: CanvasSurface = {
            id: surfaceId,
            version: CANVAS_SCHEMA_VERSION,
            root: {
              type: 'stack',
              id: `${surfaceId}_root`,
              direction: 'vertical',
              children: [
                {
                  type: 'heading',
                  id: `${surfaceId}_title`,
                  text: 'Canvas (stub)',
                  level: 1,
                },
                {
                  type: 'text',
                  id: `${surfaceId}_body`,
                  text: `Triggered by message: ${content}`,
                },
              ],
            },
          };
          ctx.reply('canvas.surface', surface);
        }
      };

      if (replyDelayMs <= 0) {
        queueMicrotask(fire);
      } else {
        setTimeout(fire, replyDelayMs);
      }
    }),
  );

  unsubs.push(
    router.subscribe('system.ping', (frame, ctx) => {
      ctx.reply('system.pong', { ts: Date.now() }, { id: frame.id });
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
    get agents() {
      return [...agents];
    },
  };
}
