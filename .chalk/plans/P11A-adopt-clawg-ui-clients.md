# P11A — Adopt clawg-ui as the real-mode chat path

**App:** mobile (`apps/mobile`) + desktop (`apps/desktop`)
**Estimated effort:** 1–1.5 days
**Depends on:** P11.0
**Blocks:** P11D, P11E
**Can run in parallel with:** P11B

## Context

The user's host runs `openclaw gateway` with the `@contextableai/clawg-ui`
plugin installed (vendored at `vendor/clawg-ui/` @ `v0.7.0`). That plugin
exposes `POST http://<host>:18789/v1/clawg-ui` — an AG-UI-compatible SSE
endpoint (`vendor/clawg-ui/src/http-handler.ts:221–348`,
`vendor/clawg-ui/README.md:39–77`) that speaks the **same wire format**
our P05C desktop adapter (`apps/desktop/src/main/copilot/runtime.ts`)
and our mobile `runAgent.ts` already speak.

That means we can route real-mode chat directly at the user's daemon
**without** the P10A `OpenClawBridge` translator. This plan does the
client plumbing: when `settings.gateway_mode === "clawg-ui"` (renamed
from `"real"`), the mobile + desktop AG-UI clients construct a runtime
URL pointing at `<host>:18789/v1/clawg-ui`, encode the agent id via the
`X-OpenClaw-Agent-Id` header (clawg-ui's convention,
`vendor/clawg-ui/README.md:328–337`) instead of in the URL path, and
send `Authorization: Bearer <clawg-ui device token>` — a token
**different from** our pairing token, obtained via clawg-ui's own
pairing 403 (handled in P11B). In stub mode, behaviour is unchanged.

The P10A bridge module stays in the tree but is marked
`@deprecated` and stops being instantiated. It is fully removed in
**P11D**.

## Goal

After this plan lands:

- Mobile chat in real mode POSTs to `<host>:18789/v1/clawg-ui` with
  `Authorization: Bearer <clawg-ui device token>` and
  `X-OpenClaw-Agent-Id: <agentId>`, consuming the SSE response with
  the existing `runAgent.ts` aggregator.
- Desktop chat in real mode (currently routed through P05C → in-process
  adapter) gains a `clawg-ui` mode that does the same thing from the
  Electron renderer.
- The `settings.gateway_mode` enum is widened from `"stub" | "real"` to
  `"stub" | "clawg-ui"` (the `"real"` value is migrated forward; legacy
  stored values coerce to `"clawg-ui"` on load).
- `apps/desktop/src/main/gateway/openclaw-bridge.ts` +
  `openclaw-bridge-handshake.ts` are marked deprecated (file-level
  `@deprecated` JSDoc + a console warning when instantiated). They are
  **not** invoked from `apps/desktop/src/main/index.ts` anymore.
- The `OpenClawBridge` constructor still type-checks and its existing
  tests still pass — full deletion is **P11D's** scope.
- Identity / device-token persistence for clawg-ui lives in a new
  `apps/desktop/src/main/clawg-ui/identity.ts` (mirrors the shape of
  the bridge's `loadOrCreateBridgeIdentity` but stores a flat
  `{ host, port, deviceId, deviceToken, pairingCode? }` per gateway in
  the existing keystore).

## Inputs

- `vendor/clawg-ui/src/http-handler.ts` — clawg-ui's request handling
  + device-token + pairing-pending shapes.
- `vendor/clawg-ui/README.md` — `X-OpenClaw-Agent-Id` /
  `X-OpenClaw-Session-Key` semantics; `pairing_pending` error envelope.
