# OpenClaw upstream protocol — pinned spec (P10.0)

This document is the source-of-truth read of the **real**
[`openclaw/openclaw`](https://github.com/openclaw/openclaw) gateway daemon
and [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent),
captured against `/tmp/upstream-openclaw` and `/tmp/upstream-hermes`
(shallow clones, default branch at survey time). Every claim cites a real
file path + line number from those clones so P10A's bridge can implement
against actual upstream call sites.

If a section says "not observed in upstream", that is a **gap** — either
upstream doesn't ship it (and our `@openclaw/protocol` invented it) or
this survey missed it. Gaps are explicitly listed in §11 and tracked in
`open-questions.md`.

---

## 0. TL;DR mapping cheat sheet

| Concept (ours)                | Upstream equivalent                                                                                | Status               |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| `apps/desktop` Electron       | Not in upstream — `apps/macos`, `apps/ios`, `apps/android` are SwiftUI / native node clients only  | Our addition         |
| `_openclaw._tcp.local.` mDNS  | `_openclaw-gw._tcp.local.` (`extensions/bonjour/src/advertiser.ts:479`)                            | **Wrong service id** |
| Custom JSON envelope          | Discriminated JSON-RPC-ish `req`/`res`/`event` frames (`src/gateway/protocol/schema/frames.ts`)    | **Wrong shape**      |
| `topic` + `type`              | `method` (req) / `event` (event); no topic taxonomy upstream                                       | **Wrong dispatch**   |
| 6-digit pairing code (mobile) | Bootstrap-token + URL handed off out-of-band (QR / DM / setup link)                                | **Wrong handshake**  |
| Bearer-token WS auth          | Ed25519-signed `connect` RPC over server-issued nonce challenge                                    | **Wrong auth**       |
| `threads.post` / `threads.event` | `chat.send` (RPC) → `chat.delta` / `chat.final` events keyed by `runId`/`sessionKey`             | **Wrong methods**    |
| Schema-driven Canvas tree     | `extensions/canvas/src/host/a2ui.ts` — full HTML over A2UI WebView surface                         | **Wrong renderer**   |
| `voice.frame` PCM16/Opus      | `talk.session.appendAudio` (base64 PCM); `talk.session.startTurn`; transports: webrtc/ws/relay     | **Wrong shape**      |
| `openclaw/protocol@workspace` | Upstream ships `apps/shared/OpenClawKit/Sources/OpenClawProtocol` (Swift) + ad-hoc TS server types | Parallel impl        |

The full per-section deltas (with recommendation) live in
`openclaw-deltas.md`. This file documents the upstream truth.

---

## 1. Daemon lifecycle

### 1.1 Process / entry point

- CLI entry: `openclaw gateway --port 18789 [--verbose]`
  (`README.md:117–119`).
- The CLI binary is the project's `openclaw.mjs` shim launching `dist/index.js`
  (`openclaw.mjs`, `tsdown.config.ts`); production builds vend a CommonJS
  bundle under `dist/`.
- Install/onboard flow: `openclaw onboard --install-daemon` writes a
  `launchd` agent (macOS), `systemd --user` unit (Linux), or Windows
  service shim (`README.md:32, 105`; the migration script special-cases
  `openclaw-gateway.service` and `openclaw.exe/clawd.exe` at
  `hermes_cli/claw.py:69–87` of the Hermes repo).
- Default port: **`18789`** (`src/config/paths.ts:254`,
  `export const DEFAULT_GATEWAY_PORT = 18789`).
- TXT-record advertised port can also include a separate **`canvasPort`**
  (default 18793 per `skills/canvas/SKILL.md:18–22`) — see §6.

### 1.2 Filesystem layout

- Workspace root resolution: `src/agents/workspace-default.ts:6–20`.
  - Env `OPENCLAW_WORKSPACE_DIR` wins.
  - Else `OPENCLAW_PROFILE` (non-`default`) → `~/.openclaw/workspace-<profile>`.
  - Else `~/.openclaw/workspace`.
- Workspace-root context files (loaded into every agent's system prompt):
  - `AGENTS.md` (`src/agents/workspace.ts:21`) — coordinator-style rules / red lines.
  - `SOUL.md` (`src/agents/workspace.ts:22`) — persona / tone.
  - `TOOLS.md` (`src/agents/workspace.ts:23`) — tool usage guidance (note: usage, not availability — `src/agents/system-prompt.ts:1018`).
  - `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`
    (`src/agents/workspace.ts:24–28`).
- Skills directory is `~/.openclaw/workspace/skills/<skill-id>/` (read by
  `extensions/canvas/src/...` and friends; example `~/.openclaw/skills/...`
  for hub-installed extras per `hermes_cli/claw.py:46–53`). Each skill
  ships a single **`SKILL.md`** file (e.g. `skills/canvas/SKILL.md`,
  `skills/whatsapp-mac/SKILL.md`). The `AGENTS.md`/`SOUL.md`/`TOOLS.md`
  triplet is **workspace-level, not per-skill** — our `plan.md` §3
  diagram was wrong about this.
- State: `~/.openclaw/openclaw.json` (config, `skills/canvas/SKILL.md:60`),
  per-agent session files under workspace state dirs
  (`src/agents/workspace.ts:29–30`, dirname `.openclaw`,
  `workspace-state.json`).
- Pairing store (allowlist + bootstrap tokens): under the pairing base
  dir, with `issueDeviceBootstrapToken({ baseDir, profile })` in
  `src/pairing/setup-code.ts:399–403`.

### 1.3 Supervision hooks

- The daemon is a single Node process. It has self-restart sentinels
  (`src/gateway/server-restart-sentinel.ts`) and a respawn-aware entry
  (`src/entry.respawn.ts`).
- No "supervise me from Electron" affordance exists upstream — that is
  fully our addition (see §11).

---

## 2. HTTP surface

The gateway is a single `http.Server` (or `https.Server` if TLS is
configured) constructed in `src/gateway/server-http.ts:473–812`. Routes
are matched **manually** in `handleRequest()` (`server-http.ts:531–810`)
rather than via a router framework. Plugin routes get woven in via
`handlePluginRequest` (`server-http.ts:397–471`).

### 2.1 Probe / health

- `GET /health` → `{ ok: true, status: "live" }` (always 200 once the
  process is up). `src/gateway/server-http.ts:157–162` (the
  `GATEWAY_PROBE_STATUS_BY_PATH` map).
- `GET /healthz` → same as `/health`.
- `GET /ready` → returns `{ ready: true|false, failing?, uptimeMs? }` —
  body is **detailed only if** the caller is loopback or has a valid
  bearer, else `{ ready }` only (`server-http.ts:295–319` +
  `canRevealReadinessDetails` at `:242–266`).
- `GET /readyz` → same as `/ready`.
- All four respond `405` for non-GET/HEAD (`server-http.ts:283–289`).

### 2.2 OpenAI-compatible HTTP shim (when enabled)

Off by default; enabled via config `gateway.http.openAi*`. Routes:

- `POST /v1/chat/completions` (`server-http.ts:210–212`).
- `GET  /v1/models[/...]`     (`server-http.ts:202–204`).
- `POST /v1/embeddings`       (`server-http.ts:206–208`).
- `POST /v1/responses`        (`server-http.ts:214–216`).
- `POST /tools/invoke`        (`server-http.ts:218–220`).

These are pass-throughs that translate to the gateway's internal session
machinery; they are how OpenClaw masquerades as an OpenAI provider so
existing SDKs can talk to it. They are **not** the mobile path.

### 2.3 Plugin / channel HTTP

Channel plugins (Slack events, Webhook receivers, etc.) register their
own paths via the plugin SDK. The set is dynamic and discovered through
`buildPluginRequestStages()` (`server-http.ts:397–471`). Notable
extensions:

- **`extensions/device-pair`** — DM-style pairing approval surface. No
  static HTTP route in the gateway core; the extension renders a QR
  code (`extensions/device-pair/qr-image.ts`) bound to a setup URL that
  embeds the bootstrap token. The URL is rendered by the channel
  (Telegram media, Discord attachment, etc. — see
  `extensions/device-pair/index.ts:80–100`).
- **`extensions/canvas`** — surface paths under `/__openclaw__/canvas`
  and `/__openclaw__/a2ui` (`extensions/canvas/src/host/a2ui-shared.ts:3–7`).

### 2.4 Session / management HTTP

- `GET  /sessions/<id>/history` (`server-http.ts:230–232`).
- `POST /sessions/<id>/kill`    (`server-http.ts:226–228`).
- `GET  /api/chat/media/outgoing/<id>` — outbound media downloads
  (`server-http.ts:222–224`).

### 2.5 Auth

The HTTP layer is gated by `authorizeGatewayHttpRequestOrReply()`
(referenced from `server-http.ts:433`). Bearer-token check based on
the **gateway-wide shared secret** (configured via `openclaw configure
gateway-auth` — see `src/commands/configure.gateway-auth.ts`). Loopback
requests bypass auth iff `gateway.allowRealIpFallback` plus trusted-proxy
config permits (`server-http.ts:246–266`). There is no per-device HTTP
bearer for nodes; nodes use the WS path described in §3.

---

## 3. WebSocket surface

This is the load-bearing channel for everything mobile cares about.

### 3.1 Upgrade

- Path: any path that requests a `websocket` upgrade hits the gateway's
  `httpServer.on("upgrade", ...)` handler (`server-http.ts:843–976`).
  There is **no `/ws` suffix** — the upgrade is path-agnostic.
- Plugins can claim the upgrade first via `handlePluginUpgrade`
  (`server-http.ts:880–923`), but the core node/operator channel
  accepts upgrades on the root.
- Per-IP preauth budget at `server-http.ts:924–942` to throttle
  unauthenticated socket attempts.
- After upgrade succeeds, `wss.handleUpgrade()` emits `connection` on
  the gateway's central `WebSocketServer` (`server-http.ts:945–963`).

### 3.2 Frame envelope — JSON-RPC discriminated union

Defined in `src/gateway/protocol/schema/frames.ts:138–177`:

```ts
// Request: client → server
{ type: "req",  id: string, method: string, params?: unknown }

// Response: server → client (one per request id)
{ type: "res",  id: string, ok: boolean, payload?: unknown, error?: ErrorShape }

// Event: server → client (server-initiated; out-of-band notifications,
// stream segments, capability changes)
{ type: "event", event: string, payload?: unknown, seq?: number, stateVersion?: { … } }
```

`ErrorShape` (`frames.ts:127–136`):
```ts
{ code: string, message: string, details?: unknown,
  retryable?: boolean, retryAfterMs?: number }
```

There is **no `topic` field**, **no `ts` field** on the envelope, and
the discriminator is `type`, not `topic`/`type`. The
`@openclaw/protocol`'s `Envelope<T> = { id, topic, type, payload, ts }`
shape does not match anything upstream — this is the single biggest
delta and the reason the bridge in P10A can't be a thin adapter.

Frames are JSON only, exchanged as text WebSocket messages. Binary
frames are reserved for the `talk` (voice) path under the
`webrtc`/`gateway-relay` transports — see §5.

### 3.3 Connect handshake (server-issued nonce + client-signed connect)

End-to-end, observed via `src/gateway/client.ts:509–600` and
`src/gateway/client.test.ts:537–557`:

1. Client opens the WS to `ws://host:18789/`.
2. Server immediately emits an event:
   ```json
   { "type": "event", "event": "connect.challenge", "payload": { "nonce": "<random>" } }
   ```
3. Client sends a `req` of `method: "connect"` with `ConnectParams`
   (`src/gateway/protocol/schema/frames.ts:20–71`). The full shape:
   ```ts
   {
     minProtocol: number,        // currently 4 (src/gateway/protocol/version.ts)
     maxProtocol: number,        // currently 4
     client: {
       id: string,               // e.g. "openclaw-ios", "openclaw-android"
       displayName?: string,
       version: string,
       platform: string,
       deviceFamily?: string,
       modelIdentifier?: string,
       mode: "frontend" | "backend" | …,  // GATEWAY_CLIENT_MODES
       instanceId?: string,
     },
     caps?: string[],
     commands?: string[],
     permissions?: Record<string, boolean>,
     role?: string,              // "operator" | "node" | …
     scopes?: string[],
     device?: {                  // ← Ed25519 device payload
       id: string,
       publicKey: string,        // base64url raw
       signature: string,        // base64url of ed25519(SIG over canonical payload)
       signedAt: number,         // epoch ms; must match the signed payload
       nonce: string,            // echoes the server's `connect.challenge` nonce
     },
     auth?: {                    // any of these may be present
       token?: string,           // shared-secret bearer (operator role)
       bootstrapToken?: string,  // one-shot setup token (issued by device-pair)
       deviceToken?: string,     // long-lived per-device token (post-graduation)
       password?: string,        // legacy / web-control-UI fallback
       approvalRuntimeToken?: string,
     },
     locale?: string,
     userAgent?: string,
   }
   ```
   The client-side payload builder is `buildDeviceAuthPayloadV3()` and
   `signDevicePayload()` (`client.ts:561–581`).
4. Server validates the signature against the issued nonce and replies
   with a `res` payload of `HelloOk`
   (`src/gateway/protocol/schema/frames.ts:73–125`):
   ```ts
   {
     type: "hello-ok",
     protocol: number,
     server: { version, connId },
     features: { methods: string[], events: string[] },
     snapshot: Snapshot,           // initial state push
     pluginSurfaceUrls?: Record<string, string>,
     auth: {
       deviceToken?: string,       // ← gateway hands back a fresh deviceToken
       role: string,
       scopes: string[],
       issuedAtMs?: number,
       deviceTokens?: Array<{ deviceToken, role, scopes, issuedAtMs }>,
     },
     policy: {
       maxPayload: number,
       maxBufferedBytes: number,
       tickIntervalMs: number,
     },
   }
   ```
5. After this, the socket is authenticated and ready for arbitrary
   `req` calls and incoming `event`s.

### 3.4 Protocol versioning

- `PROTOCOL_VERSION = 4` (`src/gateway/protocol/version.ts:1`).
- `MIN_CLIENT_PROTOCOL_VERSION = 4` (`version.ts:2`).
- `MIN_PROBE_PROTOCOL_VERSION = 4` (`version.ts:3`).

Mismatches at the `connect` reply close the socket; the client is
expected to read `HelloOk.protocol` and refuse to operate if it can't
handle that version.

### 3.5 Heartbeats / ticks

- Server emits periodic `{ type:"event", event:"tick", payload:{ ts } }`
  frames at `HelloOk.policy.tickIntervalMs` (`frames.ts:5–10` for the
  schema; emitted by `src/gateway/server-shared.ts` plumbing).
- WS-level keepalive: standard ws library ping/pong; no application-level
  ping frame is required from clients.
- Graceful shutdown: server emits `{ type:"event", event:"shutdown",
  payload:{ reason, restartExpectedMs? } }` (`frames.ts:12–18`).

### 3.6 Error frames

Errors flow back in two places:

- Synchronous: a `res` frame with `ok:false` carries `error: ErrorShape`
  (§3.2).
- Out-of-band: certain events carry an `errorMessage` + `errorKind` (e.g.
  `ChatErrorEvent`, `src/gateway/protocol/schema/logs-chat.ts:121–132`).

### 3.7 Close codes

- `1008` — connect challenge / signature failure
  (`src/gateway/client.ts:516`).
- `4000-series` not surveyed; the gateway uses ws library defaults for
  rate-limited and budget-exhausted upgrades (HTTP 401 / 429 / 503
  written to the upgrade socket itself — see
  `server-http.ts:322–360`).

---

## 4. Methods (the "topic taxonomy")

There is no `topic` namespace upstream. The gateway has a flat
`CORE_GATEWAY_METHOD_SPECS` table
(`src/gateway/methods/core-descriptors.ts:18–210`) that names every
callable RPC + its required operator scope. Each entry becomes a
descriptor handled by `server-methods.ts`. Plugins can register
additional ones dynamically.

The full core list is in `core-descriptors.ts:18–210` (~200 methods).
For the **mobile path** specifically, the relevant subsets:

### 4.1 Pairing (`device.*` / `node.*`)

Methods (with scopes):

- `node.pair.request` (`operator.pairing`) — `core-descriptors.ts:147`.
  Params at `src/gateway/protocol/schema/nodes.ts:47–64`.
- `node.pair.list` (`operator.pairing`).
- `node.pair.approve` (`operator.pairing`) — `nodes.ts:68–71` takes `{ requestId }`.
- `node.pair.reject` (`operator.pairing`) — `nodes.ts:73–76`.
- `node.pair.remove` (`operator.pairing`) — `nodes.ts:78–81`.
- `node.pair.verify` (`operator.pairing`) — `nodes.ts:83–86`.
- `node.rename` (`operator.pairing`) — `nodes.ts:88–91`.
- `node.list`, `node.describe` (`operator.read`) — `nodes.ts:93,102–105`.
- `device.pair.list`/`approve`/`reject`/`remove` (`operator.pairing`) —
  `src/gateway/protocol/schema/devices.ts:4–19`.
- `device.token.rotate` / `device.token.revoke` (`operator.pairing`) —
  `devices.ts:21–36`.

Pairing events (server → client):

- `device.pair.requested` (`devices.ts:38–57`) — payload includes
  `requestId`, `deviceId`, `publicKey`, `displayName`, `platform`,
  `clientId`, `clientMode`, `role`, `roles`, `scopes`, `remoteIp`,
  `silent`, `isRepair`, `ts`.
- `device.pair.resolved` (`devices.ts:59–67`) — `{ requestId, deviceId,
  decision, ts }`.

The actual code that flips a request from `requested` → `resolved` lives
in the `device-pair` plugin (`extensions/device-pair/api.ts` →
`approveDevicePairing` from `openclaw/plugin-sdk/device-bootstrap`).
Bootstrap tokens are issued via `issueDeviceBootstrapToken({ baseDir,
profile })` (`src/pairing/setup-code.ts:399–403`), with the profile
fixed to `PAIRING_SETUP_BOOTSTRAP_PROFILE = { roles:["node"], scopes:[] }`
(`src/shared/device-bootstrap-profile.ts:22–25`).

The setup hand-off carries `{ url, bootstrapToken, expiresAtMs }`
(`src/pairing/setup-code.ts:394–407`). The QR is rendered by
`extensions/device-pair/qr-image.ts`. The URL is gateway-base + the
plugin's `publicUrl` (e.g. `gateway.example.test:18789/setup`; see
`extensions/device-pair/index.test.ts:744`).

### 4.2 Chat / sessions

Methods (subset, all `operator.write` unless noted):

- `chat.history` — `logs-chat.ts:26–33`. Params `{ sessionKey, limit?,
  maxChars? }`. `operator.read`. Marked `startup: true`
  (`core-descriptors.ts:188`).
- `chat.send` — `logs-chat.ts:35–54`. Params `{ sessionKey, sessionId?,
  message, thinking?, fastMode?, deliver?, originating*, attachments?,
  timeoutMs?, systemInputProvenance?, idempotencyKey }`.
- `chat.abort` — `logs-chat.ts:56–62`.
- `chat.inject` (advertise:false, `operator.admin`) — `logs-chat.ts:64–71`.
- `sessions.list` — `src/gateway/protocol/schema/sessions.ts:52–83`.
- `sessions.send` — `sessions.ts:142+`.
- `sessions.subscribe` / `.unsubscribe` /
  `sessions.messages.subscribe` / `.unsubscribe` —
  `core-descriptors.ts:125–128`.
- `sessions.create`, `sessions.describe`, `sessions.preview`,
  `sessions.compact`, `sessions.delete`, `sessions.reset`,
  `sessions.compaction.{list,get,branch,restore}` — same file.

Chat events (server → client) — `logs-chat.ts:73–139`:

```ts
type ChatEvent =
  | { state: "delta",  runId, sessionKey, spawnedBy?, seq, deltaText, message?, replace?, usage? }
  | { state: "final",  runId, sessionKey, spawnedBy?, seq, message?, usage?, stopReason? }
  | { state: "aborted",runId, sessionKey, spawnedBy?, seq, message?, stopReason? }
  | { state: "error",  runId, sessionKey, spawnedBy?, seq, message?, errorMessage?, errorKind?, usage?, stopReason? }
```

Note these arrive as `{type:"event", event:"chat.delta" | "chat.final" |
"chat.aborted" | "chat.error", payload: ChatEvent }` frames, not as a
single `chat.event` discriminated by `state` inside payload — confirmed
by inspection of the `validateChatEvent` lazy compile point
(`src/gateway/protocol/index.ts:809`) which accepts a union and is
called once per inbound event.

### 4.3 Agents (the "list of running agent identities")

- `agents.list` (`operator.read`) — params at
  `src/gateway/protocol/schema/agents-models-skills.ts` (via
  `AgentsListParamsSchema`); result is `AgentsListResult` of
  `AgentSummary[]`.
- `agents.create`/`update`/`delete` (`operator.admin`).
- `agents.files.list`/`get`/`set` — read/write `AGENTS.md`-style files
  per agent.
- `agent` (the run-an-agent invoke) — `agents.ts:185`, scope
  `operator.write`.
- `agent.identity.get`, `agent.wait` — also exposed.

This is **not** "list of skills"; an upstream "agent" is an addressable
chat persona (potentially routed to its own ACP / LLM provider). Skills
are looser — see §6.

### 4.4 Voice / talk

- `talk.config`, `talk.catalog`, `talk.mode` (modes: `realtime` |
  `stt-tts` | `transcription`).
- `talk.client.create` — `channels.ts:160–175`. Params `{ sessionKey?,
  provider?, model?, voice?, vadThreshold?, silenceDurationMs?,
  prefixPaddingMs?, reasoningEffort?, mode?, transport?, brain? }`.
- `talk.session.create` — `channels.ts:204–221`. Adds `spawnedBy?`, `ttlMs?`.
- `talk.session.join` — `channels.ts:196–202`. `{ sessionId, token }`.
- `talk.session.appendAudio` — `channels.ts:223–230`. `{ sessionId,
  audioBase64, timestamp? }`. **Base64 PCM/Opus inside JSON.** No
  binary WS frames.
- `talk.session.startTurn` / `.endTurn` / `.cancelTurn` /
  `.cancelOutput` / `.submitToolResult` / `.close`.
- `talk.speak` — `channels.ts:19–37`. Direct TTS render (text → audio).
- `talk.client.toolCall` — `channels.ts:177–186`.

Transports (`channels.ts:45–50`): `webrtc | provider-websocket |
gateway-relay | managed-room`. Brains (`channels.ts:52–56`):
`agent-consult | direct-tools | none`.

Talk events (`channels.ts:58–88`, schema at `:120–158`): a single
`TalkEvent` shape with `{ id, type, sessionId, turnId?, captureId?,
seq, timestamp, mode, transport, brain, provider?, final?, callId?,
itemId?, parentId?, payload }`. `type` is one of 26 enumerated values
covering `session.*`, `turn.*`, `capture.*`, `input.audio.*`,
`transcript.*`, `output.text.*`, `output.audio.*`, `tool.*`,
`usage.metrics`, `latency.metrics`, `health.changed`.

WebRTC is the **preferred** transport when present (see iOS Swift
client wiring at `apps/shared/OpenClawKit/Sources/OpenClawKit/`). The
gateway-relay transport is the JSON `appendAudio`/`output.audio.delta`
path used as a fallback.

### 4.5 Node-as-device methods (the `node.*` scope)

Once paired, the **mobile is registered as a "node"** (the iOS/Android
client mode). It then receives invocations *from* the gateway as
events:

- `node.invoke.request` event (schema `NodeInvokeRequestEventSchema` at
  `src/gateway/protocol/schema/nodes.ts:197–207`) — gateway asks the
  device to run a command (e.g. "get current location", "take a
  screenshot", "open canvas URL"). Payload: `{ id, nodeId, command,
  paramsJSON?, timeoutMs?, idempotencyKey? }`.
- Node replies via `node.invoke.result` method
  (`core-descriptors.ts:168`, scope `node`) with
  `NodeInvokeResultParams` (`nodes.ts:118–136`): `{ id, nodeId, ok,
  payload? | payloadJSON?, error? }`.
- Node can emit `node.event` (`core-descriptors.ts:169`) for unsolicited
  notifications (`nodes.ts:138–145`).
- `node.pending.pull` / `.ack` / `.drain` for "things to do while you
  were backgrounded" (offline queue; see `nodes.ts:147–195` and the
  pull/drain semantics).
- `node.pluginSurface.refresh` — triggers the node to re-fetch the
  capability URLs from `HelloOk.pluginSurfaceUrls`.

Confirmed in the live iOS Swift client at
`apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift:280,
308, 448, 506` (`node.pluginSurface.refresh`, `node.event`,
`node.invoke.request` reception, `node.invoke.result` send).

Pending-work types (`nodes.ts:4–6`): `"status.request" |
"location.request"`. Priorities: `default | normal | high`.

### 4.6 Other notable method groups

- `cron.{list,get,add,update,remove,run,runs,status}` — full cron CRUD.
- `tools.{catalog,effective,invoke}` — tool registry and invocation.
- `models.{list,authStatus,authLogout}` — provider/model catalog.
- `skills.{status,search,detail,install,update,bins,upload.{begin,chunk,commit}}` — skill management.
- `tasks.{list,get,cancel}` — background tasks.
- `config.{get,set,apply,patch,schema,schema.lookup}` — config CRUD.
- `wizard.{start,next,cancel,status}` — onboarding wizard.
- `gateway.{identity.get,restart.preflight,restart.request}` — supervision.
- `exec.approval.{request,resolve,list,waitDecision,get}` and
  `exec.approvals.{get,set,node.get,node.set}` — exec policy + approvals.
- `plugin.approval.*`, `plugins.{uiDescriptors,sessionAction}` —
  plugin approvals + UI surfaces.

The complete list (and which are `advertise:false`) is at
`core-descriptors.ts:18–210`.

---

## 5. Voice transport details

- Realtime path (`transport: "webrtc"`): standard SDP offer/answer
  exchanged via `talk.session.*` methods; ICE candidates carried inside
  `talk.client.toolCall` / `talk.session.submitToolResult` extensions.
  The audio itself rides RTP outside the WS.
- Provider-websocket: gateway opens a WS to the LLM provider (OpenAI
  Realtime, etc.) and proxies; client still uses
  `talk.session.appendAudio` to feed PCM in.
- Gateway-relay (`transport: "gateway-relay"`): pure JSON. Client posts
  `talk.session.appendAudio { sessionId, audioBase64, timestamp? }`;
  gateway emits `talk.event` of type `output.audio.delta` with payload
  containing base64 PCM. The audio codec helper at
  `src/talk/audio-codec.ts:50+` does PCM resampling (telephony 8 kHz
  ↔ 16 kHz) so frame rates can be mismatched.
- Managed-room: gateway brokers a third-party room (e.g. LiveKit). The
  `talk.session.join { sessionId, token }` shape (`channels.ts:196–202`)
  is the join handshake.

VAD knobs (`vadThreshold`, `silenceDurationMs`, `prefixPaddingMs`) live
on `talk.client.create` and `talk.session.create` — server-side VAD by
default.

---

## 6. Canvas

Canvas upstream is an HTML/WebView surface, **not** a schema-driven
tree of nodes. Key files:

- `extensions/canvas/src/host/a2ui-shared.ts:3–7` declares:
  ```ts
  export const A2UI_PATH       = "/__openclaw__/a2ui";
  export const CANVAS_HOST_PATH = "/__openclaw__/canvas";
  export const CANVAS_WS_PATH   = "/__openclaw__/ws";
  ```
- `extensions/canvas/src/host/server.ts` runs an HTTP server on
  `canvasHost.port` (default **18793** per `skills/canvas/SKILL.md:18–22,
  64–73`), serving static files from `canvasHost.root` (default
  `/Users/you/clawd/canvas`).
- `extensions/canvas/runtime-api.ts:1–20` exports the public canvas
  config schema (`canvasConfigSchema`), `createCanvasHostHandler`,
  `startCanvasHost`, document helpers (`createCanvasDocument`,
  `resolveCanvasDocumentDir`), capability tokens
  (`mintCanvasCapabilityToken`, `CANVAS_CAPABILITY_PATH_PREFIX`,
  `CANVAS_CAPABILITY_TTL_MS`), and the WS live-reload (`CANVAS_WS_PATH`).
- The Canvas client-side bridge (injected at the bottom of every
  rendered HTML page) lives in `a2ui-shared.ts:13–72`. It wires
  `window.OpenClaw.postMessage()`,
  `window.OpenClaw.sendUserAction({...})`, and the live-reload
  WebSocket. Native node apps intercept by registering message handlers
  named `openclawCanvasA2UIAction` (`a2ui-shared.ts:21–37`):
  - iOS: `window.webkit.messageHandlers.openclawCanvasA2UIAction.postMessage(json)`.
  - Android: `window.openclawCanvasA2UIAction.postMessage(json)`.
- The native node presents the canvas WebView in response to a
  `node.invoke.request { command: "canvas.present", paramsJSON: {url} }`-style
  call. Actions per the canvas skill (`skills/canvas/SKILL.md:48–56`):
  `present` | `hide` | `navigate` | `eval` | `snapshot`.

Capability tokens: signed `oc_cap` query-string tokens
(`mintCanvasCapabilityToken`); WebView URLs look like
`http://<host>:18793/__openclaw__/canvas/<file>.html?oc_cap=<token>`
with a TTL (`CANVAS_CAPABILITY_TTL_MS`).

Live reload: gateway broadcasts the literal string `"reload"` over
`CANVAS_WS_PATH` (`a2ui-shared.ts:60`).

A2UI (Google's Agent-to-UI protocol) is the action-message shape used
on the `userAction` bridge (`a2ui-shared.ts:42–47`).

**Our schema-driven node tree (`CanvasSurface`/`CanvasPatch` in
`packages/protocol/src/canvas/`) does not exist upstream.** Canvas is
"render HTML in a WebView, post user actions back as JSON over a JS
bridge". This is a fundamental design difference.

---

## 7. Agent execution model

### 7.1 Skills

- A skill lives at `~/.openclaw/workspace/skills/<id>/` with a single
  `SKILL.md` file. Examples shipped in upstream:
  `skills/canvas/SKILL.md`, `skills/blucli/SKILL.md`,
  `skills/discord/SKILL.md`, `skills/whatsapp-mac/SKILL.md`,
  `skills/peekaboo/SKILL.md`, etc. (full list: `ls
  /tmp/upstream-openclaw/skills/`).
- Skills include CLI binaries (`skills.bins` method,
  `core-descriptors.ts:110`, scope `node`); the node fetches the bin
  list when capabilities advertise it.
- Skills are **not** themselves agents. They expose tools / commands
  that agents can call.

### 7.2 Agents / multi-agent routing

- Workspace-root `AGENTS.md` + `SOUL.md` + `TOOLS.md` (+ optional
  `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, etc.) are loaded into the
  system prompt by `src/agents/system-prompt.ts` (see e.g. the
  `SOUL.md`/`TOOLS.md` mentions at `:191, 1018`) and selectively
  re-injected after compactions
  (`src/auto-reply/reply/post-compaction-context.ts:61–157`).
- Per-agent identity / scope: `src/agents/agent-scope-config.ts`,
  `src/agents/agent-scope.ts` define how an agent gets its own session
  store key, model, tool set.
- Multi-agent routing is in `src/routing/` (not surveyed in depth —
  see gap §11). The hooks `src/agents/acp-spawn.ts` +
  `src/agents/agent-runtime-metadata.ts` suggest sub-agents are spawned
  as ACP children with their own runtime config.
- Agent ↔ gateway IPC for the **same-process** path is in-process JS
  calls (`server-methods/agent.ts`).
- Agent ↔ gateway IPC for **external** agents goes through ACP
  (`src/acp/client.ts`, `extensions/acpx/`) — a Zed-style line-delimited
  JSON-RPC over stdio. So an agent can also be a sibling process the
  gateway speaks ACP to.

### 7.3 ACP integration

- Upstream ships its own ACP client (`src/acp/client.ts`) and an
  `acpx` extension that registers ACP-as-transport methods.
- Hermes Agent on the other side runs `acp_adapter/server.py` that
  speaks ACP (`acp.PROTOCOL_VERSION`, `acp.Agent`,
  `acp.update_agent_message_text`,
  `acp.update_agent_thought_text`, etc. — see
  `/tmp/upstream-hermes/acp_adapter/server.py:17–18, 441, 501, 753,
  863, 1212, 1227, 1384, 1402`).
- So Hermes-as-an-agent inside OpenClaw is "OpenClaw spawns Hermes as
  an ACP child, talks line-delimited JSON-RPC over its stdio". Hermes
  appears as **one** entry in `agents.list` (resolving open question #10).

---

## 8. Bonjour / mDNS discovery

`extensions/bonjour/src/advertiser.ts:474–489`:

```ts
const gateway = responder.createService({
  name: safeServiceName(instanceName),  // "Jerel's Mac (OpenClaw)"
  type: "openclaw-gw",                  // ← service id is `_openclaw-gw._tcp.local.`
  protocol: Protocol.TCP,
  port: opts.gatewayPort,
  domain: "local",
  hostname,                             // truncated DNS label, default "openclaw"
  txt: gatewayTxt,
});
```

TXT record contents (`advertiser.ts:442–469`):

| Key                  | Required        | Value                                                                    |
| -------------------- | --------------- | ------------------------------------------------------------------------ |
| `role`               | always          | `"gateway"`                                                              |
| `gatewayPort`        | always          | `"18789"`                                                                |
| `lanHost`            | always          | `"<hostname>.local"`                                                     |
| `displayName`        | always          | prettified instance name                                                 |
| `transport`          | always          | `"gateway"`                                                              |
| `gatewayTls`         | if TLS enabled  | `"1"`                                                                    |
| `gatewayTlsSha256`   | if TLS pin set  | SPKI sha256 fingerprint                                                  |
| `canvasPort`         | if canvas on    | `"18793"` (or whatever `canvasHost.port` is)                             |
| `tailnetDns`         | if non-minimal  | tailnet DNS suffix hint                                                  |
| `cliPath`            | if non-minimal  | path to the `openclaw` CLI on the host                                   |
| `sshPort`            | if non-minimal  | `"22"` (override via opts)                                               |

Default instance name template: `"<hostname> (OpenClaw)"`
(`advertiser.ts:436–440`). User override via `instanceName` arg.

Off-switches: env `OPENCLAW_DISABLE_BONJOUR=1` or config
`discovery.mdns.mode = "off"` (`advertiser.ts:646`).

**The service id `_openclaw._tcp.local.` we currently use in
`apps/mobile` and `apps/desktop` does not match upstream.** Real id
is `_openclaw-gw._tcp.local.`. (The README and our own docs sloppily
used `_openclaw._tcp` — upstream's own `extensions/bonjour/src/ciao.test.ts:56`
comment line is the only place that form appears, and even there it's
clearly mis-typed. The real registered service is `openclaw-gw`.)

---

## 9. Pairing flow (real, end-to-end)

Reconstructed from `src/pairing/setup-code.ts` + `extensions/device-pair/` +
`src/gateway/client.ts`:

```
device (mobile)                                  gateway (Mac mini)
────────────────────                             ─────────────────────
                                                 1. User runs `openclaw pairing approve <channel> <senderId>`
                                                    OR a DM channel auto-routes a new sender to device-pair.
                                                 2. device-pair extension calls issueDeviceBootstrapToken
                                                    ({ baseDir, profile: PAIRING_SETUP_BOOTSTRAP_PROFILE })
                                                    → { token, expiresAtMs } (src/pairing/setup-code.ts:394–407)
                                                 3. device-pair builds setup URL =
                                                    "<publicUrl>/?bootstrapToken=<token>"
                                                    + renders QR (extensions/device-pair/qr-image.ts)
                                                 4. QR sent back over the originating channel (Telegram,
                                                    Discord, …) OR shown by the openclaw CLI.
5. User opens mobile app
6. User scans QR → app extracts
   { url, bootstrapToken }
7. App generates an Ed25519 keypair locally
   (private key stays in iOS Keychain /
    Android Keystore)
8. App opens WS to <gatewayHost>:18789
9. App receives event:               ◄────────  { type:"event", event:"connect.challenge",
                                                  payload:{ nonce } }
10. App computes signed device payload
    (buildDeviceAuthPayloadV3 + signDevicePayload,
     client.ts:561–581) using the nonce.
11. App sends:                       ─────────► { type:"req", id:"r1", method:"connect",
                                                  params: ConnectParams{
                                                    client, role:"node", scopes:["…"],
                                                    device: { id, publicKey, signature,
                                                              signedAt, nonce },
                                                    auth:  { bootstrapToken } } }
                                                 12. Gateway validates sig over nonce,
                                                     burns the bootstrap token,
                                                     mints a long-lived deviceToken.
13. App receives:                     ◄────────  { type:"res", id:"r1", ok:true,
                                                  payload: HelloOk{
                                                    auth:{ deviceToken, role, scopes },
                                                    snapshot, features, … } }
14. App stores deviceToken in secure storage.
15. Subsequent reconnects skip the bootstrap step:
    auth: { deviceToken } in the connect frame.
```

**There is no `POST /pair/request` HTTP endpoint and no 6-digit code
exchange on a poll-loop.** The "code" idiom upstream is the DM
sender-id allowlist code used by `openclaw pairing approve <channel>
<code>` — a per-channel approval, not a TOTP-style symmetric code.

---

## 10. CopilotKit / runtime integration

Not surveyed in upstream — there is **no CopilotKit-shaped HTTP
runtime** in the gateway core. The OpenAI-compat HTTP shim (§2.2) is
the closest thing. Our desktop adapter (P05C) is genuinely additive.

That means `POST /copilot/runtime` doesn't exist upstream; our
`runtimeUrl` value handed back at pairing must point at a path the
desktop app itself serves (which is what `apps/desktop/src/main/copilot/runtime.ts`
already does locally).

---

## 11. Gaps (things this survey did NOT verify)

In priority order:

1. **Multi-agent routing internals** — `src/routing/session-key.ts` was
   imported but the dispatch / selection logic wasn't read in depth. We
   know agents have isolated session keys; we did not pin "which agent
   answers which inbound message" semantics.
2. **TLS / `gateway.tls.*` config wiring** — the WS upgrade handler
   honours TLS but the cert provisioning path (auto / Let's
   Encrypt / user-supplied) was not surveyed.
3. **Hermes ACP transport details** — confirmed Hermes speaks ACP and
   OpenClaw consumes ACP, but the spawn lifecycle (does OpenClaw start
   Hermes? does Hermes register itself?) needs a second pass against
   `src/agents/acp-spawn.ts` + `src/agents/acp-runtime-overlay.ts`.
4. **Approval system** (`exec.approval.*`, `plugin.approval.*`) is a
   first-class concept upstream — mobile may need to surface
   "approval requested" prompts. Out of scope for this survey.
5. **Push notification protocol** — upstream has
   `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayPush.swift`, and
   the gateway has `push.test`, `push.web.*` methods
   (`core-descriptors.ts:199–203`). Did not verify the APNs/FCM token
   registration RPC or the push payload format. Affects P08B's
   replacement.
6. **`gateway-relay` voice transport frame shape** — the JSON shape of
   `talk.event { type:"output.audio.delta", payload }` (whether `payload`
   is `{ audioBase64 }` or something else) was not pulled out of
   `src/talk/session-runtime.ts`. Affects voice fallback in P07.
7. **A2UI message schema** — we have the bridge plumbing
   (`window.OpenClaw.sendUserAction({...})`) but the formal A2UI
   message shape (Google's protocol) was not pinned. Affects what a
   real Canvas renderer needs to emit/accept.
8. **Plugin loading + sandboxing** — `src/plugins/` is large and we
   did not read it. Affects whether we can plausibly ship "openclaw
   desktop" as a plugin instead of an external supervisor (see
   open-questions §B / #2).
9. **Web-push (`push.web.*`) and VAPID** — relevant if web mobile
   surface wants push (we currently use Expo). Did not survey.
10. **Web-login (`web.login.start` / `web.login.wait`)** — the
    operator-side web-control-UI auth flow. Not relevant to mobile.

---

## 12. v1 mapping cheat sheet for P10A (bridge)

The bridge module `apps/desktop/src/main/gateway/realGateway.ts` (to be
created in P10A; today only `stub.ts` exists) must translate:

| Mobile call (`GatewayClient`) | Upstream wire (post-connect)                                                                                                          | Notes                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `requestPairing()`            | n/a HTTP. Mobile must scan a QR or paste a `bootstrapToken` issued by the desktop (`issueDeviceBootstrapToken` SDK call)              | The 6-digit code flow is **our invention**. We can keep it as an Electron-side affordance.         |
| `awaitPaired()`               | n/a — the bootstrap token IS the approval. WS connect with `auth.bootstrapToken` succeeds (returns `deviceToken`) or fails (1008).    | "Pending" / "approved" / "denied" is a UI layer we add on top.                                     |
| `connect(token)`              | Open WS; receive `connect.challenge`; send `req method:"connect" params:{ … auth:{deviceToken: token} … }`; receive `HelloOk`         | Bridge must keep the Ed25519 keypair per gateway.                                                  |
| `listAgents()`                | `req method:"agents.list"` → `AgentsListResult { agents: AgentSummary[] }`                                                            | Map `AgentSummary` → our flatter `Agent`. Hermes appears as one entry.                             |
| `setActiveAgent(id)`          | No direct upstream method. Probably our concept; could be persisted on the desktop side and used at `chat.send` time as `sessionKey`. | Suggest dropping; let mobile send `agentId` per message.                                           |
| `listThreads()`               | `req method:"sessions.list"` → array of `SessionSummary`                                                                              | Map per-agent sessions → our threads. `sessionKey` namespacing matters.                            |
| `postMessage(threadId, msg)`  | `req method:"chat.send" params:{ sessionKey:<threadId>, message:<msg.content>, idempotencyKey }`                                      | `sessionKey` is the thread id. Idempotency key is required.                                        |
| `streamThread(id, onEvent)`   | Subscribe via `req method:"sessions.messages.subscribe" { sessionKey }`; then consume `event:"chat.delta" / "chat.final" / …`         | Our `ThreadEvent` discriminator (`message`/`token`/`tool_call`/`done`) maps to `delta`/`final`.    |
| `getCanvas(surfaceId)`        | n/a in the schema-tree sense. Upstream Canvas is a WebView URL. Bridge has to either render HTML→tree or change our Canvas model.     | This is the largest delta. See `openclaw-deltas.md`.                                               |
| `onCanvasUpdate(...)`         | `event:"canvas.live-reload"` on `/__openclaw__/ws`. Coarse: "reload".                                                                 | We don't get diffs; we get "go re-fetch the HTML".                                                 |
| `postCanvasEvent(event)`      | `node.invoke.result` (if the canvas was opened via `node.invoke.request`) or via the A2UI JS bridge → `userAction` JSON.              | Our `CanvasEvent` shape is not upstream's.                                                         |
| `openVoice(opts)`             | `req method:"talk.session.create" params:{ sessionKey, mode:"realtime", transport:"webrtc"|"gateway-relay", … }`                       | `VoiceOpts.codec` → upstream `model`/`voice`/`mode`/`transport`.                                   |
| `sendVoiceFrame(...)`         | `req method:"talk.session.appendAudio" params:{ sessionId, audioBase64, timestamp? }` (gateway-relay) OR WebRTC RTP (webrtc)         | Our typed-array path translates to base64.                                                         |
| `onVoiceTranscript(...)`      | `event:"talk.event" payload:{ type:"transcript.done", payload:{ text } }`                                                              | Map upstream `TalkEvent.type` → our discriminator.                                                 |

---

## 13. PR-back candidates (things our work might be worth contributing upstream)

Floated for discussion; none committed.

1. **A schema-driven Canvas alongside the HTML one.** Our
   `CanvasSurface`/`CanvasPatch` tree gives screen readers and
   non-WebView renderers a story upstream doesn't have. Could land as
   a sibling `extensions/canvas-schema` plugin that emits both shapes,
   the HTML being the source of truth.
2. **CopilotKit runtime adapter as a plugin.** Our `apps/desktop/src/main/copilot/runtime.ts`
   bridges AG-UI → `chat.send`/`chat.delta`; it could ship as
   `extensions/copilot-runtime` so other front-ends can use it
   without re-implementing.
3. **6-digit pairing UX over the existing `device.pair.requested`
   event.** Upstream's QR/setup-link flow is great for chat channels;
   for the mobile-app-from-LAN-discovery scenario, a TOTP-like 6-digit
   code matched in the desktop UI is friendlier. Could land as an
   alternative flow inside `extensions/device-pair`.
4. **Bonjour TXT keys for "desktop UI present"** so multiple node
   surfaces on the same Mac can negotiate which one approves pairing.
5. **Voice frame typed-array helpers** — if upstream is open to
   binary WS frames for the `gateway-relay` voice path, our wire-side
   `VoiceFrameWire` codec is a head start.

These are notes for P10D, not commitments.

---

## Appendix A — File path index

The upstream files most relevant to this survey, for quick re-reading:

| Concept            | Path                                                              |
| ------------------ | ----------------------------------------------------------------- |
| Default port       | `src/config/paths.ts:254`                                         |
| Protocol version   | `src/gateway/protocol/version.ts`                                 |
| Frame envelope     | `src/gateway/protocol/schema/frames.ts`                           |
| Connect handshake  | `src/gateway/client.ts:500–600` + `client.test.ts:534–557`        |
| Method catalog     | `src/gateway/methods/core-descriptors.ts:18–210`                  |
| HTTP request loop  | `src/gateway/server-http.ts:473–812`                              |
| WS upgrade         | `src/gateway/server-http.ts:815–977`                              |
| WS connection      | `src/gateway/server/ws-connection.ts`                             |
| Pairing setup      | `src/pairing/setup-code.ts:380–407`                               |
| Device pair plugin | `extensions/device-pair/index.ts` + `api.ts` + `qr-image.ts`      |
| Bootstrap profile  | `src/shared/device-bootstrap-profile.ts:22–25`                    |
| Node methods       | `src/gateway/protocol/schema/nodes.ts:47–207`                     |
| Device methods     | `src/gateway/protocol/schema/devices.ts`                          |
| Chat schemas       | `src/gateway/protocol/schema/logs-chat.ts`                        |
| Sessions schemas   | `src/gateway/protocol/schema/sessions.ts`                         |
| Talk / voice       | `src/gateway/protocol/schema/channels.ts:1–250`                   |
| Talk audio codec   | `src/talk/audio-codec.ts`                                         |
| Workspace dirs     | `src/agents/workspace.ts:21–30` + `workspace-default.ts`          |
| Bonjour            | `extensions/bonjour/src/advertiser.ts:425–500`                    |
| Canvas (host)      | `extensions/canvas/runtime-api.ts` + `src/host/a2ui-shared.ts`    |
| iOS gateway client | `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift` |
| Hermes ACP server  | `/tmp/upstream-hermes/acp_adapter/server.py`                      |
| Hermes claw cli    | `/tmp/upstream-hermes/hermes_cli/claw.py`                         |
| Hermes migration   | `/tmp/upstream-hermes/optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py` |
