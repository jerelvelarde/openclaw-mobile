// Zod schemas mirroring `types.ts`. These run at the WS boundary (see
// `envelope.ts`) and in tests; they are the single source of truth for
// runtime validation of inbound frames.
//
// For each type in `types.ts` we export both the schema (e.g. `AgentSchema`)
// and a `z.infer<>` alias under the same name as the type. Downstream code
// can import either the plain interface from `types.ts` or the inferred
// alias from here; both resolve to the same shape.

import { z } from 'zod';

export const TokenSchema = z.object({
  value: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
});
export type Token = z.infer<typeof TokenSchema>;

export const PairingRequestSchema = z.object({
  deviceName: z.string().min(1),
});
export type PairingRequest = z.infer<typeof PairingRequestSchema>;

export const PairingApprovedSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  token: TokenSchema,
  runtimeUrl: z.string().url(),
});
export type PairingApproved = z.infer<typeof PairingApprovedSchema>;

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  agentId: z.string().min(1),
  updatedAt: z.number().int().nonnegative(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.number().int().nonnegative(),
});
export type Message = z.infer<typeof MessageSchema>;

export const MessageInputSchema = z.object({
  content: z.string().min(1),
});
export type MessageInput = z.infer<typeof MessageInputSchema>;

export const ThreadEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    message: MessageSchema,
  }),
  z.object({
    type: z.literal('token'),
    messageId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('tool_call'),
    messageId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('done'),
    messageId: z.string().min(1),
  }),
]);
export type ThreadEvent = z.infer<typeof ThreadEventSchema>;

// `CanvasSurfaceSchema` + `CanvasPatchSchema` live in `./canvas/schemas.ts` as
// of P06.0. They are re-exported from `./index.ts` so consumers see the same
// import path they did before.

export const VoiceOptsSchema = z.object({
  mode: z.enum(['ptt', 'continuous']),
  sampleRate: z.number().int().positive(),
});
export type VoiceOpts = z.infer<typeof VoiceOptsSchema>;
