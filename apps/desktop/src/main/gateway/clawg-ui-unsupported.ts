// `unsupportedInRealMode` surfaces for the clawg-ui pivot (P11A).
//
// The `@contextableai/clawg-ui` plugin we route real-mode chat through
// (`vendor/clawg-ui/` @ v0.7.0) is **chat-only by design**:
// `vendor/clawg-ui/src/channel.ts:20–23` sets
// `chatTypes: ["direct"], blockStreaming: true`. There is no `canvas.*`
// analogue, no `talk.*` (voice) analogue, and no `agents.setActive`
// equivalent because the plugin routes per-request via
// `X-OpenClaw-Agent-Id` instead of a persistent "active agent" state.
//
// In `gateway_mode === "clawg-ui"` the legacy P10A bridge (which used
// to short-circuit these surfaces with a typed error envelope) is no
// longer instantiated. To keep clients seeing structured errors instead
// of timeouts, we subscribe to the same topics here and reply with the
// same `unsupportedInRealMode` shape the bridge used (see
// `apps/desktop/src/main/gateway/openclaw-bridge.ts#UnsupportedInRealModeError`).
//
// Q41 (open-questions §41) asked for UI surfacing of these errors. The
// renderer's `useGateway` hook already renders `lastError` from the
// transport — that drives a banner in the Chat surface. We additionally
// log each error on the main side so a developer running the desktop
// in a terminal sees the unsupported call immediately. A toast-style
// renderer treatment is a follow-up; the structured error shape is the
// contract this plan owns.

import type { Router } from '../transport/router';

/**
 * Error envelope returned to clients when a router topic is not
 * supported in clawg-ui mode. Wire-compatible with the bridge's
 * `UnsupportedInRealModeError` (`gateway/openclaw-bridge.ts`).
 */
export interface UnsupportedInRealModeError {
  ok: false;
  reason: 'unsupportedInRealMode';
  feature: 'canvas' | 'voice' | 'agentsSetActive';
  detail: string;
}

const UNSUPPORTED_DETAIL = {
  canvas:
    'Canvas surfaces are not supported in clawg-ui mode — the @contextableai/clawg-ui plugin is chat-only (P11A; see vendor/clawg-ui/src/channel.ts:20–23). Tracked in P11C.',
  voice:
    'Voice sessions are not supported in clawg-ui mode — the @contextableai/clawg-ui plugin is chat-only (P11A). Tracked in P11C.',
  agentsSetActive:
    'agents.setActive is not supported in clawg-ui mode — the plugin routes per-request via the X-OpenClaw-Agent-Id header instead of a persistent active-agent state (P11A).',
} as const;

function unsupported(feature: keyof typeof UNSUPPORTED_DETAIL): UnsupportedInRealModeError {
  return {
    ok: false,
    reason: 'unsupportedInRealMode',
    feature,
    detail: UNSUPPORTED_DETAIL[feature],
  };
}

/** Handle returned by {@link attachClawgUiUnsupportedSurfaces}. */
export interface ClawgUiUnsupportedAttachment {
  /** Tear down every router subscription this module installed. */
  detach(): void;
}

/** Inputs to {@link attachClawgUiUnsupportedSurfaces}. */
export interface AttachClawgUiUnsupportedOptions {
  router: Router;
  /**
   * Optional logger sink. Defaults to `console.warn` so a developer
   * running the desktop in a terminal sees the unsupported call land.
   * Tests inject a recording function.
   */
  log?: (msg: string) => void;
}

/**
 * Subscribe to `canvas.*` / `voice.*` (`talk.*`) / `agents.setActive`
 * and reply with `unsupportedInRealMode` envelopes. Idempotent within a
 * single router — the WS server's broadcaster fans the reply back to the
 * originating session only.
 *
 * Returns a handle whose `detach()` removes every subscription. Call
 * this from `apps/desktop/src/main/index.ts` whenever
 * `settings.gateway_mode === "clawg-ui"`.
 */
export function attachClawgUiUnsupportedSurfaces(
  opts: AttachClawgUiUnsupportedOptions,
): ClawgUiUnsupportedAttachment {
  const log =
    opts.log ??
    ((msg: string): void => {
      // eslint-disable-next-line no-console
      console.warn(msg);
    });

  const unsubs: Array<() => void> = [];

  // Canvas (`canvas.get`, `canvas.event`, `canvas.*`).
  unsubs.push(
    opts.router.subscribe('canvas', (frame, ctx) => {
      log(
        `[openclaw] clawg-ui mode: canvas topic "${frame.topic}" unsupported (P11A); replying with unsupportedInRealMode`,
      );
      // We reply on a `*.error` topic so the WS client doesn't confuse
      // an error envelope with a normal `canvas.surface` / `canvas.patch`
      // payload. Mirrors the bridge's approach.
      const errType = `${frame.type}.error`;
      ctx.reply(errType, unsupported('canvas'), { id: frame.id, topic: 'canvas.get.error' });
    }),
  );

  // Voice (`talk.start`, `talk.audio.in`, etc.).
  unsubs.push(
    opts.router.subscribe('talk', (frame, ctx) => {
      log(
        `[openclaw] clawg-ui mode: voice topic "${frame.topic}" unsupported (P11A); replying with unsupportedInRealMode`,
      );
      ctx.reply(`${frame.type}.error`, unsupported('voice'), { id: frame.id, topic: 'talk.error' });
    }),
  );

  // agents.setActive (no persistent active agent in clawg-ui).
  unsubs.push(
    opts.router.subscribe('agents.setActive', (frame, ctx) => {
      log(
        '[openclaw] clawg-ui mode: agents.setActive unsupported (P11A); replying with unsupportedInRealMode',
      );
      ctx.reply('agents.setActive.response', unsupported('agentsSetActive'), { id: frame.id });
    }),
  );

  return {
    detach(): void {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // ignore — best-effort teardown
        }
      }
      unsubs.length = 0;
    },
  };
}
