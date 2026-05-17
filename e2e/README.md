# E2E harness — `openclaw gateway` + `clawg-ui` plugin

End-to-end integration test for the Wave 15 clawg-ui pivot (plan
`P11E-e2e-clawg-ui`). This directory contains the Docker artifacts; the
driver script lives at `scripts/e2e/run.ts`.

## What it does

A scripted driver hits a real `openclaw gateway` container running the
vendored `@contextableai/clawg-ui` plugin (`vendor/clawg-ui/` @ v0.7.0)
and asserts the documented pairing + chat flow end to end:

1. POST `/v1/clawg-ui` with no Authorization → expect
   `403 pairing_pending` with `{ pairingCode, token }`
   (per `vendor/clawg-ui/README.md:259-271`).
2. Approve the pairing via
   `docker exec <container> openclaw pairing approve clawg-ui <code>`
   (mirrors the CLI the desktop's
   `apps/desktop/src/main/clawg-ui/cli.ts` wraps).
3. POST `/v1/clawg-ui` again with `Authorization: Bearer <token>` and a
   minimal `RunAgentInput` → expect a 200 `text/event-stream`.
4. Parse the SSE stream and assert these AG-UI events appear, in order:
   `RUN_STARTED` → `TEXT_MESSAGE_START` → ≥1 `TEXT_MESSAGE_CONTENT` →
   `TEXT_MESSAGE_END` → `RUN_FINISHED`.

The driver writes a structured JSON report to `e2e-report.json` (in the
cwd) and exits 0 on success / 1 on any failed assertion. The CI
workflow uploads that report as an artifact.

## Running locally (Mac or any Docker-equipped Linux)

```sh
# One-liner. Builds the image, starts the container, waits for /health,
# runs the driver, captures the report, then tears the container down.
pnpm e2e:clawg-ui:local
```

What `e2e:clawg-ui:local` does, expanded:

```sh
docker compose -f e2e/docker/docker-compose.yml up --build -d
# Wait for the container's healthcheck to report `healthy`. The compose
# healthcheck hits /health every 5s; we poll for at most ~60s.
until [ "$(docker inspect -f '{{.State.Health.Status}}' openclaw-gateway-e2e)" = "healthy" ]; do
  sleep 1
done
pnpm e2e:clawg-ui
docker compose -f e2e/docker/docker-compose.yml down --volumes
```

If you'd rather drive it by hand:

```sh
# 1. Bring the gateway up
docker compose -f e2e/docker/docker-compose.yml up --build -d gateway

# 2. Wait until /health is 200
curl -sf http://localhost:18789/health

# 3. Run the scripted driver
pnpm e2e:clawg-ui  # exits 0 = pass, 1 = at least one assertion failed

# 4. Inspect the artifact
cat e2e-report.json | jq .

# 5. Tear down
docker compose -f e2e/docker/docker-compose.yml down
```

## Validating the driver without Docker

Useful for fast local iteration on the scenario logic + SSE parser:

```sh
pnpm e2e:clawg-ui:mock
```

This spins up an in-process HTTP/SSE server in `scripts/e2e/mock-server.ts`
that mimics the clawg-ui surface precisely enough to exercise the
driver. It runs two cases:

1. **happy-path** — the mock emits the full event sequence; the driver
   must report `passed: true`.
2. **missing-run-finished** — the mock intentionally omits
   `RUN_FINISHED`; the driver must report `passed: false` and the
   `step4.event:RUN_FINISHED` assertion must fail (negative control
   — proves the driver isn't too lenient).

## CI

The `.github/workflows/e2e-clawg-ui.yml` workflow runs the harness on:

- **manual dispatch** (`workflow_dispatch`)
- **nightly schedule** (`cron: '0 7 * * *'` — ~midnight Pacific)

It is intentionally NOT wired into `ci.yml` — the build is slow + has
external dependencies (npm registry availability for `openclaw`).

## Known gaps

- **`openclaw` npm publication.** The Dockerfile does
  `RUN npm install -g openclaw`. This is the upstream-canonical install
  path per `.chalk/openclaw-upstream.md` §1.1, but we haven't
  independently verified that an `openclaw` package is published on the
  public npm registry under that name (the only confirmed reference is
  the peer-dep declaration in `vendor/clawg-ui/package.json`). If the
  `npm install` step fails, the fallback is to clone
  `https://github.com/openclaw/openclaw` inside the image, run
  `npm install && npm run build`, then `npm link` the resulting CLI
  before installing the plugin. Tracked as open question #48.

- **Echo agent runtime.** `openclaw-config.json` declares the `main`
  agent with `kind: "echo"`. If the upstream gateway doesn't ship a
  builtin `echo` runtime, the gateway will refuse to start `main` and
  the scenario will fail at step 3 (HTTP 200 with a `RUN_ERROR` event,
  or HTTP 500 if the agent kind is unknown at boot). The fallback is
  to point `main` at a tiny OpenAI-compat HTTP shim running as a
  second compose service — the harness is structured so that addition
  only touches `docker-compose.yml` + `openclaw-config.json`. Documented
  in `.chalk/plans/P11E-e2e-clawg-ui.md` Notes.

- **Docker-in-docker for the dev container.** The agent worktree this
  harness was authored in cannot start a Docker daemon (it's already a
  container). The driver scenario logic is validated against an
  in-process mock (`pnpm e2e:clawg-ui:mock`); the live integration
  runs only in CI or on a developer's Mac.

## File map

```
e2e/
  README.md                              ← you are here
  docker/
    Dockerfile.openclaw-gateway          ← gateway image
    docker-compose.yml                   ← single-service compose
    openclaw-config.json                 ← minimal gateway config
    echo-agent.md                        ← AGENTS.md for the `main` agent
scripts/
  e2e/
    driver.ts                            ← scenario logic (pure)
    mock-server.ts                       ← in-process HTTP/SSE fake
    run.ts                               ← live runner (calls docker exec)
    validate-driver.ts                   ← drives `driver.ts` vs `mock-server.ts`
.github/workflows/
  e2e-clawg-ui.yml                       ← nightly + manual workflow
```