- `apps/desktop/src/main/copilot/runtime.ts` — wire format reference;
  no changes here in this plan (it's the stub-mode path).
- `apps/desktop/src/main/copilot/adapter.ts` — the AG-UI adapter we
  keep for stub mode.
- `apps/mobile/src/copilot/runAgent.ts` + `sse.ts` — mobile's AG-UI
  client; gets a new "clawg-ui mode" branch.
- `apps/mobile/src/copilot/runtimeUrl.ts` — URL builder; gets a new
  variant that omits the `/agent/:agentId/run` suffix and emits the
  agent id as a header instead.
- `apps/desktop/src/main/settings.ts` — `gateway_mode` enum.
- `apps/desktop/src/main/pair/keystore.ts` — where the clawg-ui device
  token lives.
- `.chalk/clawg-ui-evaluation.md` — for the "why" justification.

## Outputs

New files:

- `apps/desktop/src/main/clawg-ui/identity.ts` — per-gateway clawg-ui
  device-token persistence (host:port keyed). ~80 lines + a vitest unit
  test alongside it.
- `apps/desktop/src/main/clawg-ui/client.ts` — minimal HTTP wrapper:
  detects `403 pairing_pending`, returns `{ kind: 'pairing-needed',
  pairingCode, token }`; otherwise pumps the SSE stream into the
  existing AG-UI adapter machinery. ~120 lines + tests.
- `apps/mobile/src/copilot/clawgUiUrl.ts` — `buildClawgUiRequest({
  baseUrl, agentId, sessionKey? })` → `{ url, headers, body }`. ~50
  lines + tests.

Edited files:

- `apps/desktop/src/main/settings.ts` — widen `GatewayMode`; migrate
  `"real"` → `"clawg-ui"` on read.
- `apps/desktop/src/main/index.ts` — drop `attachOpenClawBridge(...)`
  invocation in the `gateway_mode === "clawg-ui"` branch; replace with
  initialization of the new clawg-ui identity store. Stub branch
  unchanged.
- `apps/desktop/src/main/gateway/openclaw-bridge.ts` +
  `openclaw-bridge-handshake.ts` — add file-level `@deprecated` JSDoc
  pointing to this plan, no behaviour change yet.
- `apps/mobile/src/copilot/runtimeUrl.ts` — accept a `mode:
  'p05c' | 'clawg-ui'` discriminator; route to `buildClawgUiRequest`
  for the `clawg-ui` case.
- `apps/mobile/src/copilot/runAgent.ts` — thread the `mode` through
  and call the right URL builder. SSE consumption stays unchanged.
- `apps/desktop/src/renderer/settings/Settings.tsx` (or equivalent) —
  the radio that today shows "Stub / Real" gets a third "Clawg-UI"
  option. Default migrates to "Clawg-UI" if `gateway_mode` was
  previously `"real"`.

Tests:

- `apps/desktop/src/main/clawg-ui/__tests__/identity.test.ts` — round-
  trip persistence.
- `apps/desktop/src/main/clawg-ui/__tests__/client.test.ts` — mock a
  clawg-ui peer, assert the 403→pairing-needed branch, assert SSE
  passthrough.
- `apps/mobile/src/copilot/__tests__/clawgUiUrl.test.ts` — URL +
  header assembly.
- `apps/desktop/src/main/__tests__/settings.test.ts` — extend with a
  case for the `"real"` → `"clawg-ui"` migration.
- Existing `apps/desktop/src/main/gateway/__tests__/openclaw-bridge.test.ts`
  stays green (we're not removing the bridge yet).

## Steps

1. **Settings migration.** In `apps/desktop/src/main/settings.ts`,
   change the `GatewayMode` union to `'stub' | 'clawg-ui'`. In
   `coerceGatewayMode`, map any of `'real' | 'realgateway'` to
   `'clawg-ui'`; otherwise default to `'stub'`. Add a test case.
2. **New identity store.** Create
   `apps/desktop/src/main/clawg-ui/identity.ts` that reads/writes
   `{ host, port, deviceId, deviceToken, pairingCode? }` keyed by
   `host:port`. Use the same keystore facade the bridge handshake
   uses (`apps/desktop/src/main/pair/keystore.ts`); add a new namespace
   `clawgUiIdentities`. Write a test.
3. **New HTTP client.** Create `apps/desktop/src/main/clawg-ui/client.ts`
   that takes `{ baseUrl, deviceToken?, agentId, sessionKey?, body,
   onSseEvent }`. POST to `${baseUrl}/v1/clawg-ui` with `Authorization:
   Bearer <deviceToken>` (omitted if no token). If response is `403`
   and body matches `{ error: { type: 'pairing_pending', pairing: {
   pairingCode, token } } }`, persist the token via the identity store
   and return `{ kind: 'pairing-needed', pairingCode }`. Otherwise,
   pipe the SSE through to `onSseEvent`. Write a test using a mock
   `node:http` peer (no real network).
4. **Wire mobile URL builder.** Create
   `apps/mobile/src/copilot/clawgUiUrl.ts`:
   ```ts
   export interface ClawgUiRequest {
     url: string;          // `${baseUrl.replace(/\/+$/,'')}/v1/clawg-ui`
     headers: Record<string,string>;
     // body is built by the caller from `RunAgentInput`.
   }
   export function buildClawgUiRequest(opts: {
     baseUrl: string;
     deviceToken: string;
     agentId: string;
     sessionKey?: string;
   }): ClawgUiRequest;
   ```
   Headers: `Authorization: Bearer ${deviceToken}`,
   `Content-Type: application/json`,
   `Accept: text/event-stream`,
   `X-OpenClaw-Agent-Id: ${agentId}`,
   `X-OpenClaw-Session-Key: ${sessionKey}` (only if provided and matches
   `[A-Za-z0-9._@:-]{1,256}` per
   `vendor/clawg-ui/src/http-handler.ts:85–91`).
5. **Mode-discriminated `runtimeUrl.ts`.** Extend the existing
   `resolveRuntimeUrl(input)` signature to accept
   `{ mode: 'p05c' | 'clawg-ui', runtimeUrl?, httpBase?, agentId,
   deviceToken? }`. For `p05c`, return today's `{ url: buildRunUrl(...),
   headers: buildRuntimeHeaders(token) }`. For `clawg-ui`, return
   `buildClawgUiRequest(...)`. Migrate the single caller in
   `runAgent.ts`.
6. **Mobile mode plumbing.** Wherever the mobile decides which mode
   it's in (today: always P05C against the paired desktop), add a
   per-session field that, if the desktop advertises a clawg-ui base
   URL at pairing time (a forward-compat hook for a later plan to
   wire), uses it; otherwise falls back to P05C. For this plan, the
   field is read from `__DEV__`-only debug settings — real wiring is
   in P11B. Cover with a unit test asserting both branches.
7. **Desktop main process.** In `apps/desktop/src/main/index.ts`,
   replace the `attachOpenClawBridge(...)` call inside the
   `gateway_mode === "clawg-ui"` branch with:
   - Construct the clawg-ui identity store.
   - Resolve the upstream clawg-ui base URL from settings
     (`http://${cfg.gateway_host ?? '127.0.0.1'}:${cfg.gateway_port ?? 18789}`).
   - Log a single-line startup message: "Real-mode chat will route
     via clawg-ui at <baseUrl> (device token: present|absent)".
   - **Do not** call any bridge functions.
8. **Deprecation markers.** Add a JSDoc block at the top of
   `apps/desktop/src/main/gateway/openclaw-bridge.ts` and
   `openclaw-bridge-handshake.ts`:
   ```ts
   /**
    * @deprecated The P10A bridge is superseded by the clawg-ui pivot
    * (`vendor/clawg-ui/` @ v0.7.0). Real-mode chat now POSTs directly
    * to the gateway's clawg-ui plugin (`POST /v1/clawg-ui`); see
    * `.chalk/plans/P11A-adopt-clawg-ui-clients.md`. This module is
    * scheduled for removal in `.chalk/plans/P11D-tear-down-openclaw-bridge.md`.
    */
   ```
   Plus a `console.warn(...)` inside `attachOpenClawBridge()` so any
   stray caller is loud.
9. **Renderer Settings UI.** Update the existing `Settings.tsx`
   (or equivalent) to:
   - Replace the two-radio "Stub / Real" with three-radio "Stub /
     Clawg-UI / Bridge (deprecated)". "Bridge (deprecated)" still
     persists the legacy `"real"` value for an escape hatch, but is
     visually de-emphasised.
   - Show the device-token presence ("Pairing approved" /
     "Pairing pending — code `ABCD1234`" / "Not paired") next to the
     Clawg-UI option. The pairing-needed string surfaces from the new
     identity store; the actual approve-button UI is **P11B**.
10. **Always-run baseline.** Per `.chalk/plans/README.md` §"Always-
    run baseline gates".

## Success criteria

- `pnpm install && pnpm --filter @openclaw/protocol build && pnpm
  format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
  all exit 0.
- `apps/desktop/src/main/index.ts` no longer references
  `attachOpenClawBridge` from the active code path (grep `git diff`
  should show only the deprecation comment + the renamed-mode branch).
- A new unit test asserts that `gateway_mode: 'real'` in an existing
  `userData/settings.json` migrates to `'clawg-ui'` on load.
- A new unit test asserts that
  `buildClawgUiRequest({ baseUrl: 'http://host:18789', deviceToken:
  'tok', agentId: 'main' }).url === 'http://host:18789/v1/clawg-ui'`
  and the `Authorization` header matches `Bearer tok`.
- The existing `openclaw-bridge.test.ts` suite still passes (bridge
  is deprecated, not deleted).

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Optional (only if a clawg-ui-enabled daemon is reachable on the
executor's machine):

```sh
# Spawn an openclaw daemon with clawg-ui installed (out-of-band),
# then from the desktop main process console:
#   curl -X POST http://127.0.0.1:18789/v1/clawg-ui -d '{}'
# expect a 403 pairing_pending with a `pairingCode`.
```

If no real daemon is available, the unit tests against a mocked SSE
peer are sufficient evidence for this plan.

## Commit

Single commit. Suggested message:

```
Route real-mode chat through clawg-ui (P11A)

Mobile + desktop AG-UI clients now POST to <host>:18789/v1/clawg-ui
when gateway_mode === "clawg-ui" (renamed from "real"; legacy
values migrate). Agent id moves from URL path to X-OpenClaw-Agent-Id
header per vendor/clawg-ui/README.md. The P10A OpenClawBridge is
marked @deprecated and no longer instantiated; removal lands in
P11D. Stub-mode wiring is unchanged.
```

## Notes

- Anti-pattern: do not delete the bridge files yet. P11D is the
  cleanup; deleting here would conflate a behavioural change with a
  source removal and make the review noisier.
- Anti-pattern: do not bake the clawg-ui base URL into mobile —
  mobile should discover it via the desktop's pairing response. For
  this plan, a dev-only override is fine; the real handshake change
  is **P11B**'s concern.
- Open question: clawg-ui's `X-OpenClaw-Session-Key` is a "trusted-
  proxy-only" concern (`vendor/clawg-ui/README.md:365–369`). Since the
  desktop is the proxy in our architecture, we *can* set it — but for
  v1 we leave it unset and rely on clawg-ui's automatic per-`threadId`
  scoping. Tracked alongside open-questions §42.
