// Barrel exports for `@openclaw/protocol`. Both `apps/mobile` and
// `apps/desktop` import from this entry point only; deep imports into the
// individual modules are unsupported.
//
// `types.ts` is the authoritative source for the shape names (so consumers
// who don't want Zod can just use the plain interfaces). `schemas.ts`
// re-derives the same types via `z.infer<>`; we re-export the schemas as
// values and let `types.ts` win for the type names.

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
  CanvasSurface,
  CanvasPatch,
  VoiceOpts,
  VoiceSession,
} from './types';

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
  CanvasSurfaceSchema,
  CanvasPatchSchema,
  VoiceOptsSchema,
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
