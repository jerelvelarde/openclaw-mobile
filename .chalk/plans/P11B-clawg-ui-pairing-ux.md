# P11B — Desktop UI wrap for clawg-ui pairing approval

**App:** desktop (`apps/desktop`) primarily, mobile (`apps/mobile`)
secondarily
**Estimated effort:** 1–1.5 days
**Depends on:** P11.0 (concept), P11A (so the identity store + 403
detection are in place)
**Blocks:** P11E (e2e needs the approve button)
**Can run in parallel with:** P11A (the two plans touch mostly
disjoint files; coordinate the settings.ts edit if both land in the
same wave)

## Context

clawg-ui's pairing flow (`vendor/clawg-ui/README.md:209–315`,
`vendor/clawg-ui/src/http-handler.ts:260–338`) is:

1. Client POSTs with no `Authorization` header.
2. Plugin returns **`403 pairing_pending`** carrying
   `{ error: { type: 'pairing_pending', pairing: { pairingCode, token, instructions } }, pairing_code, bearer_token }`.
3. The **gateway owner** runs
   `openclaw pairing approve clawg-ui <pairingCode>` on the host
   (CLI on the Mac mini).
4. Subsequent requests with `Authorization: Bearer <token>` succeed.

Today (post-P11A) the desktop *detects* the 403 and stashes the token,
but the approval step is a manual CLI invocation the user has to run in
a terminal. That breaks the "click one button on your desktop" UX
goal — the user just paired their phone via our 6-digit flow (P03B) and
shouldn't have to open Terminal.app to also approve a second pairing
they didn't ask for.

This plan wraps the approve step in a desktop UI affordance that runs
`openclaw pairing approve clawg-ui <code>` via a child process spawn,
plumbs the result back to the renderer, and updates the
PairingProvider state so mobile sees "ready" promptly.

The mobile side is mostly passive: the existing pairing screen learns a
new sub-state ("Gateway pairing pending — ask your desktop to approve")
and observes its resolution via the same WS event channel it already
uses for our pairing.

## Goal

After this plan lands:

- When the desktop's clawg-ui client (P11A) gets a 403 pairing_pending
  response, the renderer surfaces a tray notification + a Settings
  banner: **"OpenClaw gateway requested pairing — approve `ABCD1234`?
  [Approve] [Deny]"**.
- Clicking **Approve** spawns `openclaw pairing approve clawg-ui
  <code>` (path resolved from the bonjour TXT `cliPath` advertised by
  the gateway, with `which openclaw` as a fallback). On exit code 0,
  the identity store flips to "approved"; the next clawg-ui POST
  succeeds.
- Clicking **Deny** runs `openclaw pairing reject clawg-ui <code>`
  (per the same CLI plumbing,
  `vendor/clawg-ui/README.md:298–304`), wipes the local device token,
  and removes the banner.
- A new IPC channel `clawg-ui:pairing:state` lets the renderer
  subscribe to `{ status: 'idle' | 'pending' | 'approved' | 'denied' |
  'error', pairingCode?, error? }`.
- Mobile: the pairing screen's "post-handshake" state shows a thin
  spinner + "Waiting for desktop to approve gateway access…" while the
  desktop is `pending`. When the desktop flips to `approved`, mobile's
  next chat run succeeds automatically (no mobile UI action needed).
  Implementation is a single new WS event the desktop already broadcasts
  via the existing PairingProvider channel.

## Inputs

- `apps/desktop/src/main/clawg-ui/identity.ts` (P11A) — where the
  device token lives.
- `apps/desktop/src/main/clawg-ui/client.ts` (P11A) — emits the
  pairing-needed signal.
- `apps/desktop/src/main/pair/server.ts` — the existing 6-digit
  pairing server we model the IPC + event shape after.
- `apps/desktop/src/main/tray.ts` (or wherever the tray menu lives) —
  for the system-tray notification.
- `apps/desktop/src/renderer/.../PairingProvider.tsx` (or equivalent)
  — the existing pairing context the renderer uses.
