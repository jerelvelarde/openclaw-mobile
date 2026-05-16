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

1. **OpenClaw WS / "device node" protocol** `[both]`
   - Exact pairing handshake (token issuance, refresh, revocation).
   - Wire format for messages (JSON-RPC? Custom envelope?).
   - Topic/subscription model for threads, agents, Canvas, voice.
   - Heartbeats / reconnect semantics.
   - We will read this from the OpenClaw source before starting M2 — or, if it's not finalized, propose the schema and PR it back upstream. The desktop app's protocol-side surface freezes the answer for mobile.

2. **`openclaw-desktop` repo ownership** `[desktop]`
   - Does OpenClaw upstream want the Electron supervisor contributed back, or is `openclaw-desktop` a separate community project?
   - Who creates and maintains the repo? Mobile development past M2 assumes it exists.

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

10. **Hermes-as-agent wiring** `[both]`
    - How exactly does Hermes register itself as an agent route inside OpenClaw? Is `hermes claw migrate` one-shot, or does Hermes run as a sibling daemon the gateway routes to? Affects whether `listAgents()` shows Hermes as one entry or many.

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
