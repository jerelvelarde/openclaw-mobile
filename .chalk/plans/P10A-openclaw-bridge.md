# P10A — Real OpenClaw gateway bridge (replaces stub)

**App:** desktop (`apps/desktop`)
**Estimated effort:** 2–3 days (depends on P10.0 findings)
**Depends on:** P10.0, P10B (if protocol changes are needed)
**Blocks:** P10C
**Can run in parallel with:** —

## Context

`apps/desktop/src/main/gateway/stub.ts` is an in-process fake. This plan
replaces it with a real bridge that supervises an installed `openclaw
gateway` daemon (or launches one as a child process) and forwards our
WS topics to/from the upstream protocol the user mapped in P10.0.

This is the "supervise the gateway" responsibility from `desktop-app.md` §2.1.

## Goal

When the Electron app boots, it ensures an `openclaw gateway` is running
(either by detecting an existing launchd-managed daemon or by spawning one
as a child process per the supervision model decided in P10.0), then
proxies our WS topics into the daemon's real protocol. The stub gateway is
removed.

## Inputs

- P10.0's `.chalk/openclaw-upstream.md` — the upstream contract.
- P10.0's `.chalk/openclaw-deltas.md` — the gap analysis.
- P10B if any protocol-package changes are required (apply first).

## Outputs

- `apps/desktop/src/main/gateway/openclaw-bridge.ts` — connect / supervise / translate.
- `apps/desktop/src/main/gateway/openclaw-process.ts` — child-process supervision (if applicable).
- `apps/desktop/src/main/gateway/stub.ts` — **deleted** (or moved to a `__fixtures__/` dir for test-only use).
- Tests covering: supervision (start/stop/restart), translation (each of our topics ↔ upstream).
- `apps/desktop/src/main/index.ts` updated to use the bridge instead of the stub.
- Settings UI: surface daemon health ("OpenClaw daemon: running / not installed / starting") in `Settings.tsx`.

## Steps (skeleton — refine after P10.0 lands)

1. Decide supervision strategy: spawn vs detect launchd vs both. Per P10.0's recommendation.
2. Implement the bridge translator for each of our topics:
   - `threads.post` ↔ upstream's message-send mechanism.
   - `threads.<id>.event` ↔ upstream's streamed reply.
   - `agents.list` / `setActiveAgent` ↔ upstream's agent router.
   - `canvas.*` — if upstream has canvas, translate; else emit a "canvas-unsupported" error and document. Keep canvas usable in the stub-only test fixture.
   - `voice.*` — same.
3. Update `apps/desktop/src/main/index.ts` to instantiate the bridge instead of the stub.
4. Update `Settings.tsx` to show daemon status (poll `/healthz` or read process state).
5. Keep the stub as a test fixture for vitest unit tests that don't want to boot the real daemon.

## Always-run baseline

Standard set (see `.chalk/plans/README.md`).

## Anti-patterns

- Don't fork upstream. If we need protocol changes that aren't possible to wrap, that's a P10B problem.
- Don't lose the stub entirely — keep it under `__fixtures__/` so unit tests stay hermetic.
- Don't bake daemon install logic into the bridge — that's user-controlled (or a future plan).

## Detailed steps + success criteria

**Defer until P10.0 lands** — concrete steps + criteria depend on the real
upstream contract. This file is the placeholder.
