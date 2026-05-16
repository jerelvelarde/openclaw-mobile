# `@openclaw/protocol` vs upstream — gap analysis (P10.0)

This is the per-concept comparison between our `packages/protocol/src/`
and the real upstream OpenClaw gateway as captured in
`.chalk/openclaw-upstream.md`. Each row carries an **action** that
P10A (bridge) and P10B (protocol-align) need to take.

Severity tags:

- 🟥 **Blocker** — wire-incompatible; the bridge cannot exist without
  resolving this.
- 🟧 **Major** — semantically close but shapes differ; bridge can
  translate but the code is non-trivial.
- 🟨 **Minor** — naming/typing drift; one-day fixup.
- 🟩 **Match** — already compatible; no action needed.

---

## A. Wire envelope & dispatch

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| A1 | Frame shape | `{ id, topic, type, payload, ts }` (`packages/protocol/src/envelope.ts:19–25`) | Discriminated union of `{ type:"req", id, method, params? }` / `{ type:"res", id, ok, payload?, error? }` / `{ type:"event", event, payload?, seq?, stateVersion? }` (`src/gateway/protocol/schema/frames.ts:138–177`) | 🟥 | **P10B:** drop our `Envelope<T>` in `@openclaw/protocol`; replace with `RequestFrame`/`ResponseFrame`/`EventFrame` mirroring upstream. Keep `Envelope` as an internal name for the legacy stub during the transition. **P10A:** the bridge translates between the two so app code can be migrated incrementally. |
| A2 | Dispatch key | `topic` (`threads.*` / `agents.*` / `canvas.*` / `voice.*` / `system.*`) + `type` | `method` (RPCs, ~200 in `core-descriptors.ts:18–210`) and `event` (server-initiated) | 🟥 | **P10B:** retire the `topic` taxonomy. Map each of our topics to upstream methods/events per `openclaw-upstream.md` §12 cheat sheet. |
| A3 | Response correlation | Implicit via `ctx.reply({ id: frame.id })` in stub router | Explicit `{ type:"res", id }` matching the `req`'s `id` | 🟧 | Keep our correlation pattern; just emit upstream-shaped frames. |
| A4 | Error format | `Error` thrown from handlers; ad-hoc `{ ok:false, reason }` on some replies | `ErrorShape { code, message, details?, retryable?, retryAfterMs? }` (`frames.ts:127–136`) | 🟧 | **P10B:** adopt `ErrorShape` in `@openclaw/protocol` and have the WS server map thrown errors to it. **P10A:** the bridge translates upstream `ErrorShape` → JS `Error` with the same fields. |
| A5 | Timestamps on frames | Required `ts` on every envelope | Not on the envelope; events that need a clock include `ts` in their payload (e.g. `device.pair.requested.ts`, `tick.ts`) | 🟨 | Drop `Envelope.ts`. Per-event timestamps stay where upstream puts them. |
| A6 | Heartbeats | Renderer-emitted ping/pong (P04A) | Server-emitted `event:"tick" payload:{ ts }` at `HelloOk.policy.tickIntervalMs` | 🟨 | **P10A:** subscribe to `tick`; remove our ping/pong from the real path. |
| A7 | Capability discovery | Hand-rolled per app | `HelloOk.features = { methods: string[], events: string[] }` (`frames.ts:84–90`) | 🟧 | **P10A:** the bridge stores `features` after connect; mobile can gate UI on capability presence. Eventually we expose this through `@openclaw/protocol`. |

