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
export type MessageRole = "user" | "assistant" | "system" | "tool";

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
      type: "message";
      message: Message;
    }
  | {
      type: "token";
      messageId: string;
      delta: string;
    }
  | {
      type: "tool_call";
      messageId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "done";
      messageId: string;
    };

/** Agent-driven UI fragment rendered inline in chat or full-screen. */
export interface CanvasSurface {
  id: string;
  /** Display title shown in the surface header. */
  title: string;
  /**
   * Opaque schema-driven content. Locked down in plan P06.0
   * (see `.chalk/plans/P06.0-canvas-schema.md`); for now the protocol package
   * just transports it verbatim.
   */
  content: unknown;
  /** Epoch ms; monotonic per surface so clients can drop stale updates. */
  updatedAt: number;
}

/** Incremental update to an existing `CanvasSurface`. */
export interface CanvasPatch {
  surfaceId: string;
  /** Partial replacement for `content`. */
  patch: unknown;
  /** Epoch ms. */
  ts: number;
}

/** Caller options for opening a voice session. */
export interface VoiceOpts {
  /** Push-to-talk vs continuous. */
  mode: "ptt" | "continuous";
  /** Sample rate the client will send frames at. */
  sampleRate: number;
}

/** Handle returned by `GatewayClient.openVoice`. Real frame shape lands in P07.0. */
export interface VoiceSession {
  id: string;
  mode: "ptt" | "continuous";
  /** Tear down the voice session. */
  close(): Promise<void>;
}
