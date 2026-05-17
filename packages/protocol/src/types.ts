// Wire types for @openclaw/protocol.
//
// These mirror the GatewayClient surface sketched in `.chalk/plan.md` §7 and
// the protocol surface in `.chalk/desktop-app.md` §4–5. They are intentionally
// minimal: just enough fields for the mobile + desktop UIs to render and
// drive the in-memory mock gateway. The real wire format will be locked down
// once we read the OpenClaw gateway source (see `.chalk/open-questions.md` A.1).
//
// Every type here has a Zod schema in `schemas.ts`; prefer importing the
// `z.infer<>` alias from there if you want runtime validation. The plain
// types in this file exist so consumers can opt out of pulling Zod into
// their type graph.

/** A pairing token returned after the desktop app approves a phone. */
export interface Token {
  /** Opaque bearer token used as the WS `Authorization: Bearer …` credential. */
  value: string;
  /** Epoch ms when this token stops being accepted by the gateway. */
  expiresAt: number;
}

/** Request body posted from mobile to desktop to start a pairing flow. */
export interface PairingRequest {
  /** Human-readable device name shown in the desktop approval UI. */
  deviceName: string;
}

/** Response from the desktop after the user approves the pairing request. */
export interface PairingApproved {
  /** The 6-digit code shown on the phone and matched in the desktop UI. */
  code: string;
  /** Issued bearer token. */
  token: Token;
  /** URL the mobile app should hit for CopilotKit runtime calls. */
  runtimeUrl: string;
  /**
   * Optional base URL for the upstream `openclaw gateway` daemon when the
   * desktop is running in `gateway_mode: "clawg-ui"` (P11A/P11B). When
   * present, mobile chat in clawg-ui mode targets `<clawgUiBaseUrl>/v1/clawg-ui`
   * (per `vendor/clawg-ui/README.md:39-77`) rather than the desktop's
   * adapter. Defaults to `<httpBase host>:18789` (co-located deployment) but
   * is persisted as a discrete value so split-topology users (desktop on
   * laptop, daemon on home server) can override without rebuilding mobile.
   *
   * Optional for backward compatibility with older desktop builds that
   * don't advertise it; mobile falls back to deriving it from `httpBase`
   * when absent. Closes open question #46.
   */
  clawgUiBaseUrl?: string;
}

/**
 * An agent reachable through the gateway. Could be an OpenClaw built-in
 * skill agent or a Hermes Agent process exposed via OpenClaw routing.
 */
export interface Agent {
  /** Stable id, e.g. `"openclaw.default"` or `"hermes"`. */
  id: string;
  /** Display name. */
  name: string;
  /** Optional one-line description shown in the agents list. */
  description?: string;
}

/** A conversation thread between the user and an agent. */
export interface Thread {
  id: string;
  title: string;
  agentId: string;
  /** Epoch ms; newest threads sort first. */
  updatedAt: number;
}

/** Roles supported by a `Message`. Matches what the chat UI needs to render. */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** A persisted message in a thread. */
export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  /** Plain-text content. Rich content lives on Canvas surfaces, not in chat. */
  content: string;
  /** Epoch ms. */
  createdAt: number;
}

/** Caller-supplied payload when posting a new message. */
export interface MessageInput {
  /** Plain-text content typed (or transcribed) by the user. */
  content: string;
}

/**
 * Events streamed back from the gateway for a thread subscription. The shape
 * is a discriminated union so the renderer can switch on `type`. Mirrors the
 * frame envelope `type` field used at the WS layer.
 */
export type ThreadEvent =
  | {
      type: 'message';
      message: Message;
    }
  | {
      type: 'token';
      messageId: string;
      delta: string;
    }
  | {
      type: 'tool_call';
      messageId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'done';
      messageId: string;
    };

// `CanvasSurface` + `CanvasPatch` live in `./canvas/types.ts` as of P06.0.
// `VoiceOpts` + `VoiceSession` live in `./voice/types.ts` as of P07.0.
// Both are re-exported from `./index.ts` so consumers see the same import
// path they did before.

// ── clawg-ui pairing (P11B) ─────────────────────────────────────────────────

/**
 * State of the desktop's wrap of `clawg-ui`'s device-pairing flow
 * (`vendor/clawg-ui/README.md` §"Authentication"). When the desktop's
 * runtime client POSTs to `/v1/clawg-ui` without auth, the gateway plugin
 * returns a `403 pairing_pending` carrying a `pairingCode` + a `token`.
 * The desktop surfaces the code in a tray/Settings banner; the user
 * clicks Approve, which shells out to
 * `openclaw pairing approve clawg-ui <pairingCode>` on the gateway host.
 *
 * Mobile observes the state via the existing pairing channel so the
 * "(pairing)/awaiting-gateway" intermediate screen can show the same
 * code the desktop is asking the user to approve.
 *
 * This is the *second* trust layer the desktop manages on the user's
 * behalf (the first being our own Ed25519 6-digit pairing in P03B). The
 * two are deliberately decoupled — `"stub"` gateway mode never produces
 * a `ClawgUiPairingState` event.
 */
export type ClawgUiPairingState =
  | { status: 'idle' }
  | { status: 'pending'; pairingCode: string }
  | { status: 'approved' }
  | { status: 'denied'; reason?: string }
  | { status: 'error'; message: string };

/** Topic name used to broadcast `ClawgUiPairingState` changes to peers. */
export const CLAWG_UI_PAIRING_STATE_TOPIC = 'system:clawg-ui-pairing-state' as const;