## B. Auth & pairing

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| B1 | Pair-request channel | `POST /pair/request` (HTTP) with `{ deviceName, publicKey }` (`packages/protocol/src/types.ts:23–26`) | No HTTP `pair/request`. Bootstrap token + URL handed off out-of-band (QR over a DM channel, or `openclaw pairing approve <ch> <code>` CLI) (`src/pairing/setup-code.ts:380–407`) | 🟥 | Two paths: (a) **P10A** generates a bootstrap token desktop-side and renders it as a QR / shows the 6-digit (so the mobile UX stays); the mobile-side `requestPairing()` becomes a no-op when the bootstrap token is supplied directly. (b) **P10D** floats the 6-digit code idiom as a PR back. |
| B2 | Approval signal | `GET /pair/status?pair_id` poll → `{ status, token?, runtimeUrl? }` (`packages/protocol/src/types.ts:30–37`) | The bootstrap token **IS** the approval. Bringing the token + Ed25519-signed `connect` succeeds (returns `deviceToken`) or fails (close 1008). | 🟥 | Drop polling. Bridge presents one combined call: "I have a bootstrap token, give me a deviceToken." |
| B3 | Bearer credential | Opaque `Token { value, expiresAt }` (`types.ts:14–20`); WS uses `Authorization: Bearer …` header | Ed25519 device signature over `nonce` + `auth.deviceToken` in the connect-RPC `params`. No HTTP `Authorization` header on the WS upgrade. (`src/gateway/client.ts:537–581`) | 🟥 | **P10A:** the bridge owns the Ed25519 keypair (per-gateway) and assembles the `device` payload on every connect. Mobile keeps its current `Token`-shaped storage but the bridge unwraps and re-signs. |
| B4 | Token rotation / revocation | Implicit via re-pairing | Methods `device.token.rotate` / `device.token.revoke` (`src/gateway/protocol/schema/devices.ts:21–36`) | 🟨 | Expose in the bridge once we need it; mobile UI affordance later. |
| B5 | Pairing token storage | iOS keychain via expo-secure-store; desktop in macOS keychain via `keytar` | Same idea (per-platform keystore). Profile fixed to `{ roles:["node"], scopes:[] }` (`src/shared/device-bootstrap-profile.ts:22–25`) | 🟩 | Match. |
| B6 | Nonce challenge | Not used — pairing is HTTP, WS auth is bearer | Server emits `event:"connect.challenge" payload:{ nonce }` immediately on socket open; client must echo `nonce` inside the signed `device` payload of the `connect` req | 🟥 | **P10A:** the bridge handles the challenge dance and resigns each connect. |

## C. Threads / chat

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| C1 | Thread model | `Thread { id, title, agentId, updatedAt }` (`types.ts:52–58`) | Session keys + per-agent session stores (`src/gateway/protocol/schema/sessions.ts`); a session can have a derived title (`includeDerivedTitles` opt) and last-message preview | 🟧 | Map upstream `SessionSummary` → our `Thread`. `thread.id === sessionKey` is the natural bridge. |
| C2 | List threads | `listThreads(): Thread[]` | `req method:"sessions.list" params:{ limit?, includeDerivedTitles?, includeLastMessage?, agentId?, label?, … }` (`sessions.ts:52–83`) | 🟧 | Bridge: enable `includeDerivedTitles` for the title field; cap `limit` per a sensible default. |
| C3 | Post message | `postMessage(threadId, { content })` | `req method:"chat.send" params:{ sessionKey, message, idempotencyKey, … }` (`logs-chat.ts:35–54`) | 🟧 | Bridge synthesises `idempotencyKey = uuid`; passes `threadId` as `sessionKey`. |
| C4 | Stream thread | `streamThread(id, onEvent)` returning typed `ThreadEvent` | Subscribe via `req method:"sessions.messages.subscribe" { sessionKey }`, then consume `event:"chat.delta" / "chat.final" / "chat.aborted" / "chat.error"` (`logs-chat.ts:73–139`) | 🟧 | Bridge mapping table: <br>`chat.delta { deltaText }` → our `{ type:"token", messageId:<runId>, delta: deltaText }`<br>`chat.final { message }` → our `{ type:"message", message }` + `{ type:"done", messageId }`<br>`chat.aborted` → `{ type:"done", messageId }` + sideband UI<br>`chat.error` → `{ type:"done" }` + emit our `error` channel |
| C5 | Tool calls in stream | `{ type:"tool_call", messageId, toolName, args }` (`types.ts:85–104`) | Carried inside the talk path (`type:"tool.call"`) and inside agent events as run-segments; chat events don't have a top-level tool-call variant | 🟧 | **Open delta** — needs sub-survey of `src/agents/*` to find the chat-side tool-call event shape. May need a per-thread "agent.events" subscription too. |
| C6 | Abort | not modelled | `req method:"chat.abort" params:{ sessionKey, runId? }` (`logs-chat.ts:56–62`) | 🟨 | Add to `GatewayClient` in P10B. |
| C7 | Inject | not modelled | `req method:"chat.inject"` (advertise:false, admin-only) | 🟩 | Out of scope for v1 mobile. |
| C8 | History | not modelled | `req method:"chat.history" params:{ sessionKey, limit?, maxChars? }` (`logs-chat.ts:26–33`) | 🟨 | Add to `GatewayClient` so mobile can scroll back. |

