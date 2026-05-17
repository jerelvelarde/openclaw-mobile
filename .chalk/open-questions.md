# Open questions

What we now know vs. what's still blocking. Group A blocks scaffolding past
M2; Group B can wait until the relevant milestone.

The plan now spans **two apps** (mobile in this repo, Electron desktop in
`openclaw-desktop`) on a Mac mini host. Questions are tagged `[mobile]`,
`[desktop]`, or `[both]`.

---

## What we know now (resolved from the repos)

- **OpenClaw is a local-first gateway daemon**, not a SaaS. Runs on Node 22.16+/24 via `openclaw onboard --install-daemon`; starts via `openclaw gateway --port 18789`. Supports macOS, Linux, Windows (WSL2).
- Workspace at `~/.openclaw/workspace`, skills as `AGENTS.md` / `SOUL.md` / `TOOLS.md` per skill folder.
- Has built-in multi-agent routing to "isolated agents with separate sessions".
- Exposes HTTP on the gateway port and a WebSocket transport for iOS/Android nodes that pair via DM-style codes (`openclaw pairing approve <channel> <code>`).
- Mentions "Canvas surfaces plus voice features" for iOS/Android nodes — confirms the surfaces we should target.
- **Hermes Agent is model-agnostic** (OpenRouter, Nous Portal, NovitaAI, NIM, OpenAI, etc.), invoked via `hermes` / `hermes gateway` / `hermes model` / `hermes tools`.
- Hermes ships `hermes claw migrate` and is compatible with OpenClaw's model — so we treat Hermes as a first-class agent option behind the OpenClaw router.
- Hermes also integrates **MCP servers** for tool extensibility — but those are agent-side, not phone-side.

---

## A. Blockers before code past M2

