# `contextablemark/clawg-ui` evaluation

**TL;DR:** clawg-ui is an OpenClaw gateway plugin (`@contextableai/clawg-ui`)
that exposes a `POST /v1/clawg-ui` SSE endpoint speaking the **AG-UI
protocol** — exactly the wire format our P05C desktop adapter and our
mobile `runAgent.ts` already speak. Adopting it server-side **retires
~90% of the P10A `OpenClawBridge` translation code**, replaces our hand-
rolled JSON-RPC `req`/`res`/`event` translator with a one-line URL
change, and reduces the bridge work to "do the pairing dance and stash
the device token".

Pinned at **`v0.7.0`** (commit `2498623`) at `vendor/clawg-ui/`.

---

## 1. What it is

A channel plugin (`vendor/clawg-ui/openclaw.plugin.json`,
`vendor/clawg-ui/package.json:44–67`) that registers two HTTP routes
inside the OpenClaw gateway:

- `POST /v1/clawg-ui` — device-token-authenticated AG-UI endpoint
  (`vendor/clawg-ui/src/http-handler.ts:221–348`, `createAguiHttpHandler`).
- `POST /v1/clawg-ui/operator` — operator-token-authenticated variant
  for plugin-contributed UI slots (`http-handler.ts:362–395`,
  `createOperatorAguiHttpHandler`).

Plus a companion package `@contextableai/clawpilotkit` at
`vendor/clawg-ui/clawpilotkit/` that ships a ready-made React +
CopilotKit chat UI — not what we need for mobile/desktop, but useful as a
reference standalone client.

## 2. Wire format match

clawg-ui accepts AG-UI `RunAgentInput` (`vendor/clawg-ui/src/http-handler.ts:427`,
`const input = body as RunAgentInput`) and streams AG-UI `EventType.*`
events back via `@ag-ui/encoder`'s `EventEncoder.encodeSSE`
(`vendor/clawg-ui/index.ts:5,11`).

Compare against what we already do:

- Our desktop runtime (`apps/desktop/src/main/copilot/runtime.ts:11–48`)
  accepts `RunAgentInput` per `@ag-ui/core@0.0.53` and streams the same
  `EventType` enum events using `@ag-ui/encoder`.
- Our mobile client (`apps/mobile/src/copilot/runAgent.ts:26,27`) posts
  `RunAgentInput` and decodes the SSE stream into `AGUIEvent`s using
  our hand-rolled `apps/mobile/src/copilot/sse.ts`.

The pinned versions match: clawg-ui uses `@ag-ui/core@^0.0.52`
(`vendor/clawg-ui/package.json:31`), we use `@ag-ui/core@0.0.53` —
forward-compatible.

**Implication:** swapping the runtime URL from `<host>:18789/copilot/runtime`
(our adapter) to `<host>:18789/v1/clawg-ui` (clawg-ui) requires no client
code changes beyond URL plumbing.

## 3. Auth model

Device pairing, not bearer token (`vendor/clawg-ui/README.md:209–315`,
`vendor/clawg-ui/src/http-handler.ts:260–338`):

1. Client POSTs with no `Authorization` header.
2. Plugin returns `403 pairing_pending` with body
   `{ error: { type: "pairing_pending", pairing: { pairingCode, token, instructions } } }`
   plus top-level shortcuts `pairing_code` + `bearer_token`
   (`http-handler.ts:295–307`).
3. User runs `openclaw pairing approve clawg-ui <pairingCode>` on the
   host. Plugin allowlist gets the device id
   (`vendor/clawg-ui/src/channel.ts:33–36`, `idLabel: "clawgUiDeviceId"`).
4. Subsequent client requests with `Authorization: Bearer <token>`
   succeed (`http-handler.ts:311–346`).

Device tokens are HMAC-signed UUIDs
(`http-handler.ts:97–136`, `createDeviceToken` / `verifyDeviceToken`).
The HMAC secret is the gateway-wide secret resolved via
`resolveGatewaySecret(api)` (`http-handler.ts:225`).

**Implication:** this is **not the same** as our P10A bridge's signed
`connect` RPC handshake. clawg-ui's pairing is HTTP-only — no WebSocket,
no Ed25519, no nonce challenge. We still need a desktop UI affordance
for "approve this pairing code" (P11B), but the protocol primitives are
much simpler than the upstream WS handshake.

