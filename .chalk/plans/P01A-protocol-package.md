# P01A — Protocol package skeleton

**App:** protocol (`packages/protocol`)
**Estimated effort:** 1 day
**Depends on:** P00
**Blocks:** P02A, P02B, P03A, P03B, P04A, P04B, P05*, P06*, P07*, P08*
**Can run in parallel with:** P01B

## Context

`packages/protocol` is the single source of truth for the wire format
between `apps/mobile` and `apps/desktop`. It owns the `GatewayClient`
interface, message types, Zod schemas, token format, and an in-memory mock
gateway that both apps use for dev/test until the real OpenClaw gateway WS
is reachable. See `plan.md` §7 and `desktop-app.md` §4–5.

## Goal

A buildable `@openclaw/protocol` package consumed via `workspace:*` from
both apps, exposing typed message envelopes, Zod validators, the
`GatewayClient` interface, and a working `InMemoryMockGateway` with at
least one fake agent ("openclaw.default") and one fake Hermes-shaped agent.

## Inputs

- P00 complete: monorepo + stub `packages/protocol/package.json`.

## Outputs

- `packages/protocol/src/`:
  - `index.ts` — barrel exports.
  - `types.ts` — `Thread`, `Agent`, `Message`, `MessageInput`, `ThreadEvent`, `CanvasSurface`, `CanvasPatch`, `VoiceOpts`, `VoiceSession`, `PairingRequest`, `PairingApproved`, `Token`.
  - `schemas.ts` — Zod schemas mirroring each type.
  - `client.ts` — `GatewayClient` interface (per `plan.md` §7).
  - `mock.ts` — `InMemoryMockGateway` implementing `GatewayClient`.
  - `envelope.ts` — WS frame envelope `{ id, topic, type, payload, ts }` + helpers.
- `packages/protocol/tsconfig.json` extending `tsconfig.base.json`.
- `packages/protocol/package.json` updated with deps (`zod`) and scripts (`build`, `typecheck`, `test`).
- `packages/protocol/vitest.config.ts` + `src/__tests__/mock.test.ts` with at least 5 tests.

## Steps

1. `cd packages/protocol && pnpm add zod && pnpm add -D vitest tsup typescript @types/node`.
2. Create `tsconfig.json` extending `../../tsconfig.base.json` with `outDir: dist`, `rootDir: src`, `composite: true`.
3. Configure `tsup` for ESM + CJS dual output with `.d.ts`.
4. Write `src/types.ts` per `plan.md` §7. Keep fields minimal but complete enough for the mobile/desktop UIs.
5. Write `src/schemas.ts` — one Zod schema per type; export both schema and `z.infer<typeof X>` alias matching `types.ts`.
6. Write `src/envelope.ts`:
   - `Envelope<T>` shape `{ id: string; topic: string; type: string; payload: T; ts: number }`.
   - `encode<T>(e: Envelope<T>): string` (JSON) and `decode<T>(raw: string, schema: ZodType<T>): Envelope<T>` with validation.
7. Write `src/client.ts` — `GatewayClient` interface covering: `requestPairing`, `awaitPaired`, `connect`, `on`, `listAgents`, `setActiveAgent`, `listThreads`, `postMessage`, `streamThread`, `getCanvas`, `onCanvasUpdate`, `openVoice`.
8. Write `src/mock.ts`:
   - `InMemoryMockGateway` class implementing `GatewayClient`.
   - Holds in-memory state for threads, agents, messages.
   - `requestPairing` returns a 6-digit code; exposes a test-only `_approvePairing(code)` method.
   - `postMessage` echoes back a fake streamed response with a fake tool call after 200ms.
   - Two fake agents: `{ id: "openclaw.default", name: "OpenClaw" }` and `{ id: "hermes", name: "Hermes" }`.
9. Write tests in `src/__tests__/mock.test.ts`:
   - Pairing flow: request → approve → connect → listAgents.
   - Switch agent.
   - Post message → receive streamed response.
   - Stream thread emits expected events.
   - Schema validation rejects malformed input.
10. Add scripts to `package.json`:
    ```json
    {
      "scripts": {
        "build": "tsup src/index.ts --format esm,cjs --dts --clean",
        "typecheck": "tsc --noEmit",
        "test": "vitest run",
        "test:watch": "vitest"
      }
    }
    ```
11. Set `main`, `module`, `types`, `exports` in `package.json` to point at `dist/`.
12. Run `pnpm build && pnpm test && pnpm typecheck`.

## Success criteria

- [ ] `pnpm --filter @openclaw/protocol build` produces `dist/index.{js,cjs,d.ts}`.
- [ ] `pnpm --filter @openclaw/protocol test` passes ≥ 5 tests.
- [ ] `pnpm --filter @openclaw/protocol typecheck` exits 0.
- [ ] Importing from a fresh sibling workspace (manual quick test) resolves types correctly.
- [ ] `InMemoryMockGateway` satisfies `GatewayClient` with no `// @ts-expect-error`.

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm --filter @openclaw/protocol test
pnpm --filter @openclaw/protocol typecheck
```

All exit 0; test summary shows ≥ 5 passing.

## Commit

```
Add @openclaw/protocol package with GatewayClient + in-memory mock

Define wire types, Zod schemas, the GatewayClient interface, the WS
envelope shape, and an InMemoryMockGateway used by both apps in dev
and tests.
```

## Notes

- **Do not** add any network code (`ws`, `bonjour`, `fetch`). The real transport lives in P04A/P04B. This package is pure types + in-memory simulation.
- Keep dependencies minimal: `zod` is the only runtime dep we want here.
- Don't speculate beyond what `plan.md` §7 lists. If you find yourself adding fields the plan doesn't justify, flag them in `open-questions.md` instead of including them.
- Tests use `vitest`, not Jest, to avoid pulling Babel/Jest config into a TS-only package.
