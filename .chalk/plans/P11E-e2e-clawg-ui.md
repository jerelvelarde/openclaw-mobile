# P11E — End-to-end against real `openclaw gateway` + clawg-ui plugin

**App:** root (integration harness)
**Estimated effort:** 1–1.5 days
**Depends on:** P11A, P11B, P11D
**Blocks:** v1 real-mode launch confidence
**Can run in parallel with:** —

## Context

P10C was the v1 plan for "boot a real openclaw daemon and run our
scripted chat scenario against it". It was structured around the P10A
JSON-RPC bridge. Post-pivot, the target stack is different:

- Real `openclaw gateway` daemon (Node 22.16+/24, default port 18789,
  per `.chalk/openclaw-upstream.md` §1).
- `@contextableai/clawg-ui` plugin installed on it (`openclaw plugins
  install @contextableai/clawg-ui`; vendored at `vendor/clawg-ui/` @
  `v0.7.0`).
- A reachable agent (the daemon's default `main` agent, which routes
  to whatever the user configured — for CI we can stub Hermes or just
  use an echo agent).
- Desktop app booted with `gateway_mode: 'clawg-ui'` (P11A).
- Mobile (or a headless mobile shim) sending chat through the desktop's
  pairing channel into clawg-ui.

This plan stands up that harness, ideally in CI, and runs a scripted
scenario: pair via clawg-ui (P11B's approve button driven by a
harness-side spawn) → send a chat → assert the SSE stream contains the
expected event sequence.

## Goal

A repeatable integration test that:

1. Spins up a Linux container running `openclaw gateway` with the
   clawg-ui plugin installed and a minimal echo agent configured.
2. Boots the desktop main process headlessly (Electron via Xvfb or in
   a CI-only "main only" Node entry point we add for this purpose) in
   `gateway_mode: 'clawg-ui'` pointing at the container.
3. Drives a pair-and-chat scenario via a thin scripted client (Node)
   that:
   - POSTs to `/v1/clawg-ui` with no auth → expects `403 pairing_pending`
     and captures the `pairingCode` + `bearer_token`.
   - Triggers the desktop's pairing-approve IPC (or directly invokes
     `openclaw pairing approve clawg-ui <code>` against the container).
   - POSTs again with the bearer token and a real `RunAgentInput`
     containing one user message.
   - Asserts the SSE response contains, in order:
     `RUN_STARTED` → `TEXT_MESSAGE_START` → ≥1 `TEXT_MESSAGE_CONTENT`
     → `TEXT_MESSAGE_END` → `RUN_FINISHED`.
4. Tears down the container + the desktop process cleanly.

The test runs as a separate CI job (label: `e2e-clawg-ui`) so it can
be skipped on PRs that don't touch the relevant paths and run on the
nightly schedule + the release branch.

## Inputs

- `vendor/clawg-ui/` @ `v0.7.0` — for the request/response shape.
- `apps/desktop/src/main/clawg-ui/client.ts` (P11A) — to confirm we
  hit the same wire shape from the test harness.
- `apps/desktop/src/main/clawg-ui/cli.ts` (P11B) — the approve hook.
- `apps/desktop/src/main/index.ts` post-P11D — the entry point we'd
  boot.
- An echo agent script for the gateway. Upstream OpenClaw ships
  `skills/` and an agents config; for CI we'll write a minimal
  `e2e/agents/echo.md` that responds with "echo: <input>".
- A Dockerfile we author for this plan (see Outputs).

## Outputs

New files (under `e2e/` at the repo root):

- `e2e/clawg-ui/Dockerfile` — Node 22.16-alpine base. Installs the
  `openclaw` CLI (npm), `@contextableai/clawg-ui` plugin (npm), copies
  in `e2e/clawg-ui/openclaw-config.json` + `e2e/agents/echo.md`.
  Entrypoint: `openclaw gateway --port 18789`.
- `e2e/clawg-ui/openclaw-config.json` — minimal gateway config: one
  agent named `main` pointed at the echo agent file, bonjour off,
  TLS off, default secret seeded from `OPENCLAW_GATEWAY_SECRET` env.
- `e2e/agents/echo.md` — agent definition that echoes user input.
- `e2e/clawg-ui/scenario.test.ts` — vitest spec that does the pair →
  chat → assert flow.
- `e2e/clawg-ui/run-scenario.ts` — the actual scripted client (no
  Electron; raw `fetch` + SSE parser). Used by `scenario.test.ts`.
- `e2e/clawg-ui/docker-compose.yml` — convenience wrapper for local
  runs.
- `.github/workflows/e2e-clawg-ui.yml` — CI job that builds the
  Docker image, runs `vitest run e2e/clawg-ui/scenario.test.ts`, and
  uploads logs on failure.

Optional new files:

- `apps/desktop/src/main/__e2e-entry__.ts` — a CI-only main entry that
  skips Electron's window creation and instantiates only the gateway +
  IPC layer. Only built behind an env flag; not shipped to users.