1. **OpenClaw WS / "device node" protocol** `[both]` — **RESOLVED in P10.0.**
   - Spec captured in `.chalk/openclaw-upstream.md`; deltas vs `@openclaw/protocol` in `.chalk/openclaw-deltas.md`.
   - Wire format is a JSON-RPC-style discriminated union: `req`/`res`/`event` frames (`/tmp/upstream-openclaw/src/gateway/protocol/schema/frames.ts:138–177`), not the `{ id, topic, type, payload, ts }` envelope we ship. `topic` does not exist upstream; dispatch is by `method` (RPC) or `event` (server-pushed).
   - Pairing is bootstrap-token + Ed25519-signed `connect` over a server-issued nonce challenge — there's no `POST /pair/request` HTTP endpoint and no polling. The DM "6-digit code" idiom upstream is a sender-allowlist code, not a TOTP-style pairing code.
   - Topics we collapse into upstream methods: `threads.*` → `chat.*` + `sessions.*`; `agents.*` → `agents.list` (set-active is our invention; upstream sessions are per-agent already); `canvas.*` → `extensions/canvas` HTML/WebView surface (totally different model — see #36); `voice.*` → `talk.*` with base64 PCM inside JSON.
   - Heartbeats are server-emitted `event:"tick" payload:{ ts }` at `HelloOk.policy.tickIntervalMs` (no client ping required). Graceful shutdown: `event:"shutdown"`.
   - Reconnects re-run the connect handshake with `auth:{ deviceToken }` (skipping the bootstrap step). The Ed25519 keypair is per-device, kept in the secure store; the deviceToken is issued by the gateway at first connect.
   - **Action:** P10A wires the bridge to translate; P10B aligns `@openclaw/protocol`.

2. **`openclaw-desktop` repo ownership** `[desktop]` — **DISCUSSED in P10.0.**
   - Upstream has no "Electron supervisor" concept, but does ship native node clients at `apps/{ios,android,macos}/` (SwiftUI / Kotlin). The supervisor role is implicit: the daemon is supposed to be launched via `openclaw onboard --install-daemon` (`launchd` / `systemd --user` / Windows service) — see `openclaw-upstream.md` §1.1. There is no opening for a "supervise from another process" hook today.
   - The cleanest PR-back path for our Electron app would be (a) as a contributor-maintained sibling repo under the openclaw GitHub org, or (b) as a thin `extensions/macos-supervisor` extension that wraps `openclaw gateway` lifecycle hooks. Option (b) keeps Electron out of the upstream tree; option (a) is a separate community project.
   - Did not surface an upstream maintainer comment opposing or endorsing either; assume the conversation has to start fresh with a P10D pitch. For now: keep building `apps/desktop` in our monorepo, design it so it could become a sibling repo without major changes.
   - **Action:** ship the desktop as part of `openclaw-mobile` monorepo (no rename in v1), pitch the org-sibling repo path in P10D. Don't block on the answer.

3. **CopilotKit runtime placement** `[desktop]`
   - Does the OpenClaw gateway already speak the CopilotKit runtime protocol on some path (e.g. `/copilot/runtime`)?
   - If not, the desktop app embeds an adapter (in-process Node) and advertises `runtime_url` to mobile at pairing time. Decide before mobile M3 / desktop D5.

4. **CopilotKit React Native package names + versions** `[mobile]`
   - Pin the exact RN-capable packages before M3 (the names have shifted as the RN support has landed).

5. **Shared `@openclaw/protocol` package** `[both]`
   - Where does it live (separate repo vs. workspace package under `openclaw-desktop`)?
   - Decide before extracting from mobile M0's inline copy.

6. **Canvas surface schema** `[both]`
   - Spec (component types, props, update/patch format, event shape) needed before M4. If undocumented, propose a v1 schema covering: heading, text, button, form field, list — confirm with the OpenClaw maintainers.

7. **Voice transport** `[both]`
   - Frames-over-WS vs WebRTC. Since the host is an always-on Mac with strong WebRTC support, WebRTC is the leading candidate.

8. **Push notification credentials** `[desktop]`
   - APNs/FCM accounts: under what entity? The desktop app holds these to fan out pushes to paired mobile devices.

9. **Code-signing / notarization** `[desktop]`
   - Apple Developer account, Windows code-signing cert, Linux packaging. Affects whether we ship a real `.dmg` vs. an `npm install -g` story.

10. **Hermes-as-agent wiring** `[both]` — **CLARIFIED in P10.0.**
    - `hermes claw migrate` is **one-shot**: it's a Python migration script (`/tmp/upstream-hermes/optional-skills/migration/openclaw-migration/scripts/openclaw_to_hermes.py`) launched via `/tmp/upstream-hermes/hermes_cli/claw.py` that copies SOUL.md / agent files / config / optional secrets from `~/.openclaw/` into `~/.hermes/`. It does **not** wire Hermes as a live route inside OpenClaw.
    - Live integration goes through **ACP** (Zed's Agent Client Protocol). Hermes ships `acp_adapter/server.py` exposing an `acp.Agent` server (`/tmp/upstream-hermes/acp_adapter/server.py:441`); OpenClaw consumes ACP via `src/acp/client.ts` + the `extensions/acpx` extension. OpenClaw spawns Hermes as an **ACP child process** (line-delimited JSON-RPC over stdio).
    - Therefore `listAgents()` shows Hermes as **one entry** (the configured `AgentSummary` for the Hermes adapter), not many. Each call routed to that agent spawns/talks-to the ACP child.
    - **Action:** mobile treats Hermes as a normal `agents.list` entry. Desktop's "install Hermes" affordance (later) just needs to add Hermes to the OpenClaw agents config and supervise the ACP child if it's not auto-spawned. Tracked but out-of-scope for v1 mobile.

11. **Branding / naming** `[both]`
    - Display name, bundle id (e.g. `dev.openclaw.mobile`, `dev.openclaw.desktop`), icon, color tokens.

12. **Repo rename** `[root]`
    - Repo is named `openclaw-mobile` but now contains both `apps/mobile` and `apps/desktop`. Rename to `openclaw` (or similar) before public traffic, or keep for continuity? GitHub redirects, so renaming is cheap but external links should be updated.

13. **Package manager** `[root]`
    - P00 defaults to **pnpm** (best for monorepos with multiple frameworks). Confirm before P00 runs, or switch to npm/yarn workspaces if there's a reason.

14. **`@openclaw/` npm scope** `[root]`
    - We use `@openclaw/protocol`, `@openclaw/mobile`, `@openclaw/desktop` as workspace names. If we ever publish `@openclaw/protocol`, we need to claim the scope on npm. Defer until publish.

15. **Prettier scope vs. planning docs** `[root]`
    - P00 added `.chalk/` to `.prettierignore` so the per-task plan files (which are owned by the planning process and which sub-agents are told not to edit) don't fail `pnpm format:check`. If we later want Prettier to enforce style on the planning docs too, we'd need a separate "format-planning-docs" workflow or to relax the don't-edit rule for sub-agents. Revisit once the planning docs stabilize.

16. **`tsup` DTS + `composite: true` interaction** `[root]`
    - P01A wanted `packages/protocol/tsconfig.json` to set `composite: true`. With that flag set, `tsup`'s DTS step (via rollup-plugin-dts) reports TS6307 because its synthesized virtual project doesn't honor the `include` glob. We worked around it by adding a sibling `packages/protocol/tsconfig.build.json` (same options minus `composite`) and pointing `tsup.config.ts` at it. If we later add more workspace packages that all need composite + DTS, consider standardizing on this pattern (or switching the DTS step to `tsc -b` once we wire up project references). Revisit when P01B / per-package CI lands.

17. **Sub-agent verification baseline** `[process]`
    - Per-plan Verification sections list app-specific gates but sometimes omit repo-wide gates (notably `pnpm format:check`). Wave 2 surfaced this: P01A passed its plan's verification but failed CI's format gate after merge. Fixed by reformatting in a follow-up commit (`e8be21c`) and codifying the baseline in `.chalk/plans/README.md` — sub-agents now must run install / format:check / -r typecheck / -r lint / -r test regardless of per-plan Verification. Revisit if we add more gates (security audit, bundle-size budgets, etc.).

21. **Expo SDK version pin (mobile)** `[mobile]`
    - P02A pinned `expo@~54.0.33` because `pnpm create expo-app --template tabs` ships the tabs template aligned with SDK 54 (`expo-router@~6.0.23`, `react-native@0.81.5`, `react@19.1.0`), even though `expo@latest` on npm is 55.x. The template tail-lags the latest minor. We should plan a single SDK-bump PR before P03A starts adding feature surface area (or accept the lag and re-evaluate at M3). EAS / CI build configs in P09C should also pin the SDK explicitly.

22. **Production hardening of the desktop keystore fallback** `[desktop]`
    - P03B's plan calls for the Ed25519 signing key to live in macOS Keychain via `keytar`. On Linux without libsecret (notably this repo's dev container), `keytar` fails to load, so the keystore at `apps/desktop/src/main/pair/keystore.ts` falls back to an AES-256-GCM-encrypted file at `userData/keystore.enc`. The encryption key is derived (`scrypt`) from `/etc/machine-id` (or `os.hostname()+os.platform()` if absent) with a static salt — adequate for the dev loop but not a real defense against an attacker with disk access. Before v1 ships on Linux we need either: (a) a hard dep on libsecret + a clear install error if it's missing, (b) a Tauri-style OS-keyring wrapper that fails closed, or (c) an explicit user-supplied passphrase derived via PBKDF2. macOS + Windows users hit the keytar path and are unaffected. Revisit alongside the existing question about where the per-gateway signing keypair lives (A.9 territory).

23. **Protocol build must precede typecheck** `[root]` `[process]`
    - `apps/desktop`'s TS resolves `@openclaw/protocol` via the package's `types` field (`dist/index.d.ts`), which only exists after `pnpm --filter @openclaw/protocol build`. `apps/mobile` uses tsconfig paths pointing at `src`, so it's immune. Surfaced by P03A (Wave 4). Fixed for CI by moving the protocol build step to before typecheck in `.github/workflows/ci.yml`. **Local dev** still trips up when running `pnpm -r typecheck` on a fresh clone — document the build-first ordering in the root README, or unify on a `types: src` strategy across workspaces (cleaner, but breaks once we publish protocol). Decide before P05C.

24. **Live `lan_enabled` toggle on desktop** `[desktop]`
    - P04B introduced `userData/settings.json` with `lan_enabled` (default `true`). The renderer Settings page renders the value read-only and the bind address is decided once at app start. Toggling at runtime would require closing the fastify listener, rebinding to the new host, and starting/stopping Bonjour in lockstep — fiddly because we'd also need to invalidate the runtime URL stored on already-paired devices. For v1 we accept "edit JSON + restart" as the workflow. Revisit when we have a packaged build whose users won't tolerate manual JSON edits.

25. **Committed native projects from `expo prebuild`** `[mobile]` `[process]`
    - P04A's adoption of `react-native-zeroconf` moves the mobile app off Expo Go to a custom dev client; the plan required running `npx expo prebuild` and committing the generated `apps/mobile/ios/` and `apps/mobile/android/` trees so EAS / CI can build without re-running prebuild. We checked in 55 native files (CocoaPods / Gradle stubs, Info.plist, AndroidManifest.xml, etc.) and removed `/ios` + `/android` from `apps/mobile/.gitignore`. Going forward, every change that affects native config (`app.config.ts`, a new Expo plugin, a new native dep) must be paired with a fresh `expo prebuild --clean` so the committed copies stay in sync. Decide before P09C wires EAS: do we (a) keep committing native projects long-term (current path), (b) regenerate them at build time in CI and `.gitignore` again, or (c) move to a `npx expo run:android/ios` workflow where prebuild happens lazily on the dev's box. Re-evaluate once EAS lands and we see how often the native copies churn.

26. **Mobile WS protocol stubs await P05/P06** `[mobile]` `[desktop]`
    - P04A's `RealGateway` implements the HTTP pairing surface end-to-end but leaves `listAgents` / `listThreads` / `postMessage` / `streamThread` as TODO stubs (return `[]` / throw a typed "pending" error). P04B's WS server + stub gateway now expose `agents.list`, `threads.post`, and a streamed reply, so the next step is to wire `RealGateway` to send/await frames using `@openclaw/protocol`'s envelope codec. Land that as part of P05A so the chat surface has real data. The WS close-code range `4001-4099` is reserved for `token_expired` per `RealGateway`'s `onClose` handler — confirm with P04B's WS implementation before promising that behavior.

27. **CopilotKit tool-call results need an inbound translation path** `[desktop]` `[mobile]`
    - P05C wired one direction of tool calls: gateway `tool_call` ThreadEvents → AG-UI `TOOL_CALL_START`/`_ARGS`/`_END` events on the SSE stream. The reverse — when CopilotKit declares client-side "actions" and the front-end posts back a `tool`-role message in the *next* run's `RunAgentInput.messages` — is **not yet handled** by `apps/desktop/src/main/copilot/adapter.ts` (see the `TODO(tool-results)` comment). The adapter today only forwards the most-recent user message; tool results posted in the assistant→tool round-trip get silently dropped. Concretely, we need to: (a) detect `tool`-role messages in the inbound `RunAgentInput`, (b) emit a new gateway envelope (proposed: `threads.toolResult` with `{ threadId, toolCallId, content }`) instead of (or alongside) the user `threads.post`, (c) have the gateway side ack and feed the result back into the agent loop. Spec the envelope shape with the OpenClaw maintainers before P05A starts using CopilotKit actions for any non-cosmetic UI affordance — until then mobile's actions can only be informational (the adapter will swallow their results). Pinned package: `@copilotkit/runtime@1.57.1`, AG-UI core `@ag-ui/core@0.0.53` — those define the `tool` message + `toolCallId` field shapes.

28. **Loopback-only enforcement for the self-token** `[desktop]`
    - P05B mints a bearer token for `device_id: "self"` and exposes it to the renderer via IPC (`system:get-self-token`). The token is signed by the same Ed25519 key that signs phone tokens, so any client that presents it passes `verifyToken(...)` regardless of where the request originated. Today the WS server (`apps/desktop/src/main/transport/wsServer.ts`) and the runtime endpoint (`apps/desktop/src/main/copilot/runtime.ts`) both bind to `0.0.0.0:18789` when `settings.lan_enabled === true` (P04B), which means a guessed/leaked self-token would also be accepted from the LAN. The renderer mitigates the risk by only ever using `ws://127.0.0.1:18789/ws` + `http://127.0.0.1:18789/copilot/runtime`, but the *server* doesn't currently reject self-token claims from non-loopback peers. Production hardening options: (a) at token-verify time, refuse `device_id: "self"` unless the request originated from `127.0.0.1` / `::1`; (b) split the fastify server in two — loopback-only for `/copilot/runtime` and the local-WS endpoints, LAN-exposed for `/pair/*` + `/healthz`; (c) bind the self-token to a per-boot nonce that's invalidated on restart so leaks have a short half-life. Pick before v1 ships on Linux/macOS hosts that share a LAN with untrusted peers. Tracked separately from open question 22 (which covers the keystore fallback's confidentiality, not authn scoping).

29. **Mobile CopilotKit RN package decision: hand-roll over `@copilotkit/react-native`** `[mobile]`
    - P05A evaluated `@copilotkit/react-native@1.57.1` (it exists at the same version as `@copilotkit/runtime` and re-exports `@copilotkit/react-core/v2/{context,headless}`). The RN package itself is well-shaped — it ships polyfills, exposes a `CopilotKitProvider` that wraps `CopilotKitCoreReact` with no DOM deps, and the `v2/*` subpaths only depend on `react`, `@copilotkit/core`, `@copilotkit/shared`, `@ag-ui/client`, and `tailwind-merge`. The blockers we chose to dodge anyway:
        - The v2 hook surface is `useFrontendTool` / `useAgentContext` / `useAgent`, **not** v1's `useCopilotAction` / `useCopilotReadable` that the plan references. We'd be writing a thin v1-style wrapper either way.
        - `@copilotkit/react-core@1.57.1` (which is a transitive dep) declares Radix, lucide-react, react-markdown, KaTeX, Lit, `@jetbrains/websandbox`, and `@radix-ui/*` as **direct** `dependencies` (not `peerDependencies`), so they install whether or not we touch the v2 subpaths from RN. That's ~100MB of node_modules and a noisy Metro resolver pass.
        - The runtime contract we hit is the desktop's hand-rolled `apps/desktop/src/main/copilot/runtime.ts` (P05C), so we already have a fully documented, pinned wire format.
      Mobile ships its own minimal client (`apps/mobile/src/copilot/{sse,runAgent,registry,CopilotKitProvider}.ts`) — pure RN primitives, no external CopilotKit deps. v1-style `useCopilotAction` / `useCopilotReadable` hooks live there; the chat surface (`apps/mobile/app/(tabs)/threads/[id].tsx`) renders a FlatList + composer that consumes the AG-UI SSE stream directly via `runAgent()`. Revisit if the v2 hook API stabilises and the plan picks up `useFrontendTool` semantics — or if CopilotKit splits the DOM-heavy deps out of `react-core@latest`. Until then the bundle savings + name parity with the plan win.
      Related: open question #26 marked `RealGateway`'s WS topics as "P05A wires these in"; P05A did so — `listAgents` / `setActiveAgent` / `listThreads` / `postMessage` / `streamThread` are now real WS calls against the desktop's `agents.*` / `threads.*` topics. `listThreads` still resolves `[]` when the desktop hasn't published a `threads.list` topic (the stub gateway hasn't), so the threads list page falls back to a single `Default thread` entry until the desktop grows that topic.

30. **Desktop stub gateway needs `canvas.get` / `canvas.patch` / `canvas.event` topics** `[desktop]` `[mobile]`
    - P06A wired the mobile-side renderer + `RealGateway` for Canvas surfaces, but the desktop's stub gateway (`apps/desktop/src/main/gateway/stub.ts`) only publishes the *initial* `canvas.surface` broadcast as a one-shot reply to `threads.post`. It does not yet handle:
        - `canvas.get { surfaceId }` — round-trip to fetch a surface by id (used by the mobile when a user deep-links to a surface that wasn't pushed via the live chat session). `RealGateway.getCanvas` falls back to its local snapshot cache first; if the cache misses it sends `canvas.get` and the request currently times out against the stub.
        - `canvas.patch { surfaceId, ts, ops }` broadcasts — the patch fan-out path on the mobile side (`RealGateway.onCanvasUpdate`) is ready, but the stub never emits a patch so the live-update story is untested end-to-end.
        - `canvas.event { surfaceId, nodeId, type, payload }` — mobile renderers POST these on user interaction; the stub doesn't subscribe to the topic so the events are silently dropped at the WS boundary. No agent loop is wired to consume them either.
      Concretely, the stub should: (a) keep an in-memory map of surfaces it has emitted, (b) handle `canvas.get` with `ctx.reply('canvas.get.response', { surface })`, (c) on `canvas.event` log + ack so the mobile sees a response, and ideally (d) emit a follow-up `canvas.patch` when the event would mutate the surface (e.g. set the heading text to `"Clicked!"`). Until that lands, the inline canvas surface renders correctly from the initial push but is interaction-dead — useful for visual review, not for real round-trips. Tracks alongside open question #26 (other deferred WS topics).

31. **Canvas frame routing vs `ThreadEvent` variant** `[protocol]`
    - P06B's plan prose described surfaces arriving as `ThreadEvent { type: "canvas", surfaceId }` inside the thread stream; the v1 schema (P06.0) doesn't have that variant. Both renderers (P06A mobile + P06B desktop) currently treat `canvas.*` WS frames as a sibling channel and synthesize a placeholder list entry with `surfaceId` for inline rendering. Decision needed before we grow more canvas surface kinds: (a) add `ThreadEvent` `{ type: "canvas", ... }` so canvas events live in the chat stream and ordering is naturally preserved, or (b) formalise the sibling channel (`canvas.*` frames carry their own correlation, with the renderer responsible for merging). Option (a) couples canvas to threads, but is closer to how the chat surface already thinks. Option (b) keeps canvas independent of chat context, useful if we add a "Canvas" tab. Revisit before any plan extends Canvas (e.g. user-driven `canvas.open`).

32. **Desktop voice topics + agent-side WebRTC peer** `[desktop]` `[mobile]`
    - P07A landed the mobile voice surface end-to-end (`voice.tsx` PTT screen, `usePushToTalk` FSM, `RealGateway.openVoice` / `sendVoiceSignal` / `onVoiceSignal` / `onVoiceTranscript`). P07B landed the desktop **router + peer + agent bridge** plus a stub gateway that emits a canned PCM16 sine wave + transcript when a voice offer arrives. End-to-end round-trip therefore works against the stub, but: (a) the stub agent is a sine-wave generator, not a real voice agent — replacing it requires the upstream OpenClaw routing story for voice (open question #1), (b) there's no `voice.close` topic yet, only connection-state-driven teardown, (c) transcripts only flow desktop → mobile on the stub's canned reply, never mobile → desktop while the user speaks (real STT is agent-side, not desktop-side). Codec pinned at **opus @ 16kHz mono** in `VoiceOpts`; both clients honour that constant.

33. **Voice frame on-the-wire serialization for binary PCM16 / Opus** `[desktop]` `[mobile]` `[protocol]`
    - P07.0's `VoiceFrame.data` is a `Uint8Array`, but the standard envelope path is JSON over WS (`encode`/`decode`), which would silently lose typed-array buffers (`JSON.stringify(new Uint8Array([1,2,3])) === '{"0":1,"1":2,"2":3}'`). P07B's desktop voice path side-steps the problem by (a) running the WebRTC peer in-process (no JSON serialization between phone and agent for audio — bytes travel over RTP, not the envelope), and (b) defining a JSON-friendly `VoiceFrameWire` shape (`{ seq, format, sampleRate, channelCount, numberOfFrames, samples: number[] }`) for the in-process publish/subscribe between the agent bridge and the canned-reply stub. That works for v1 because the only frames that hit the router are PCM16-as-numeric-array, but it blocks two real scenarios: (i) the WS-frames fallback path (P07.0's stated v1 fallback when WebRTC fails) — the phone needs to send Opus packets and we either base64-encode them inside the JSON envelope or upgrade the WS transport to binary frames keyed by topic; (ii) a future real agent process that reads voice frames over the gateway boundary — same call. Pick before the WS-frames fallback ships: (a) add a `VoiceFrameWire`-style discriminated payload to `@openclaw/protocol` (numeric-array samples for PCM16, base64 for Opus), (b) extend the WS transport to send binary frames with a JSON header (more efficient but doubles the envelope codec surface), or (c) carve out a side-channel REST/Multipart upload for audio. Until then `VoiceFrame.data: Uint8Array` is reserved-but-unused on the wire; the in-process pipeline uses `VoiceFrameWire`. Tracks alongside open question #26 (other deferred WS topics).

34. **Mobile-side device-id derivation from the pairing token claim** `[mobile]` `[desktop]`
    - P08A needs to send the registered device's `device_id` to the desktop at `POST /devices/<id>/push-token`, but the mobile side never receives that id explicitly — the desktop generates a fresh UUID in `apps/desktop/src/main/pair/server.ts`'s pairing `approve` step and bakes it into the JWT-like token claim alongside `device_name` / `gateway_id` / `exp`. Today P08A decodes the claim segment on-device (`apps/mobile/src/push/register.ts`'s `decodeDeviceIdFromToken`) and trusts the result without verifying the Ed25519 signature, on the reasoning that (a) we trust the token because it was just handed to us over the same LAN socket that completed the pairing handshake, and (b) the desktop re-validates the bearer on receipt via `verifyToken`. That's fine for the push-registration path, but it's awkward as a general pattern — every new mobile feature that needs `device_id` will reach for the same decoder. Decision before more endpoints key on `device_id`: (a) extend the pairing approval response to include `device_id` as a top-level field on `PairingApproved`, persist it alongside `runtimeUrl` / `httpBase` in the secure session record, and drop the on-device claim decoder, (b) keep the decoder but move it into `@openclaw/protocol` so both apps share the wire shape, or (c) introduce a `GET /me` endpoint that returns `{ device_id }` from a verified bearer. Option (a) is the cleanest but requires a desktop change (touch `server.ts`'s `approve` handler + the `PairingApproved` schema). Revisit before P08B lands receipts or anything else hangs more endpoints off `/devices/:id/*`.

35. **Notification trigger contract — `task_finished` + agent-originated voice offers** `[desktop]` `[mobile]` `[protocol]`
    - P08B's dispatcher needs two outbound frame shapes that don't yet exist as first-class protocol concepts: (a) a "long task finished" event distinct from `ThreadEvent.done`, and (b) an agent-originated voice offer distinct from a phone-initiated PTT offer. For v1 we approximated both: `ThreadEvent.done` doubles as the "task finished" trigger (the dispatcher gates it through the same per-thread throttle, so a typical `message` → `done` sequence collapses to a single push), and voice-offer signals are filtered on `payload.from === 'agent'` (a contract that does not exist anywhere in `@openclaw/protocol` today — no agent actually sets it). The stub gateway never trips the voice path because it only echoes phone offers, so the agent-originated branch is effectively dead code until a real agent + the protocol bits land. Decide before pre-release: (a) add a `tasks.finished` topic (or a `ThreadEvent` `{ type: "task_finished", taskId }` variant) so the dispatcher has a real signal to subscribe to, and (b) extend `VoiceSignal` with a `from: "agent" | "user"` discriminator in `@openclaw/protocol/voice/types.ts` so the dispatcher's filter is contract-backed instead of guessing. Until then the only push that actually fires in production is "assistant message", which is the path mobile P08A will exercise first anyway.

36. **Canvas: tree-of-nodes vs HTML/WebView** `[mobile]` `[desktop]` `[protocol]` — surfaced by P10.0.
    - Upstream Canvas (`extensions/canvas/src/host/a2ui-shared.ts`, `skills/canvas/SKILL.md`) is **a WebView surface**: the gateway serves arbitrary HTML/CSS/JS from `canvasHost.root` over a port (default 18793, `/__openclaw__/canvas/<file>.html?oc_cap=<token>`), nodes load it in a WebView, and the page posts user-actions back through an injected JS bridge (`window.OpenClaw.sendUserAction({...})`). "Live updates" are coarse: a `"reload"` string broadcast on `/__openclaw__/ws` triggers a full re-fetch. The action message shape is **A2UI** (Google's Agent-to-UI protocol).
    - We invented `CanvasSurface` (a tree of `Stack`/`Heading`/`Text`/`Button`/`TextInput`/`Select`/`List` nodes) + `CanvasPatch` ops (`AddNode`/`RemoveNode`/`ReplaceProps`/`SetText`) + a typed `CanvasEvent`. None of that exists upstream.
    - Two paths for v1: (a) **adopt upstream:** mobile renders a WebView and intercepts the A2UI bridge messages; our schema-driven renderer becomes desktop-only or is retired. (b) **stay schema-driven:** the desktop bridge translates upstream's WebView Canvas into our node tree (effectively a tiny HTML→tree compiler) so the existing mobile renderer keeps working; agents that emit raw HTML can't be rendered on mobile without a fallback. Option (a) is honest about upstream reality but throws away the accessibility / non-WebView story our renderer enables; option (b) keeps mobile parity with desktop but is a perpetual translation burden. Floated as PR-back #1 (`openclaw-upstream.md` §13) to land both upstream so each consumer picks.
    - **Action:** decide before P10A wraps. Either way, P10A's bridge wires `canvas.*` topics to upstream's WebView surface — translation choice is local to the desktop. P10B's protocol refresh either keeps our tree or replaces it with a WebView descriptor (`{ url, cap, refreshTopic }`). Resolves delta E1/E2/E3/E4.

37. **Node-as-device callback surface** `[mobile]` `[desktop]` `[protocol]` — surfaced by P10.0.
    - Upstream treats the mobile app as a **"node"** — once paired, the gateway can ask the device to run commands. Specifically: `event:"node.invoke.request"` with `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }` (`/tmp/upstream-openclaw/src/gateway/protocol/schema/nodes.ts:197–207`), to which the device must reply via `req method:"node.invoke.result" { id, nodeId, ok, payload? | payloadJSON?, error? }` (`nodes.ts:118–136`). Plus unsolicited `req method:"node.event"` (`nodes.ts:138–145`) for telemetry, and `node.pending.{drain,pull,ack,enqueue}` for "things to do while backgrounded" (work types: `status.request` / `location.request`).
    - Our `GatewayClient` interface (`packages/protocol/src/client.ts:53–116`) only models "I am a client that sends requests and consumes events" — it has **no surface for handling inbound invocations** from the gateway. Mobile can't currently respond to "take a screenshot", "send my current location", "open this canvas URL".
    - **Action (P10B):** add a `handleNodeInvoke(command, handler)` registration + a `sendNodeEvent(event, payload)` outbound method to `GatewayClient`. Bridge implementation translates `event:"node.invoke.request"` → handler dispatch → `node.invoke.result` reply. v1 mobile handlers: at minimum a no-op acknowledger so the gateway doesn't time out; full implementation of `status.request` / `location.request` is post-v1. Without this, paired mobile devices are read-only consumers, which upstream did not design around.

38. **Adopt `HelloOk.features` capability discovery** `[mobile]` `[desktop]` `[protocol]` — surfaced by P10.0.
    - Upstream's `HelloOk` reply to the connect RPC includes `features: { methods: string[], events: string[] }` (`/tmp/upstream-openclaw/src/gateway/protocol/schema/frames.ts:84–90`), letting the client gate UI on what the gateway actually supports (e.g. a gateway without the `extensions/canvas` extension wouldn't advertise canvas methods).
    - Today our apps gate UI on hard-coded assumptions. Once the bridge connects to a real gateway, UI affordances should appear/disappear based on `features`.
    - **Action:** defer until needed. Bridge stores `features` after connect; expose via `GatewayClient.capabilities()` (or similar) in P10B if/when a UI element needs to gate on it. Not a v1 blocker.

39. **`setActiveAgent` doesn't map to anything upstream** `[mobile]` `[desktop]` `[protocol]` — surfaced by P10.0.
    - Our `GatewayClient.setActiveAgent(agentId)` (`packages/protocol/src/client.ts:84`) assumes a per-device "default agent" routing. Upstream has no such concept: each session belongs to one agent (sessions are keyed by agent + scope, see `src/agents/agent-scope.ts`), so the "active agent" choice happens at thread-creation time, not at device level.
    - **Action (P10B):** remove `setActiveAgent` from `GatewayClient`. Mobile picks an agent when it opens a new thread; the agent id is baked into the `sessionKey`. Existing UI (the Agents tab) becomes a list view, not a "switch active" affordance. Threads already display per-agent. Touches `apps/mobile/app/(tabs)/agents.tsx` (currently triggers `setActiveAgent`) — re-scope it to "pick agent for next thread".

40. **Pairing UX — keep our 6-digit code or adopt upstream's QR/setup-link?** `[mobile]` `[desktop]` — surfaced by P10.0.
    - Upstream pairing is "bootstrap token + setup URL handed out-of-band" (`/tmp/upstream-openclaw/src/pairing/setup-code.ts:380–407`). The DM channels (Telegram, Discord, etc.) render a QR via `extensions/device-pair/qr-image.ts` carrying the bootstrap token. There is no symmetric "show 6 digits on phone, type into desktop" flow.
    - Our v1 UX (`apps/mobile/app/(pairing)/code.tsx` + `apps/desktop/src/main/pair/server.ts`) is a TOTP-style 6-digit code matched in the desktop UI. It's a better UX for the LAN-discovery scenario (you literally see the desktop next to the phone).
    - **Action:** keep our 6-digit flow as the **desktop-driven** path. The bridge generates a bootstrap token on the desktop side when the user clicks "Approve", then hands the token to the WS connect machinery — mobile UX is unchanged. Pitch our 6-digit code idiom as PR-back #3 (`openclaw-upstream.md` §13) so other front-ends can adopt it via `extensions/device-pair`. Resolves delta B1.

41. **`unsupportedInRealMode` error surfacing in apps** `[mobile]` `[desktop]` — surfaced by P10A.
    - The real-gateway bridge (`apps/desktop/src/main/gateway/openclaw-bridge.ts`) returns a typed `{ ok:false, reason:"unsupportedInRealMode", feature, detail }` payload on `canvas.error` / `voice.error` / `agents.setActive.response` when chat-only mode is active. The mobile + desktop chat UIs don't currently observe those response types — they subscribe to `canvas.surface` / `voice.transcript` / `voice.frame.reply` directly, so the bridge's error envelope drops on the floor (visible in dev tools network panel, but invisible to the end user).
    - **Action:** decide whether to land a thin "feature unsupported" banner in mobile (`apps/mobile/src/...`) and the desktop renderer that subscribes to `canvas.error` / `voice.error` and surfaces a Snackbar/Toast. Out of scope for P10A (chat-only happy path). Tracked here so P10C's e2e plan picks it up before we cut a real-mode build for real users.

---

## B. Decisions we can make as we go

12. **Mobile state management** `[mobile]` — Default: Zustand for UI, React Query for server cache.
13. **Telemetry** `[both]` — Default: Sentry for crashes; defer product analytics until we have users.
14. **EAS vs bare** `[mobile]` — Stay on Expo managed unless a native module (e.g. WebRTC) forces config plugins or a custom dev client.
15. **Electron UI framework** `[desktop]` — Default: React + electron-vite, no native menus framework, since the menu bar + a single window cover v1.
16. **Desktop chat UI reuse** `[desktop]` — Default: separate, simpler desktop UI in v1; converge with mobile components later if it pays off.
17. **iPad / large-screen layout** `[mobile]` — stretch.
18. **Continuous voice + barge-in** `[both]` — stretch.
19. **Skill/agent editor on mobile** `[mobile]` — stretch (read-only first).
20. **Auto-update channel** `[desktop]` — Default: `electron-updater` with releases on GitHub.

---

## C. Assumptions still active (call out if wrong)

- The phone is always a **client** of a user-hosted gateway, fronted by the `openclaw-desktop` Electron app on the Mac mini. We do not embed OpenClaw or Hermes on-device.
- One gateway per user for v1 (multi-gateway is stretch).
- Pairing tokens behave like long-lived OAuth refresh tokens; the WS uses them as bearer credentials. Tokens are issued by the desktop app and verified by the gateway.
- The CopilotKit runtime concept (HTTP endpoint that streams chat + tool calls) can be exposed by either the gateway directly or an adapter the desktop app embeds; the mobile app does not need to know which.
- Hermes does not need to be talked to directly from the phone — it's reachable via OpenClaw routing only.
- The desktop app is the trust anchor: pairing approvals, token signing keys, and push credentials all live there. The mobile app trusts whatever the desktop app advertises at pairing time.

If any of those flip (especially the last two), `plan.md` §3 / §6 and
`desktop-app.md` need to shift before M3.
