# Milestones

Phased delivery so each step ships something demoable. Sizes are rough
estimates assuming one engineer. The arc: get connected → talk → render →
speak → polish.

---

## M0 — Repo skeleton (½ day)

- `npx create-expo-app` with TypeScript template, Expo Router.
- ESLint + Prettier + tsconfig strict.
- GitHub Actions: install, typecheck, lint, test on PR.
- `src/openclaw/gateway.ts` interface + in-memory mock gateway (returns a fake "Hermes" + a fake "openclaw.default" agent).
- Theme + design tokens stub.

**Demo:** empty tab app boots on iOS sim, Android emu, and web.

---

## M1 — Pairing flow against the mock gateway (1 day)

- `(pairing)/welcome → connect → code` screens.
- Mock gateway issues a 6-digit code; "approve" button on a dev-only screen flips it to paired.
- Pairing token persisted in `expo-secure-store`; subsequent launches skip pairing if token validates.
- Diagnostics screen: show gateway URL, connection state, last error.

**Demo:** run through pairing on iOS/Android/Web against the in-app mock.

---

## M2 — Real WebSocket transport + agent list (1–2 days)

- Implement `GatewayClient.connect(token)` against the real OpenClaw gateway WS (port 18789).
- `listAgents()` → `agents.tsx` lists the user's installed agents (OpenClaw skills + Hermes if present).
- LAN-first connection logic with manual override (paste `ws(s)://…`).
- Reconnect with exponential backoff + "disconnected" banner.

**Demo:** pair to a real `openclaw gateway` on a laptop, see the actual agent list on the phone.

**Blocker before starting:** OpenClaw's WS pairing/auth/message schema (see `open-questions.md` §A).

---

## M3 — CopilotKit chat against the active agent (2 days)

- Install CopilotKit RN packages; wrap app in `<CopilotKit>` with `runtimeUrl` pointing at the user's gateway (or our adapter — see `compatibility.md`).
- `threads/[id].tsx` renders `CopilotChat`, scoped to the active agent.
- Streaming token rendering; tool-call inspector below the message.
- Register client actions: `switchAgent`, `openThread`.

**Demo:** send a message to Hermes (or an OpenClaw skill) from the phone, see the streamed reply.

---

## M4 — Canvas surface renderer (2 days)

- Define the minimal Canvas schema we support in v1 (text + buttons + form + list — exact shape TBD with OpenClaw).
- `<CanvasRenderer/>` component, embedded inline in chat and via `openCanvas({ surfaceId })`.
- Patch/update protocol over WS.

**Demo:** an agent emits a Canvas form, the user fills it in on the phone, gateway receives the values.

---

## M5 — Voice (push-to-talk) (2–3 days)

- `voice.tsx`: full-screen voice session, mic capture via `expo-av`, opus encode.
- Transport frames over WS (or WebRTC if OpenClaw expects that — TBD).
- Live transcript, agent reply playback, interruption.
- iOS/Android background audio entitlements; web uses MediaRecorder.

**Demo:** hold-to-talk, agent replies in voice, transcript shown.

---

## M6 — Push notifications + background wake (1 day)

- Expo Notifications; register device token with the gateway.
- Triggers: agent message while app backgrounded, agent requests voice, long-running task finished.
- Notification deep-links to the right thread/voice session.

**Demo:** phone buzzes when the agent finishes; tapping opens the thread.

---

## M7 — Polish & v1 cut (1–2 days)

- Dark mode, accessibility (Dynamic Type, screen reader labels).
- Empty/error illustrations, offline mode, "gateway unreachable" recovery.
- Sentry crash reporting + privacy-minded event log.
- EAS build profiles: dev, preview (TestFlight + Play internal), production.
- Web deploy.

**Demo:** TestFlight link, Play internal track, web URL — all from one branch.

---

## Stretch (post-v1)

- Multiple gateways (switch between home laptop and a server).
- Continuous voice mode with on-device VAD + barge-in.
- Discover gateways via mDNS / Bonjour on LAN.
- Manage skills/agents from the phone (read-only first, then write).
- iPad / large-screen split view (threads ↔ active thread).
- Live forwarding: reply-to-channel (forward a message into Telegram/Slack from the phone).
- Hermes-specific affordances if/when its API exposes more than what OpenClaw routing surfaces.
