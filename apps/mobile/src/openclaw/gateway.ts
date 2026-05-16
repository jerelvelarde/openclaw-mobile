// Thin re-export so screens in `apps/mobile` never reach into
// `@openclaw/protocol` directly — they import from `@/src/openclaw/gateway`.
// That keeps the mobile-side surface area inspectable and gives us one place
// to swap the underlying transport when P04A lands the real WebSocket
// gateway client (currently we only re-export the in-memory mock).
export type { GatewayClient } from '@openclaw/protocol';
export { InMemoryMockGateway } from '@openclaw/protocol';
