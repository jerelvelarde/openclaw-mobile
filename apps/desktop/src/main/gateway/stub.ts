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
import type {
  Agent,
  CanvasSurface,
  Message,
  ThreadEvent,
  VoiceTranscript,
} from '@openclaw/protocol';
import { CANVAS_SCHEMA_VERSION, voiceTopics } from '@openclaw/protocol';
import type { Router } from '../transport/router';
import {
  VOICE_FRAME_REPLY_TYPE,
  VOICE_TRANSCRIPT_TYPE,
  type VoiceFrameWire,
} from '../voice/agentBridge';
import { parseVoiceTopic } from '../voice/router';

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
  /**
   * Milliseconds between the inbound offer landing and the canned voice
   * reply firing. Default 30 — long enough to let the answer SDP land
   * back at the phone first, short enough to keep tests snappy. Set to
   * `0` in unit tests so the reply lands on the next microtask.
   */
  voiceReplyDelayMs?: number;
}

// ── Canned voice reply ──────────────────────────────────────────────────────
//
// The stub emits a 200ms (≈ 20 × 10ms frames) sine wave at 16 kHz mono
// PCM16 over `voice.<sessionId>.frame` with type `voice.frame.reply`,
// along with a single final `VoiceTranscript` on
// `voice.<sessionId>.transcript`. This is enough to exercise the full
// PTT loop end-to-end (mobile holds-to-talk → desktop forwards → "agent"
// replies → desktop streams reply audio + transcript back) without
// pulling in a real Opus encoder or shipping a binary asset. P09B's
// packaging pipeline can replace the canned generator with a bundled
// `resources/voice/canned-reply.opus` once we have a real Opus codec
// path on the desktop.

const VOICE_REPLY_TRANSCRIPT = 'Echo (stub voice reply).';
const VOICE_REPLY_SAMPLE_RATE = 16_000;
const VOICE_REPLY_FRAMES = 20; // 200ms total.
const VOICE_REPLY_SAMPLES_PER_FRAME = VOICE_REPLY_SAMPLE_RATE / 100; // 10ms.
const VOICE_REPLY_FREQ_HZ = 440; // A4 — innocuous.
const VOICE_REPLY_AMPLITUDE = 8_000; // ~-12dBFS so test playback isn't shrill.

/**
 * Build one 10ms PCM16 frame at `frameIdx` of a 440Hz sine wave. Exposed
 * (un-exported) here rather than tucked away so the voice tests can be
 * read alongside the stub.
 */
function buildSineFrame(frameIdx: number): VoiceFrameWire {
  const samples = new Array<number>(VOICE_REPLY_SAMPLES_PER_FRAME);
  const startSample = frameIdx * VOICE_REPLY_SAMPLES_PER_FRAME;
  for (let i = 0; i < VOICE_REPLY_SAMPLES_PER_FRAME; i += 1) {
    const t = (startSample + i) / VOICE_REPLY_SAMPLE_RATE;
    samples[i] = Math.round(
      Math.sin(2 * Math.PI * VOICE_REPLY_FREQ_HZ * t) * VOICE_REPLY_AMPLITUDE,
    );
  }
  return {
    seq: frameIdx,
    format: 'pcm16',
    sampleRate: VOICE_REPLY_SAMPLE_RATE,
    channelCount: 1,
    numberOfFrames: VOICE_REPLY_SAMPLES_PER_FRAME,
    samples,
  };
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
  const voiceReplyDelayMs = opts.voiceReplyDelayMs ?? 30;
  const agents = [...STUB_AGENTS];
  const unsubs: Array<() => void> = [];
  // Sessions for which we've already fired the canned reply, so a flood
  // of ICE candidates doesn't re-trigger the audio loop. The set
  // intentionally outlives `voice.<sid>.signal { close }` — voice
  // sessions in the stub are one-shot.
  const repliedSessions = new Set<string>();

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

  // ---- Voice canned reply ------------------------------------------------
  // P07B step 5: the stub agent emits a pre-recorded transcript + a
  // synthetic PCM16 reply clip so the full PTT loop is testable end-to-
  // end without a real agent. We trip on the first `offer` signal per
  // session (the phone always opens the WebRTC handshake), wait
  // `voiceReplyDelayMs` ms so the desktop's answer SDP can land back at
  // the phone first, then fire the canned response.
  unsubs.push(
    router.subscribe('voice', (frame, ctx) => {
      const route = parseVoiceTopic(frame.topic);
      if (!route || route.sub !== 'signal') return;
      if (frame.type !== 'voice.signal') return;
      const payload = (frame.payload ?? {}) as { type?: unknown };
      if (payload.type !== 'offer') return;
      if (repliedSessions.has(route.sessionId)) return;
      repliedSessions.add(route.sessionId);

      const sessionId = route.sessionId;
      const fire = (): void => {
        // 1. Final transcript first — clients render it as soon as it
        //    arrives so the user sees a confirmation even if the audio
        //    path drops a frame or two.
        const transcript: VoiceTranscript = {
          text: VOICE_REPLY_TRANSCRIPT,
          isFinal: true,
          ts: Date.now(),
        };
        ctx.reply(VOICE_TRANSCRIPT_TYPE, transcript, {
          topic: voiceTopics.transcript(sessionId),
        });

        // 2. Stream the synthetic sine wave as a sequence of
        //    `voice.frame.reply` envelopes on `voice.<sid>.frame`. The
        //    agent bridge on this side will pull these onto the peer's
        //    outbound track, and the phone will hear it through the
        //    WebRTC peer connection. If the WS-frames fallback is in
        //    use, the phone subscribes to the same topic directly.
        for (let i = 0; i < VOICE_REPLY_FRAMES; i += 1) {
          const wire = buildSineFrame(i);
          ctx.reply(VOICE_FRAME_REPLY_TYPE, wire, {
            topic: voiceTopics.frame(sessionId),
          });
        }
      };

      if (voiceReplyDelayMs <= 0) {
        queueMicrotask(fire);
      } else {
        setTimeout(fire, voiceReplyDelayMs);
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
    get agents() {
      return [...agents];
    },
  };
}
