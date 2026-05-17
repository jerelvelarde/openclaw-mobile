# `vendor/` — third-party source pinned as git submodules

This directory holds upstream projects we read, build, and ship alongside
`apps/desktop` + `apps/mobile` but **do not author**. Each entry is a
git submodule pinned to a tag (not a fork — if we ever need to patch one,
we'll fork at that point and switch the submodule URL).

## What's here

### `vendor/clawg-ui/` — `contextablemark/clawg-ui` @ **`v0.7.0`** (commit `2498623`)

[`clawg-ui`](https://github.com/contextablemark/clawg-ui) is an OpenClaw
gateway plugin that exposes the gateway as an
[AG-UI](https://docs.ag-ui.com)-compatible HTTP endpoint at
`POST /v1/clawg-ui`. It is the **real-mode chat path** for our mobile +
desktop AG-UI clients — they POST `RunAgentInput` and consume the SSE
response, exactly the same wire shape they already use against our
in-process desktop adapter (`apps/desktop/src/main/copilot/runtime.ts`).

Why we vendor it instead of just installing it from npm:

- We want the source in-tree so engineers reading our pivot plans
  (`.chalk/plans/P11.*`) can grep `vendor/clawg-ui/` for cited file
  paths + line numbers without a separate clone.
- We want the pin to be reviewable in a PR — when we bump it, the
  submodule SHA change in the diff makes the upgrade explicit.
- We don't (yet) need to patch it. If we do, we'll fork to
  `openclaw-mobile/clawg-ui`, point the submodule URL there, and pin
  the patched commit. That's a one-line `.gitmodules` change.

The plugin is **not** added to `pnpm-workspace.yaml`. It's a gateway-side
plugin installed onto the user's `openclaw` daemon via
`openclaw plugins install @contextableai/clawg-ui` (see
`vendor/clawg-ui/README.md` §Installation). Our apps speak its HTTP wire,
not its TypeScript exports.

#### Bumping the pin

```bash
cd vendor/clawg-ui
git fetch --tags
git checkout v0.8.0   # or whatever the new tag is
cd ../..
git add vendor/clawg-ui
git commit -m "Bump vendor/clawg-ui to v0.8.0"
```

Always pin to a **tag**, never to a floating branch. The submodule's
default branch (`main`) moves; tags don't.

#### What to re-read after a bump

- `vendor/clawg-ui/CHANGELOG.md` — wire-format changes since the
  previous pin.
- `vendor/clawg-ui/README.md` §Authentication — the pairing handshake
  shape (`pairing_pending` 403 → `bearer_token` + `pairing_code`).
  Our P11B plan wraps this in a desktop UI affordance; if the response
  shape moves, that plan needs an update.
- `vendor/clawg-ui/src/http-handler.ts` — the device-token format and
  `X-OpenClaw-Agent-Id` / `X-OpenClaw-Session-Key` header semantics.
  Our `apps/mobile/src/copilot/runAgent.ts` + `apps/desktop` client code
  encode against these.
