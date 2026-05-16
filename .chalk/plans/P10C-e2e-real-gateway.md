# P10C — End-to-end against a real `openclaw gateway`

**App:** root (integration test harness)
**Estimated effort:** 1 day
**Depends on:** P10A, P10B
**Blocks:** v1 release confidence
**Can run in parallel with:** —

## Context

After P10A wires the desktop to a real openclaw daemon and P10B aligns
the protocol, we still don't know if the end-to-end loop actually works.
This plan stands up an integration harness — ideally in CI — that boots
a real openclaw gateway in a Linux container, points the desktop at it,
and runs a scripted scenario (pair → list agents → send a message →
receive a reply → emit a canvas surface → fire a canvas event).

## Goal

A repeatable integration test (script + CI job) that exercises the full
stack against the real upstream daemon. Failures here block release.

## Inputs

- P10A bridge merged.
- P10B protocol changes merged.
- Upstream openclaw installable in CI (npm package? brew? docker image?). P10.0 should have surfaced this.

## Outputs

- `scripts/e2e/run.ts` — orchestrator: install/boot openclaw, start desktop in headless mode, drive the mobile app via a test-only IPC, assert outcomes.
- `.github/workflows/e2e.yml` — runs nightly + on-demand via `workflow_dispatch`.
- Documented manual runbook for a real Mac (since CI is Linux + headless).
- Test report artifact uploaded on every run.

## Anti-patterns

- Don't gate the main `ci.yml` on this — it's slow and external-dep-heavy. Keep it nightly + on-demand.
- Don't add this to the always-run baseline. Sub-agents shouldn't be expected to run it.
- Don't bake fixtures into the test that aren't representative of real upstream behavior.

## Detailed steps + success criteria

**Defer until P10A and P10B land.** This file is the placeholder.
