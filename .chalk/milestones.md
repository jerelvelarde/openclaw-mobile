# Milestones

Phased delivery so each step ships something demoable. Sizes are rough
estimates assuming one engineer (per repo where two repos are involved).
The arc: skeleton → discover → talk → render → speak → polish.

The mobile app is designed to land cleanly against the
[`openclaw-desktop`](desktop-app.md) Electron companion on the Mac mini.
For mobile-only iteration we use an in-app mock gateway through M1; from
M2 onward we depend on either the real desktop app or a CLI stand-in.

---

## Track A — mobile (this repo)

### M0 — Repo skeleton (½ day)

- `npx create-expo-app` with TypeScript template, Expo Router.
- ESLint + Prettier + tsconfig strict.
- GitHub Actions: install, typecheck, lint, test on PR.
- `src/openclaw/gateway.ts` interface + in-memory mock gateway (returns a fake "Hermes" + a fake "openclaw.default" agent).
- Theme + design tokens stub.

**Demo:** empty tab app boots on iOS sim, Android emu, and web.

### M1 — Pairing flow against the mock gateway (1 day)

- `(pairing)/welcome → discover → code` screens.
- Mock gateway issues a 6-digit code; "approve" button on a dev-only screen flips it to paired.
- Pairing token persisted in `expo-secure-store`; subsequent launches skip pairing if token validates.
- Diagnostics screen: gateway URL, connection state, last error.

**Demo:** run through pairing on iOS/Android/Web against the in-app mock.

### M2 — Bonjour discovery + real WebSocket transport (1–2 days)

- Implement `_openclaw._tcp.local.` browse via `react-native-zeroconf` (or web equivalent).
- `discover.tsx` shows discovered hosts (`Jerel's Mac mini` etc.); paste-URL fallback.
- `GatewayClient.connect(token)` against the real desktop / gateway WS.
- Reconnect with exponential backoff + "Can't reach your Mac mini" banner.

**Demo:** open app on phone, find Mac mini on Wi-Fi automatically, pair via desktop approval, stay connected.

**Blocker:** `openclaw-desktop` (or a stand-in) advertising Bonjour and answering `/pair/request` per `desktop-app.md` §3.

### M3 — CopilotKit chat against the active agent (2 days)

- Install CopilotKit RN packages; wrap app in `<CopilotKit>` with `runtimeUrl` advertised by the desktop at pairing time.
- `threads/[id].tsx` renders `CopilotChat`, scoped to the active agent.
- Streaming token rendering; tool-call inspector below the message.
- Register client actions: `switchAgent`, `openThread`.

**Demo:** send a message to Hermes (or an OpenClaw skill) from the phone, see the streamed reply.

### M4 — Canvas surface renderer (2 days)

- Define the minimal Canvas schema we support in v1 (text, button, form field, list).
- `<CanvasRenderer/>` component, inline in chat and via `openCanvas({ surfaceId })`.
- Patch/update protocol over WS.

**Demo:** an agent emits a Canvas form, the user fills it in on the phone, gateway receives the values.

### M5 — Voice (push-to-talk) (2–3 days)

- `voice.tsx`: full-screen voice session, mic capture via `expo-av`, opus encode.
- Transport frames over WS (or WebRTC peer to the Mac mini if needed).
- Live transcript, agent reply playback, interruption.
- iOS/Android background audio entitlements; web uses MediaRecorder.

**Demo:** hold-to-talk, agent replies in voice, transcript shown.

### M6 — Push (driven by the always-on Mac) (1 day)

- Expo Notifications setup; register device token via the pairing handshake (the desktop stores it).
- Triggers (sent by desktop, since it's always on): agent message while app backgrounded, agent requests voice, long-running task finished.
- Notification deep-links to the right thread/voice session.

**Demo:** phone buzzes when the agent finishes; tapping opens the thread.

### M7 — Polish & v1 cut (1–2 days)

- Dark mode, accessibility (Dynamic Type, screen reader labels).
- Empty/error illustrations, "Mac mini unreachable" recovery (suggest LAN/Tailscale).
- Sentry crash reporting + privacy-minded event log.
- EAS build profiles: dev, preview (TestFlight + Play internal), production.
- Web deploy.

**Demo:** TestFlight link, Play internal track, web URL — all from one branch.

---

## Track B — desktop (sibling repo, `openclaw-desktop`)

Sequenced to unblock the mobile milestones. Owned by whoever spins up that
repo, but the mobile design depends on these landing in roughly this order.

### D0 — Electron skeleton + menu bar (1 day)
electron-vite + TS; macOS menu-bar icon; "About / Quit" baseline.

### D1 — Gateway supervision (1 day)
Start/stop `openclaw gateway` as a child process (or via launchd); health UI in the menu bar.

### D2 — Bonjour advertisement + pairing service (1–2 days)
Register `_openclaw._tcp.local.`; expose `POST /pair/request` and `GET /pair/status`; native notification + modal to approve. **Unblocks mobile M2.**

### D3 — Token issuance + WS auth (1 day)
Per-gateway keypair in macOS Keychain; signed tokens; gateway rejects unsigned WS connects. **Hardens mobile M2.**

### D4 — Desktop chat surface (2–3 days)
Minimal desktop chat UI talking to the same gateway. Verifies the protocol is symmetric across desktop and mobile clients.

### D5 — CopilotKit runtime adapter (1–2 days)
Either confirm the gateway exposes the runtime natively or bundle the adapter in-process. **Unblocks mobile M3.**

### D6 — Push fan-out (1 day)
APNs/FCM credentials in desktop; sends pushes to registered mobile tokens. **Unblocks mobile M6.**

### D7 — Notarization + auto-update (1 day)
Code-sign + notarize the `.dmg`; wire `electron-updater`.

---

## Shared — `@openclaw/protocol` package

Lives in its own small repo (or as a workspace package under `openclaw-desktop`). Owns WS message types, Zod validators, the `GatewayClient` interface, and token helpers. Both repos depend on it.

- **S0** — Extract `GatewayClient` from mobile M0 into the package once the desktop repo exists. (Mobile temporarily inlines a copy; we hoist it on first sync.)
- **S1** — Add Zod schemas; both repos validate at the WS boundary.
- **S2** — Cut a versioned release; both repos pin and upgrade in lockstep.

---

## Stretch (post-v1)

- Multiple gateways (switch between home Mac mini and a server).
- Continuous voice with on-device VAD + barge-in.
- Manage skills/agents from the phone (read-only first, then write).
- iPad / large-screen split view (threads ↔ active thread).
- "Forward to channel" — push a reply out to Telegram/Slack from the phone.
- Hermes-specific affordances if/when its API exposes more than what OpenClaw routing surfaces.
- Cross-Mac roaming: same Apple-ID-linked install on a laptop, gracefully hand off when both are online.