Edited files:

- `package.json` (root) — `e2e:clawg-ui` script that calls the
  docker-compose + vitest sequence.
- `vitest.config.ts` or per-workspace config — exclude `e2e/` from
  the default `pnpm -r test` run (it has its own runner).

## Steps

1. **Docker image.** Write `e2e/clawg-ui/Dockerfile`. Base on
   `node:22.16-alpine`. `RUN npm install -g openclaw
   @contextableai/clawg-ui`. Copy config + agent. ENTRYPOINT
   `["openclaw", "gateway", "--port", "18789"]`. Add a `HEALTHCHECK`
   that curls `/health`.
2. **Gateway config.** Write `openclaw-config.json` with one agent
   (`main`), tls off, bonjour off, secret from env.
3. **Echo agent.** Write `e2e/agents/echo.md` — a minimal agent
   prompt that responds with the user's text prefixed by `echo:`.
   Avoid LLM calls in CI; pick an agent runtime that has a
   deterministic / mock mode if possible (e.g. an OpenAI-compat shim
   pointed at a local mock).
4. **Scripted client.** Write `e2e/clawg-ui/run-scenario.ts`. No
   Electron. Pure Node:
   - `await fetch('http://localhost:18789/v1/clawg-ui', { method:'POST', body: '{}' })` → assert 403, parse pairing code + token.
   - `await execFile('docker', ['exec', container, 'openclaw',
     'pairing', 'approve', 'clawg-ui', pairingCode])` → assert exit 0.
   - `await fetch(url, { method:'POST', headers: { Authorization:
     'Bearer '+token, ... }, body: JSON.stringify({ threadId:'t1',
     runId:'r1', messages:[{role:'user',content:'hello'}] }) })` →
     consume the SSE stream, collect event types.
   - Assert the sequence matches expectation.
5. **Vitest spec.** `scenario.test.ts` orchestrates docker-compose
   up + run-scenario + docker-compose down with proper teardown in
   `afterAll`.
6. **CI job.** `.github/workflows/e2e-clawg-ui.yml`:
   - Triggers: `pull_request` paths-filter on
     `apps/desktop/src/main/clawg-ui/**`, `apps/mobile/src/copilot/**`,
     `vendor/clawg-ui/**`, `e2e/clawg-ui/**`; plus `schedule: cron
     nightly` and on `release/**` branches.
   - Steps: checkout (with submodules!) → setup-node 22.16 → pnpm
     install → pnpm `e2e:clawg-ui` → upload `e2e/clawg-ui/logs/` on
     failure.
7. **Local convenience.** `package.json` script:
   `"e2e:clawg-ui": "docker compose -f e2e/clawg-ui/docker-compose.yml
   up --build --abort-on-container-exit --exit-code-from runner"` (or
   the equivalent for the runner pattern picked).
8. **Always-run baseline** for the changes in this commit (the e2e
   itself doesn't run during normal `pnpm -r test`).

## Success criteria

- A clean `pnpm e2e:clawg-ui` exits 0 against a freshly-built image.
- The CI job is green on the PR that introduces it (against the
  pinned `v0.7.0` clawg-ui).
- The scripted scenario asserts at minimum the AG-UI event sequence
  listed in §Goal; brittleness (LLM determinism, etc.) is handled
  by either a mocked agent or relaxed assertions on the
  `TEXT_MESSAGE_CONTENT` count.
- Test logs (gateway stdout + scripted client output) are uploaded
  on failure so debugging doesn't need a local re-run.

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test

# the new gate
pnpm e2e:clawg-ui
```

Each must exit 0.

## Commit

Single commit:

```
End-to-end test against openclaw + clawg-ui (P11E)

Stand up a Docker-Compose'd openclaw gateway with the clawg-ui
plugin installed, then run a scripted pair → approve → chat scenario
that asserts the AG-UI event sequence. Wired as a separate
e2e-clawg-ui CI job (paths-filtered + nightly + release/** triggers).
```

## Notes

- Anti-pattern: do not run the e2e on every PR — it's slow (Docker
  build + container spin-up). The paths filter keeps it focused.
- Anti-pattern: do not bake user secrets into the Dockerfile. Use
  CI secrets injected via env vars; the gateway secret can be a
  fixed dev string for the test image (it never leaves the container).
- Open question: choosing a deterministic agent backend for CI. Two
  options: (a) write a mock OpenAI-compat HTTP server that lives in
  the same docker-compose stack and configure the gateway's agent to
  point at it; (b) use OpenClaw's `OPENCLAW_AGENT_MODE=echo` if such
  a flag exists (verify against `vendor/clawg-ui/` and upstream).
  Decide during step 3.
- If clawg-ui's pairing-approve CLI shape changes in a future
  upstream release, this test will fail loud — that's a feature, not
  a bug, since it gates the version pin in `vendor/clawg-ui/`.