## 4. Agent routing

The agent the request hits is controlled by an `X-OpenClaw-Agent-Id`
request header (`vendor/clawg-ui/README.md:328–337`,
`http-handler.ts:484–489`); default routes to the agent named `main`.

Our P05C adapter encodes the agent id in the URL path
(`POST /copilot/runtime/agent/:agentId/run`,
`apps/mobile/src/copilot/runtimeUrl.ts:37–41`). When we switch to
clawg-ui, the agent id moves from URL path to request header.

## 5. Session isolation

clawg-ui automatically scopes sessions by `threadId` (appends
`:thread:<threadId>` to the session key per
`vendor/clawg-ui/README.md:339–363`). Optional `X-OpenClaw-Session-Key`
header further partitions sessions for multi-tenant deployments
(`http-handler.ts:494–497`). Our mobile client picks `threadId` per
chat tab already, so this is a free win — multiple device pairings
against the same gateway naturally get their own histories.

## 6. What clawg-ui does NOT solve

- **Canvas:** clawg-ui is chat-only. There is no `canvas.*` analogue —
  no schema-driven tree, no HTML/WebView wrapper, no patch broadcasts.
  Upstream OpenClaw's Canvas is an HTML/WebView surface on port 18793
  (`.chalk/openclaw-upstream.md` §6); clawg-ui doesn't bridge it.
- **Voice:** same. No `talk.*` analogue. The clawg-ui plugin sets
  `chatTypes: ["direct"]` and `blockStreaming: true`
  (`vendor/clawg-ui/src/channel.ts:20–23`) — it's a one-shot prompt /
  one streamed reply per request, deliberately scoped to chat.
- **Node-as-device callbacks:** upstream's `node.invoke.request` →
  device handler → `node.invoke.result` round-trip (open question #37)
  is not exposed by clawg-ui. If mobile needs to handle gateway-initiated
  commands (take a screenshot, send GPS), it can't reach them through
  clawg-ui's HTTP surface.

These three live in **P11C** — we decide whether to extend clawg-ui (PR
upstream), build sibling plugins, or keep them stub-only for v1.

## 7. What it changes for our planning

- **P10A is mostly obsolete.** The hand-rolled `OpenClawBridge`
  (`apps/desktop/src/main/gateway/openclaw-bridge.ts:737` lines) was a
  router → JSON-RPC translator for chat-only. clawg-ui does the same
  translation server-side, the right way. We retire the bridge in
  **P11D**.
- **P10B (protocol alignment) is mostly obsolete.** Our
  `@openclaw/protocol` envelope shape (`{ id, topic, type, payload, ts }`)
  no longer needs to match upstream's `req`/`res`/`event` JSON-RPC
  shape, because clawg-ui adapts in the opposite direction. We keep
  `@openclaw/protocol` for the stub gateway path only.
- **P10C (e2e against real daemon) becomes P11E.** Now we need to spin
  up a daemon with the clawg-ui plugin installed and run our existing
  mobile chat scenario against it.
- **P10D (upstream PRs) is reframed.** Some of the upstream PR ideas
  (Canvas-as-schema, CopilotKit runtime as a plugin) are already done
  by clawg-ui. Others (6-digit pairing, schema Canvas, Voice plugin)
  remain candidates — and the right repo to PR them to may be
  `clawg-ui` itself rather than `openclaw/openclaw`. P11C explores this.

## 8. Risks / open questions

Tracked as new entries in `.chalk/open-questions.md`:

- **#42 — Pairing UX seam.** clawg-ui's `openclaw pairing approve
  clawg-ui <code>` is a CLI invocation on the gateway host. We need a
  desktop button that wraps it (P11B).
- **#43 — Plugin install path.** Does the desktop supervise
  `openclaw plugins install @contextableai/clawg-ui` for the user, or
  is that a manual one-time step in our onboarding docs?
- **#44 — Canvas + Voice real-mode strategy.** Three options in P11C.
- **#45 — Fork-vs-vendor revisit trigger.** Vendored for v1. We fork
  when (a) we need a patch upstream won't accept, or (b) we need to
  pin a non-tag commit while waiting for a release.
