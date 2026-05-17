// Barrel exports for `@openclaw/protocol`. Both `apps/mobile` and
// `apps/desktop` import from this entry point only; deep imports into the
// individual modules are unsupported.
//
// `types.ts` is the authoritative source for the shape names (so consumers
// who don't want Zod can just use the plain interfaces). `schemas.ts`
// re-derives the same types via `z.infer<>`; we re-export the schemas as
// values and let `types.ts` win for the type names.
//
// Canvas v1 lives in `./canvas/`; Voice v1 lives in `./voice/`. We re-export
// both here so callers see a single import path (`@openclaw/protocol`) for
// every shared shape.

export type {
  Token,
  PairingRequest,
  PairingApproved,
  Agent,
  Thread,
  MessageRole,
  Message,
  MessageInput,
  ThreadEvent,
  ClawgUiPairingState,
} from './types';
export { CLAWG_UI_PAIRING_STATE_TOPIC } from './types';

export {
  TokenSchema,
  PairingRequestSchema,
  PairingApprovedSchema,
  AgentSchema,
  ThreadSchema,
  MessageRoleSchema,
  MessageSchema,
  MessageInputSchema,
  ThreadEventSchema,
  ClawgUiPairingStateSchema,
} from './schemas';

export type { Envelope } from './envelope';
export { encode, decode, envelopeSchema } from './envelope';

export type {
  GatewayClient,
  GatewayEvent,
  GatewayEventPayload,
  PairingHandshake,
  Unsubscribe,
} from './client';

export type { InMemoryMockGatewayOptions } from './mock';
export { InMemoryMockGateway } from './mock';

// ── Canvas v1 (P06.0) ───────────────────────────────────────────────────────

export {
  CANVAS_SCHEMA_VERSION,
  type AddNodeOp,
  type ButtonNode,
  type CanvasEvent,
  type CanvasEventType,
  type CanvasNode,
  type CanvasNodeBase,
  type CanvasNodeType,
  type CanvasPatch,
  type CanvasPatchOp,
  type CanvasSurface,
  type HeadingNode,
  type ListNode,
  type RemoveNodeOp,
  type ReplacePropsOp,
  type SelectNode,
  type SelectOption,
  type SetTextOp,
  type StackNode,
  type TextInputNode,
  type TextNode,
  CanvasEventSchema,
  CanvasEventTypeSchema,
  CanvasNodeSchema,
  CanvasPatchOpSchema,
  CanvasPatchSchema,
  CanvasSurfaceSchema,
  applyPatch,
} from './canvas';

// ── Voice v1 (P07.0) ────────────────────────────────────────────────────────

export {
  VOICE_SCHEMA_VERSION,
  voiceTopics,
  type VoiceFormat,
  type VoiceFrame,
  type VoiceOpts,
  type VoiceSession,
  type VoiceSignal,
  type VoiceSignalType,
  type VoiceTranscript,
  VoiceFormatSchema,
  VoiceFrameSchema,
  VoiceOptsSchema,
  VoiceSignalSchema,
  VoiceSignalTypeSchema,
  VoiceTranscriptSchema,
} from './voice';
