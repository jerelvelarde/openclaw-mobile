// Thin re-export so screens in `apps/mobile` never reach into
// `@openclaw/protocol` directly — they import from `@/src/openclaw/gateway`.
// That keeps the mobile-side surface area inspectable and gives us one place
// to swap the underlying transport.
//
// P03A: only `InMemoryMockGateway` was re-exported here.
// P04A: also re-exports `RealGateway` (Bonjour + HTTP + WS) plus the small
// surface the discover screen + banner need (`DiscoveredHost`, the browse
// helper, the reconnect state).
export type { GatewayClient } from '@openclaw/protocol';
export { InMemoryMockGateway } from '@openclaw/protocol';

export { RealGateway } from './transport/RealGateway';
export type { RealGatewayOptions } from './transport/RealGateway';

export { browse } from './transport/bonjour';
export type { DiscoveredHost, BrowseOptions } from './transport/bonjour';

export type { ReconnectState, ReconnectStateKind } from './transport/reconnect';

export { resolveHttpBase, DEFAULT_GATEWAY_PORT } from './transport/http';
