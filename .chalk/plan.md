# openclaw-mobile — Plan

A mobile **device node** for [OpenClaw](https://github.com/openclaw/openclaw),
the local-first personal-AI gateway that runs as a daemon on your own machine.

The v1 design assumes a single, concrete host shape: an **always-on Mac mini
(or equivalent) sitting at home**, running `openclaw gateway` 24/7. The phone
finds it on the LAN via Bonjour, pairs once, and reconnects from anywhere
(cellular, Tailscale, work Wi-Fi) using the same token. See `host-target.md`
for the full host profile and what we ask the user to set up once.

This app pairs to that gateway over WebSocket and becomes another surface for
your agents — chat, Canvas, voice — alongside the messaging channels OpenClaw
already speaks (WhatsApp, Telegram, Slack, Discord, Signal, iMessage, …).

The agents themselves are pluggable. We're explicitly compatible with:

- **OpenClaw**'s built-in skills/agents (workspace at `~/.openclaw/workspace`, skills as `AGENTS.md` / `SOUL.md` / `TOOLS.md`).
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** from Nous Research, which interoperates with OpenClaw (`hermes claw migrate`) and is model-agnostic across Nous Portal, OpenRouter, NovitaAI, NVIDIA NIM, Hugging Face, OpenAI, etc.

Built with **Expo (React Native + Web)** and **CopilotKit's React Native
runtime** for the chat surface. See `host-target.md` for host assumptions,
`compatibility.md` for the harness/agent matrix, and `milestones.md` for
delivery.

---

## 1. Goals

1. **Pair & connect** — securely pair the phone to a user-hosted OpenClaw gateway via DM pairing code (the same flow OpenClaw uses for unknown messaging senders).
2. **Chat** — talk to whichever agent is routed for this device (OpenClaw skills, Hermes, or any other), powered by CopilotKit (`useCopilotChat`, `useCopilotAction`).
3. **Canvas** — render OpenClaw's "Canvas surfaces" (rich, agent-driven UI fragments) on mobile.
4. **Voice** — push-to-talk and continuous voice modes that route through the gateway to the active agent.
5. **One codebase, three surfaces** — iOS, Android, Web via Expo Router.

### Non-goals (v1)

- Running OpenClaw or Hermes **on the phone**. Both expect Node 22+/Python 3.11+ and a real OS (macOS/Linux/Windows/WSL2; Termux for Hermes is out of scope here). The phone is a remote surface, not a host.
- Coding-IDE features: this is not a Claude Dispatch clone. We do not have a "PR review" flow unless an agent surfaces one via Canvas.
- Provisioning agents from the phone (install Hermes, edit skills, etc.). v1 assumes the user set up their gateway on a laptop.
- Org/multi-tenant admin. Single-user, possibly multiple gateways.

---

## 2. Assumptions (confirmed)

- **Purpose:** chat + (eventually) Canvas + voice, against a user-hosted OpenClaw gateway.
- **Platforms:** Expo managed workflow → iOS, Android, Web.
- **Harness:** OpenClaw gateway (`openclaw gateway --port 18789`).
- **Agents:** at least the built-in OpenClaw skill agents and Hermes via OpenClaw's multi-agent routing.

---

## 3. How the pieces fit

We mirror the **Claude desktop + Claude mobile** pattern: a desktop companion
runs on the always-on Mac mini and is the primary surface for the user when
they're at their desk; the mobile app is the same persona, reachable
anywhere. Both speak to the same OpenClaw gateway. This means **two apps**
plus the upstream gateway:

- **`openclaw-mobile`** (this repo) — Expo / React Native phone + web client.
- **`openclaw-desktop`** (sibling repo, to be created) — Electron menu-bar app that wraps and supervises the OpenClaw gateway daemon on the Mac mini, exposes a desktop chat UI, and is the "trust anchor" for device pairing.
- **`openclaw`** (upstream) — the gateway daemon + skills/agents.

```
┌────────────────────────┐                ┌────────────────────────────────────────┐
│  openclaw-mobile       │                │  Mac mini (always-on)                  │
│  (Expo: iOS/Android/Web)│               │                                        │
│  - Pairing UI          │  ── WSS ──►   │  ┌──────────────────────────────────┐  │
│  - CopilotKit chat     │  (Bonjour /    │  │  openclaw-desktop (Electron)     │  │
│  - Canvas renderer     │   Tailscale)   │  │  - Menu bar / tray icon          │  │
│  - Voice (PTT)         │                │  │  - Pairing approvals             │  │
└────────────────────────┘                │  │  - Desktop chat + Canvas         │  │
                                          │  │  - Settings / agents / logs      │  │
                                          │  │  - Supervises gateway daemon     │  │
                                          │  └──────────┬───────────────────────┘  │
                                          │             │ local IPC                │
                                          │             ▼                          │
                                          │  openclaw gateway :18789 (launchd)     │
                                          │   ├─ workspace ~/.openclaw/workspace   │
                                          │   ├─ skills (AGENTS.md/SOUL.md/...)    │
                                          │   ├─ multi-agent router                │
                                          │   └─ channels (WA, TG, Slack, …)       │
                                          │                                        │
                                          │  Agent process(es):                    │
                                          │   • OpenClaw built-in skill agents     │
                                          │   • hermes-agent (Nous Research)       │
                                          │     + any LLM provider it's wired to   │
                                          └────────────────────────────────────────┘
```

See `desktop-app.md` for the Electron app's responsibilities and its
contract with this mobile app.

### Reachability

Because the host is always-on and on the user's LAN, we get a concrete
3-tier transport story (in order of preference):

1. **Local LAN via Bonjour.** Both apps register/discover `_openclaw._tcp.local.`; on the same Wi-Fi the phone finds the Mac mini automatically.
2. **Tailscale (recommended for remote).** Phone uses the Mac mini's MagicDNS name. The Electron app helps the user enable this during onboarding.
3. **Manual URL.** Paste a `ws(s)://…` for Cloudflare Tunnel, ngrok, or custom proxies.

Transports are interchangeable: the pairing token is device-bound, not
network-bound. Pair once on LAN, then reconnect from anywhere.

---

## 4. Tech stack

| Layer            | Choice                                              | Why                                                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| App framework    | Expo SDK (latest) + Expo Router                     | iOS + Android + Web from one tree, file-based routing               |
| Language         | TypeScript (strict)                                 | Shared types across UI, copilot actions, gateway client             |
| AI / chat        | CopilotKit (React Native packages)                  | First-class chat UI, tool/action registration, streaming            |
| Gateway client   | Custom WS client → OpenClaw gateway (`:18789`)      | Matches OpenClaw's documented "WS node" pairing                     |
| State            | Zustand + React Query                               | UI state + cached threads/skills/agents                             |
| Realtime         | WebSocket primary; SSE fallback                     | Live message + voice transport multiplex                            |
| Auth / pairing   | OpenClaw DM-style pairing code (entered in-app)     | Mirrors `openclaw pairing approve <channel> <code>`                 |
| Storage          | expo-secure-store (pairing token) + AsyncStorage    | Pairing token treated like an OAuth refresh token                   |
| Voice (capture)  | expo-av + on-device VAD                             | Push-to-talk first; continuous mode behind a flag                   |
| Voice (transport)| Opus frames over the same WS, or WebRTC if needed   | Decide once we see the OpenClaw voice protocol                      |
| Canvas renderer  | Schema-driven RN renderer (custom, small)           | Canvas surface schema TBD; build a minimal interpreter              |
| Code rendering   | react-native-syntax-highlighter / Shiki-on-RN-Web   | Code blocks inside chat                                             |
| Push             | Expo Notifications                                  | "Agent needs you" / "voice call request" when app is backgrounded   |
| Testing          | Jest + RN Testing Library, Detox later              | Unit + component now; e2e once flows stabilize                      |
| CI               | GitHub Actions (lint, typecheck, test, EAS build)   | App Store / Play Store / Vercel for web                             |

---

## 5. Information architecture

Expo Router tree:

```
app/
  (pairing)/
    welcome.tsx              # "Make sure openclaw-desktop is running on your Mac"
    discover.tsx             # Bonjour scan → pick discovered host (or paste URL)
    code.tsx                 # show 6-digit pairing code; user approves in openclaw-desktop
  (tabs)/
    index.tsx                # Home: active agent, recent threads, quick voice CTA
    threads/
      index.tsx              # All conversations (one per channel/agent route)
      [id].tsx               # Thread: Chat | Canvas | Tools (per-message)
    agents.tsx               # Which agent(s) are reachable; switch active route
    voice.tsx                # Voice session (PTT + continuous)
    settings.tsx             # Host status, re-pair, push prefs, theme, diagnostics
  _layout.tsx                # CopilotKit + GatewayProvider + theme + query
```

### Key screens

1. **Welcome / Discover / Code** — first-run pairing. The phone scans for `_openclaw._tcp.local.`, the user picks their Mac mini, the phone displays a 6-digit code, and the user clicks "Approve" in the **openclaw-desktop** menu-bar app on the Mac. (CLI fallback: `openclaw pairing approve mobile <code>`.)
2. **Home** — current active agent (e.g. "Hermes via OpenRouter / Sonnet 4.6"), recent threads, big voice button.
3. **Thread** — CopilotKit chat against the gateway; Canvas surfaces inline; tool-call inspector.
4. **Agents** — list of agents the desktop exposes (skills + Hermes if installed); switch which one this device routes to.
5. **Voice** — full-screen voice session; waveform, transcript, interruption.
6. **Settings** — host name/URL, "Mac mini status" (online / version / agents), re-pair, push prefs, theme, diagnostic logs.

---

## 6. CopilotKit integration sketch

CopilotKit's runtime URL is the user's own gateway, not a cloud endpoint:

```tsx
// app/_layout.tsx
const { gatewayUrl, pairingToken } = useGateway(); // from secure store

<CopilotKit
  runtimeUrl={`${gatewayUrl}/copilot/runtime`}      // adapter we add on the gateway side
  agent={activeAgent ?? "default"}                  // e.g. "hermes" or "openclaw.default"
  headers={{ Authorization: `Bearer ${pairingToken}` }}
>
  <GatewayProvider>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <Slot />
      </QueryClientProvider>
    </ThemeProvider>
  </GatewayProvider>
</CopilotKit>
```

If the OpenClaw gateway doesn't expose a CopilotKit-compatible runtime
endpoint directly, the **openclaw-desktop** Electron app ships the adapter
as a sibling process (or bundles it in-process). The mobile app doesn't need
to know which mode is in use — `runtimeUrl` points wherever the desktop app
advertised at pairing time.

Client-side **actions** the copilot can invoke on the device:

- `switchAgent({ agentId })`
- `openThread({ id })`
- `startVoiceSession()` / `endVoiceSession()`
- `openCanvas({ surfaceId })`
- `forwardToChannel({ threadId, channel })` (e.g. resend the last reply to Telegram)

**Readables** (`useCopilotReadable`) so the assistant sees:

- Current thread, current agent, device locale and timezone.
- Whether the user is on Wi-Fi vs cellular (affects what we let voice do).
- The active Canvas surface, if any.

---

## 7. Gateway client surface (provisional — pin once we read the WS protocol)

```ts
// src/openclaw/gateway.ts
export interface GatewayClient {
  // Pairing
  requestPairing(input: { deviceName: string }): Promise<{ code: string; expiresAt: number }>;
  awaitPaired(): Promise<{ token: string }>;          // resolves when approved on host

  // Connection
  connect(token: string): Promise<void>;              // upgrades to authenticated WS
  on(event: GatewayEvent, handler: (...) => void): Unsubscribe;

  // Agents & routing
  listAgents(): Promise<AgentDescriptor[]>;           // OpenClaw skills + Hermes + others
  setActiveAgent(agentId: string): Promise<void>;

  // Threads / messages
  listThreads(): Promise<Thread[]>;
  postMessage(threadId: string, input: MessageInput): Promise<void>;
  streamThread(threadId: string, onEvent: (e: ThreadEvent) => void): Unsubscribe;

  // Canvas
  getCanvas(surfaceId: string): Promise<CanvasSurface>;
  onCanvasUpdate(surfaceId: string, handler: (patch: CanvasPatch) => void): Unsubscribe;

  // Voice
  openVoice(opts: VoiceOpts): Promise<VoiceSession>;  // returns send/receive frame interface
}
```

All UI talks to this interface — never `fetch`/`WebSocket` directly — so we can
mock it for tests and swap the underlying transport (LAN ↔ Tailscale ↔ relay)
without UI changes.

---

## 8. Compatibility constraints we've already locked in

- **Two-app pattern (desktop + mobile), like Claude.** The Mac mini runs `openclaw-desktop` (Electron) which is the trust anchor; the phone runs this app. Both speak to the same OpenClaw gateway. The desktop app is responsible for approving pairings and supervising the daemon.
- **Pairing UX mirrors OpenClaw's existing model.** OpenClaw already uses DM pairing codes for unknown messaging senders. We use the same shape but approval happens in `openclaw-desktop`'s UI (with the CLI as fallback).
- **Don't fork the agent contract.** Skills are prompt files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`) in the workspace. Neither app writes to those — they only render what agents emit and forward what the user says.
- **Hermes-as-agent path is via OpenClaw routing.** Neither app talks to Hermes directly. The gateway routes the active conversation to a Hermes process (or any other compatible agent).
- **MCP tools surface through the agent, not the apps.** Hermes supports MCP; OpenClaw exposes tools via the skill files. Neither the desktop nor the mobile app hosts MCP servers itself.

---

## 9. Risks & open issues

Tracked in `open-questions.md`. Highlights:

- The exact WS message schema, Canvas surface schema, and voice transport for OpenClaw's "iOS/Android node" mode aren't documented in the README. We need to read the source (or ask).
- CopilotKit's RN packages and OpenClaw's runtime contract may not match out of the box — the desktop app may need to ship a small adapter.
- Building two apps (mobile + Electron desktop) in tandem doubles the surface area. We mitigate by sharing a `@openclaw/protocol` TypeScript package between the two repos for message types and the gateway client.
- Background WS on iOS is fragile; push (driven from the always-on Mac) is our wake-up signal for voice-call-style scenarios.

---

## 10. What "v1 done" looks like

- Install `openclaw-desktop` on a Mac mini; install `openclaw-mobile` on a phone; both find each other on the LAN; the user clicks "Approve" on the Mac to pair.
- Mobile app shows the same agent list, threads, and Canvas surfaces as the desktop.
- Streaming chat works on iOS, Android, and Web from the same Expo build, against Hermes or an OpenClaw skill.
- One Canvas surface type renders correctly inline.
- Push-to-talk voice round-trips through the gateway to the active agent and back.
- Push notification (driven by the always-on Mac) when an agent pings while the app is backgrounded.
- No crashes on the golden path; tests cover the gateway client and the pairing reducer.

See `milestones.md` for sequencing, `host-target.md` for Mac mini assumptions,
`desktop-app.md` for the Electron companion, and `compatibility.md` for the
harness/agent matrix.