- `apps/mobile/app/(pairing)/...` — the mobile pairing screens.
- `vendor/clawg-ui/README.md` §"CLI Commands" — the exact CLI shape.

## Outputs

New files:

- `apps/desktop/src/main/clawg-ui/cli.ts` — `runClawgUiPairingAction({
  action: 'approve' | 'reject' | 'list', pairingCode?, cliPath? }):
  Promise<{ ok: boolean; stdout: string; stderr: string }>`. Uses
  `child_process.spawn` with a 5-second timeout. Resolves the
  `openclaw` binary by trying, in order: explicit `cliPath` arg,
  bonjour TXT `cliPath` value from settings, `which openclaw` /
  `where openclaw`, `/usr/local/bin/openclaw`. Refuses any
  `pairingCode` not matching `[A-Z0-9]{8}` (`vendor/clawg-ui/src/http-handler.ts:273`
  pairing codes are short alphanumeric — defensively narrow the
  charset). ~120 lines + tests with a mocked `spawn`.
- `apps/desktop/src/main/clawg-ui/pairing-state.ts` — small state
  machine + EventEmitter that emits `{ status, pairingCode?, error? }`
  transitions. ~80 lines + tests.
- `apps/desktop/src/preload/clawg-ui.ts` — IPC bridge exposing
  `subscribePairingState(cb)` / `approve(code)` / `deny(code)` to the
  renderer.

Edited files:

- `apps/desktop/src/main/index.ts` — register the IPC handlers; hook
  the clawg-ui client's `kind: 'pairing-needed'` return into the
  state machine.
- `apps/desktop/src/main/tray.ts` — add a "Pending pairing: ABCD1234"
  item under the existing tray when `status === 'pending'`.
- `apps/desktop/src/renderer/.../PairingProvider.tsx` — extend the
  existing context with `clawgUiPairing: { status, pairingCode?,
  approve, deny }`.
- `apps/desktop/src/renderer/.../Settings.tsx` (or wherever P11A's
  status string landed) — replace the static status text with an
  interactive banner: "Gateway pairing pending — code `ABCD1234`
  [Approve] [Deny]" when `status === 'pending'`.
- `apps/mobile/app/(pairing)/...` — add a "waiting for gateway"
  intermediate screen. Wired through the existing PairingProvider
  hook; no new transport.
- `apps/desktop/src/main/transport/wsServer.ts` (or wherever the
  desktop broadcasts pairing-state changes to paired mobiles) — push
  a new `system:clawg-ui-pairing-state` event mirroring the desktop's
  internal state machine.
- `packages/protocol/src/types.ts` — add a `ClawgUiPairingState` type
  + a discriminator on the existing system-event union so mobile +
  desktop share the wire shape.

Tests:

- `apps/desktop/src/main/clawg-ui/__tests__/cli.test.ts` — mock
  `child_process.spawn`, assert command shape, assert pairing-code
  validation, assert timeout.
- `apps/desktop/src/main/clawg-ui/__tests__/pairing-state.test.ts` —
  state-machine transitions.
- `apps/desktop/src/main/__tests__/clawg-ui-ipc.test.ts` — IPC
  contract.
- Mobile renderer test for the "waiting for gateway" intermediate
  screen (snapshot or RTL).

## Steps

1. **Type the wire shape.** Add `ClawgUiPairingState` to
   `packages/protocol/src/types.ts`:
   ```ts
   export type ClawgUiPairingState =
     | { status: 'idle' }
     | { status: 'pending'; pairingCode: string }
     | { status: 'approved' }
     | { status: 'denied'; reason?: string }
     | { status: 'error';  message: string };
   ```
   Plus a `SystemEvent` discriminator entry so it rides the existing
   WS topic.
2. **CLI wrapper.** Implement `apps/desktop/src/main/clawg-ui/cli.ts`.
   Pairing-code regex `/^[A-Z0-9]{8}$/`; reject otherwise. Spawn
   `openclaw pairing approve clawg-ui <code>` with a 5s timeout.
   Resolve binary path per the precedence in §Outputs. Return
   `{ ok, stdout, stderr }`.