## D. Agents

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| D1 | Agent model | `Agent { id, name, description? }` (`types.ts:42–49`) | `AgentSummary` (richer; includes status / config / scopes — see `AgentSummarySchema` in `src/gateway/protocol/schema/agents-models-skills.ts`) | 🟧 | Map upstream → our shape; keep upstream's extras opt-in. |
| D2 | List | `listAgents()` | `req method:"agents.list"` (operator.read) | 🟩 | Direct map. |
| D3 | Set active agent | `setActiveAgent(id)` (`client.ts:84`) | No upstream method. Agent selection is per-`sessionKey` (each session belongs to one agent) | 🟧 | **Recommendation:** deprecate `setActiveAgent`. Mobile picks an agent when starting a thread and the agent is baked into `sessionKey`. P10B removes it from `GatewayClient`. |
| D4 | Hermes-as-agent | One entry in `listAgents()` (open Q #10) | Confirmed: Hermes runs as an ACP child process the gateway spawns; appears as one `AgentSummary` if configured in `~/.openclaw/openclaw.json` agents | 🟩 | Resolves open question #10. See `.chalk/openclaw-upstream.md` §7.3. |

## E. Canvas

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| E1 | Surface model | Tree of typed nodes (`StackNode`/`HeadingNode`/`TextNode`/`ButtonNode`/`TextInputNode`/`SelectNode`/`ListNode`) with `id` per node (`packages/protocol/src/canvas/types.ts`) | A WebView URL serving HTML/CSS/JS from `canvasHost.root` (`skills/canvas/SKILL.md`, `extensions/canvas/src/host/a2ui-shared.ts:5`) | 🟥 | **Fundamental mismatch.** Two options for v1: (a) The bridge renders the upstream HTML in a native WebView on mobile too (parity with iOS/Android upstream apps). Our tree-Canvas becomes a desktop-only renderer. (b) Keep our tree-Canvas and have the desktop optionally render *both* — phone gets the tree, desktop chrome shows HTML. **Decision needed.** Floated as new open question #36. |
| E2 | Patches | `CanvasPatch` ops (`AddNode`/`RemoveNode`/`ReplaceProps`/`SetText`) (`packages/protocol/src/canvas/types.ts`) | A literal `"reload"` string broadcast on `CANVAS_WS_PATH` (`a2ui-shared.ts:60`) | 🟥 | If we go option (a) above, patches collapse to "reload"; if (b), our patch model is purely additive (upstream-incompatible). |
| E3 | Events | `CanvasEvent { surfaceId, nodeId, type, payload }` (`packages/protocol/src/canvas/types.ts`) | A2UI `userAction` JSON posted from the WebView via the JS bridge (`a2ui-shared.ts:42–47`) → routed back through the node session as `node.invoke.result` or equivalent | 🟧 | Translatable; needs the A2UI message schema (gap §11 #7). |
| E4 | Capability tokens | None (we rely on the WS auth) | Signed `oc_cap` query param with TTL (`mintCanvasCapabilityToken`, `CANVAS_CAPABILITY_TTL_MS`) | 🟨 | Adopt if we go with WebView rendering; ignore otherwise. |
| E5 | Schema version | `CANVAS_SCHEMA_VERSION` constant | Not applicable (HTML is unversioned) | 🟩 | n/a |

## F. Voice / talk

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| F1 | Session open | `openVoice(opts)` returning `VoiceSession` (`packages/protocol/src/voice/types.ts`) | `req method:"talk.session.create" params:{ sessionKey, mode, transport, brain, … }` (`channels.ts:204–221`) | 🟧 | Direct map. |
| F2 | Modes | implicit | `realtime` / `stt-tts` / `transcription` (`channels.ts:39–43`) | 🟧 | Surface `mode` in `VoiceOpts`. |
| F3 | Transports | "WS frames" vs "WebRTC" decision punted to runtime | `webrtc` / `provider-websocket` / `gateway-relay` / `managed-room` (`channels.ts:45–50`) | 🟧 | Add `transport` to `VoiceOpts` with the upstream union. WebRTC is the preferred default; gateway-relay is the fallback we'd use if WebRTC fails. |
| F4 | Audio frame on the wire | `VoiceFrame.data: Uint8Array` (currently unused on the wire; in-process uses `VoiceFrameWire` PCM16-as-numeric-array) | `talk.session.appendAudio params:{ sessionId, audioBase64, timestamp? }` (`channels.ts:223–230`); base64 PCM/Opus inside JSON | 🟥 | **P10B:** drop `VoiceFrame.data: Uint8Array` from the wire model; add a `VoiceFrameAppend` payload mirroring upstream. The in-process `VoiceFrameWire` PCM16 path remains valid for the desktop's agent bridge. Resolves open question #33. |
| F5 | Transcript events | Single `VoiceTranscript { text, isFinal, ts }` | `TalkEvent.type` ∈ `transcript.delta` / `transcript.done` (`channels.ts:73–74`) with the full `TalkEvent` envelope | 🟧 | Bridge maps `transcript.delta` → `{ isFinal:false }`; `transcript.done` → `{ isFinal:true }`. |
| F6 | Output audio | not modelled | `output.audio.delta` / `output.audio.done` events | 🟧 | Add to the voice client surface. |
| F7 | Tool calls during talk | not modelled (out of scope for v1 voice) | `tool.call` / `tool.progress` / `tool.result` / `tool.error` in `TalkEvent` | 🟨 | Defer to v2 voice. |
| F8 | TTS-only | not modelled | `req method:"talk.speak" params:{ text, voiceId?, modelId?, … }` (`channels.ts:19–37`) | 🟨 | Useful for notifications. Add post-v1. |
| F9 | VAD knobs | not exposed | `vadThreshold` / `silenceDurationMs` / `prefixPaddingMs` on talk.create | 🟨 | Expose via `VoiceOpts` advanced. |

## G. Discovery (mDNS / Bonjour)

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| G1 | Service id | `_openclaw._tcp.local.` (apps/mobile + apps/desktop discovery code per `desktop-app.md` §3 and the Bonjour zeroconf config in `apps/desktop/src/main/...`) | `_openclaw-gw._tcp.local.` (`extensions/bonjour/src/advertiser.ts:479`, `type: "openclaw-gw"`) | 🟥 | **P10A:** change the advertised/scanned service type in both apps. Add backward-compat scan for our legacy id during a deprecation window so already-shipped dev clients still pair. |
| G2 | TXT keys | `host`, `port`, `version`, `gateway_id` (per `desktop-app.md` §2) | `role`, `gatewayPort`, `lanHost`, `displayName`, `transport`, plus optional `gatewayTls`, `gatewayTlsSha256`, `canvasPort`, `tailnetDns`, `cliPath`, `sshPort` (`advertiser.ts:442–469`) | 🟧 | **P10A/B:** align on the upstream key names. Our `gateway_id` has no direct equivalent (it's logically baked into the host's per-machine identity); we may want to add it upstream (PR-back candidate) or persist it client-side. |
| G3 | Default port advertised | 18789 | 18789 (`src/config/paths.ts:254`) | 🟩 | Match. |

## H. HTTP routes

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| H1 | Health | `GET /healthz` | `GET /health` and `GET /healthz` both work; `/ready` and `/readyz` for readiness (`src/gateway/server-http.ts:157–162`) | 🟩 | Match. |
| H2 | Pairing HTTP | `POST /pair/request` + `GET /pair/status` (our invention) | None — out-of-band setup (see B1/B2) | 🟥 | Drop (or keep desktop-side only for our own UI). |
| H3 | CopilotKit runtime | `POST /copilot/runtime` (our adapter) | Not in upstream (closest: OpenAI-compat shim `POST /v1/chat/completions`) | 🟩 | Stays ours; potentially a PR-back as `extensions/copilot-runtime`. |
| H4 | OpenAI-compat | not implemented | `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`, `/v1/responses`, `/tools/invoke` (`server-http.ts:202–220`) | 🟩 | Not needed for mobile. |
| H5 | Session mgmt | not implemented | `GET /sessions/<id>/history`, `POST /sessions/<id>/kill` (`server-http.ts:226–232`) | 🟨 | Could be useful for power users; not v1 mobile. |

## I. Node-as-device (the mobile is a "node")

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| I1 | Device-initiated commands | not modelled | Gateway → device: `event:"node.invoke.request"` carrying `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }` (`nodes.ts:197–207`). Device replies via `req method:"node.invoke.result"` (`nodes.ts:118–136`). | 🟧 | **New surface for `@openclaw/protocol`.** The gateway can ask the phone for "current location", "take a screenshot", "open canvas URL", etc. Our `GatewayClient` interface has no symmetric path. Add `handleNodeInvoke(handler)` in P10B. |
| I2 | Unsolicited node events | not modelled | `req method:"node.event" params:{ event, payload?, payloadJSON? }` (`nodes.ts:138–145`) | 🟧 | Counterpart of I1; for telemetry like "battery low", "wifi changed". Add `sendNodeEvent()` in P10B. |
| I3 | Offline queue | not modelled | `node.pending.{drain,pull,ack,enqueue}` (`nodes.ts:147–195`); pending-work types are `status.request` / `location.request` (`nodes.ts:4–6`) | 🟨 | Useful for "you missed these while backgrounded" semantics. Out of scope v1 unless P08 needs it. |
| I4 | Capability advertise | implicit | `caps[]` array in `ConnectParams` (`frames.ts:37`) + `pluginSurfaceUrls` in `HelloOk` | 🟧 | Bridge declares mobile's caps at connect time. |
| I5 | Presence | not modelled | `event:"node.presence.alive" payload:NodePresenceAlivePayload` (`nodes.ts:23–35`) with trigger ∈ `background | silent_push | bg_app_refresh | significant_location | manual | connect` | 🟨 | For push-driven wakeups; relevant when P08 lands a real bridge. |

## J. Skills / agents (workspace files)

| # | Concept | Ours | Upstream | Severity | Recommendation |
|---|---------|------|----------|----------|----------------|
| J1 | Per-skill file layout | Assumed `AGENTS.md` / `SOUL.md` / `TOOLS.md` per skill (per `plan.md` §3 diagram) | Single `SKILL.md` per skill at `~/.openclaw/workspace/skills/<id>/SKILL.md`. `AGENTS.md`/`SOUL.md`/`TOOLS.md` are **workspace-root** files (`src/agents/workspace.ts:21–28`) | 🟨 | **Doc-only fix.** `plan.md` and `compatibility.md` should be corrected in a separate non-code commit (NOT this plan — those files are out-of-scope here). Tracked as a follow-up in P10B. |
| J2 | Per-skill bins | not modelled | `req method:"skills.bins"` (scope `node`) returns CLI binaries the skill ships (`core-descriptors.ts:110`) | 🟨 | Defer; only relevant if mobile exposes a skill catalog. |
| J3 | Skill install | not modelled | `req method:"skills.install"` / `.update` / `.search` / `.detail` | 🟩 | Out of scope for v1 mobile (consistent with `plan.md` §1 non-goals). |

---

## K. Cost/benefit summary

### What we got right (keep as-is)

- The `GatewayClient` interface seam (per `plan.md` §7) is the
  right abstraction — it lets us swap stub → bridge without touching
  UI. Recommended bridge implementation is `realGateway.ts` adjacent
  to `stub.ts`.
- Default port `18789`, mDNS-based discovery, per-device Ed25519
  keypairs, secure-storage for the device credential, push fanout
  through the desktop — all align with upstream practice.
- ACP-as-bridge for Hermes (open Q #10): correct. Hermes is an ACP
  child of the gateway, surfaced as one `AgentSummary`.

### What needs surgical change (P10B)

- **Envelope shape** (A1/A2). Single biggest churn.
- **Pairing handshake** (B1/B2/B3/B6). HTTP `/pair/request` is our
  invention; bootstrap-token + signed `connect` is upstream.
- **Voice frame wire shape** (F4). Base64 inside JSON, not typed
  arrays.
- **Bonjour service id** (G1). One-char fix in two files but
  wire-incompatible.

### What needs design re-think (P10B + new questions)

- **Canvas** (E1/E2). Tree-vs-HTML is not a translation; we need to
  pick a stance. Question #36 added.
- **Node-as-device methods** (I1/I2). Upstream expects the mobile to
  *respond to commands*, not just *send chats*. We have no surface for
  this. Question #37 added.
- **Capability discovery** (A7). Adopting `HelloOk.features` lets
  mobile gate UI on what the gateway actually supports. Question #38
  added (defer until needed).
- **`setActiveAgent`** (D3). Upstream has no such concept; we should
  bake `agentId` into `sessionKey` instead. Question #39 added.

### What we should contribute back (P10D)

See `openclaw-upstream.md` §13. Highlights:

1. Schema-driven Canvas alongside HTML.
2. CopilotKit runtime as an `extensions/copilot-runtime` plugin.
3. 6-digit pairing UX (mobile-friendly DTOR over the existing
   `device.pair.requested` event).

---

## L. Recommended sequencing

1. **P10A first** — write the bridge `realGateway.ts` against the
   upstream wire format. Keep `@openclaw/protocol` unchanged. Translate
   in the bridge. This gets us a real wire test ASAP without churning
   every UI component.
2. **P10B second** — once the bridge proves the mappings work,
   migrate `@openclaw/protocol` to the upstream shape and remove the
   translation layer. Most app code shouldn't change because it
   already goes through `GatewayClient`; only the internal types shift.
3. **P10C third** — e2e against a real local gateway (Mac mini in
   dev). Catches gaps §11 #1, #6, #7 (multi-agent routing, voice
   relay frame shape, A2UI schema).
4. **P10D last** — PR-back contributions to upstream.

Doing it in this order means we have running code against real
upstream after P10A even if P10B churns the protocol package later.