3. **State machine.** Implement `pairing-state.ts` as a small
   EventEmitter wrapping the type from step 1. Transitions:
   - `idle → pending` when P11A's client emits `kind:'pairing-needed'`.
   - `pending → approved` on a successful CLI exit.
   - `pending → denied` on a successful reject CLI exit.
   - `pending → error` on a non-zero exit or timeout.
   - `approved | denied | error → idle` after the renderer dismisses.
4. **Wire P11A's client.** In `apps/desktop/src/main/index.ts`, when
   the clawg-ui client returns `{ kind: 'pairing-needed', pairingCode }`,
   call `pairingState.setPending(pairingCode)`. Subscribe the WS server
   so it broadcasts the state via `system:clawg-ui-pairing-state`.
5. **IPC bridge.** Implement `apps/desktop/src/preload/clawg-ui.ts`
   exposing `window.openClaw.clawgUi.{subscribePairingState, approve,
   deny}`. Main-side handlers in
   `apps/desktop/src/main/index.ts`.
6. **Tray UI.** Add a "Pending pairing: ABCD1234" item to
   `apps/desktop/src/main/tray.ts` when status is `pending`; clicking
   it focuses the Settings window.
7. **Renderer banner.** In Settings, render the banner only when
   `status === 'pending'`. Buttons call
   `window.openClaw.clawgUi.approve(code)` / `.deny(code)`.
8. **Mobile screen.** In the mobile pairing flow, subscribe to the
   new `system:clawg-ui-pairing-state` event. Show a "Waiting for
   desktop to approve gateway access — code `ABCD1234`" intermediate
   screen while `status === 'pending'`. On `approved`, advance to the
   chat tab.
9. **Always-run baseline.** Per `.chalk/plans/README.md`.

## Success criteria

- A user on the desktop with a freshly-installed clawg-ui plugin
  triggers a real-mode chat → sees a tray notification + Settings
  banner → clicks **Approve** → the next chat request succeeds.
- A user on the desktop with a stale device token (server-side
  approval revoked) sees the banner reappear and can re-approve.
- Mobile, throughout, shows the right intermediate screen and never
  spins indefinitely.
- All baseline gates pass.
- No `child_process.spawn` calls outside `apps/desktop/src/main/clawg-ui/cli.ts`.
- The CLI wrapper refuses pairing codes outside `[A-Z0-9]{8}`.

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Manual smoke (executor's discretion):

1. Start `openclaw gateway` with clawg-ui installed.
2. Launch desktop in `gateway_mode: 'clawg-ui'`.
3. Trigger a chat from mobile.
4. Observe banner → click Approve → run `openclaw pairing list
   clawg-ui` to confirm allowlist contains the device id.
5. Send a follow-up chat to confirm SSE round-trip.

## Commit

Single commit:

```
Wrap clawg-ui pairing approval in the desktop UI (P11B)

A 403 pairing_pending from clawg-ui now surfaces as a tray + Settings
banner with Approve / Deny buttons that spawn `openclaw pairing
approve|reject clawg-ui <code>`. Mobile observes the state via the
existing PairingProvider channel and shows a "waiting for gateway"
intermediate screen.
```

## Notes

- Anti-pattern: do not parse `openclaw pairing list clawg-ui` output
  to discover pending codes — clawg-ui pushes the pairing code via
  the 403 response body. We never need to poll.
- Anti-pattern: do not spawn `openclaw` with `shell: true` —
  pairingCode is regex-validated but the spawn should still pass args
  as an array, not a shell string.
- Open question (open-questions #43): if the user hasn't installed
  the clawg-ui plugin on their daemon yet, the `openclaw pairing
  approve` command will fail with "unknown channel". That's a
  desktop-side error message in step 2 of `runClawgUiPairingAction`,
  not a separate plan — but we should consider whether the desktop
  should also wrap `openclaw plugins install @contextableai/clawg-ui`
  for first-time setup. Defer to a follow-up.
- For v1 the CLI binary path resolution is best-effort. If
  `openclaw` isn't on `PATH`, the banner shows a "Could not find
  `openclaw` CLI — install it and restart, or set the path in
  Settings" error.
