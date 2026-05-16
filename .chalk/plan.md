# openclaw-mobile — Plan

A mobile **device node** for [OpenClaw](https://github.com/openclaw/openclaw),
the local-first personal-AI gateway that runs as a daemon on your own machine.

Your laptop/desktop/home server runs `openclaw gateway` on port `18789`. This
app pairs to it over WebSocket and becomes another surface for your agents —
chat, Canvas, voice — alongside the messaging channels OpenClaw already speaks
(WhatsApp, Telegram, Slack, Discord, Signal, iMessage, …).

The agents themselves are pluggable. We're explicitly compatible with:

- **OpenClaw**'s built-in skills/agents (workspace at `~/.openclaw/workspace`, skills as `AGENTS.md` / `SOUL.md` / `TOOLS.md`).
- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** from Nous Research, which interoperates with OpenClaw (`hermes claw migrate`) and is model-agnostic across Nous Portal, OpenRouter, NovitaAI, NVIDIA NIM, Hugging Face, OpenAI, etc.

Built with **Expo (React Native + Web)** and **CopilotKit's React Native
runtime** for the chat surface. See `compatibility.md` for the harness/agent
matrix and `milestones.md` for delivery.

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

```
┌────────────────────────┐         ┌──────────────────────────────────────┐
│  openclaw-mobile       │  WSS    │  User's machine (macOS/Linux/Win)     │
│  (Expo: iOS/Android/Web)│ ◄────► │                                       │
│  - Pairing flow        │         │  openclaw gateway :18789 (daemon)     │
│  - CopilotKit chat     │         │   ├─ workspace ~/.openclaw/workspace  │
│  - Canvas renderer     │         │   ├─ skills (AGENTS.md/SOUL.md/...)   │
│  - Voice (PTT)         │         │   ├─ multi-agent router               │
└────────────────────────┘         │   └─ channels (WA, TG, Slack, …)      │
                                   │                                       │
                                   │  Agent process(es):                   │
                                   │   • OpenClaw built-in skill agents    │
                                   │   • hermes-agent (Nous Research)      │
                                   │     + any LLM provider it's wired to  │
                                   └──────────────────────────────────────┘
```

Reachability between phone and gateway is a real problem (the phone is usually
on cellular, the gateway is at home). v1 supports three transports, in order
of preference (see `open-questions.md` §A1 for what we still need to confirm):

1. **Local LAN** — same Wi-Fi: `ws://gateway.local:18789` or mDNS discovery.
2. **Tailscale / Wireguard** — user already runs an overlay network; we just need a hostname.
3. **Relay** — if OpenClaw exposes a hosted relay, fall back to that; otherwise document `cloudflared` / `ngrok` as a manual option.

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
    welcome.tsx              # explain "this app pairs to your OpenClaw gateway"
    connect.tsx              # enter gateway URL (or pick discovered) → request pairing
    code.tsx                 # show DM pairing code, wait for approval
  (tabs)/
    index.tsx                # Home: active agent, recent threads, quick voice CTA
    threads/
      index.tsx              # All conversations (one per channel/agent route)
      [id].tsx               # Thread: Chat | Canvas | Tools (per-message)
    agents.tsx               # Which agent(s) are reachable; switch active route
    voice.tsx                # Voice session (PTT + continuous)
    settings.tsx             # Gateway URL, pairing reset, notifications, theme
  _layout.tsx                # CopilotKit + GatewayProvider + theme + query
```

### Key screens

1. **Welcome / Connect / Code** — first-run pairing. The user runs `openclaw pairing approve mobile <code>` on their machine (or approves via the menu-bar app) and the WS upgrades to a trusted session.
2. **Home** — current active agent (e.g. "Hermes via OpenRouter / Sonnet 4.6"), recent threads, big voice button.
3. **Thread** — CopilotKit chat against the gateway; Canvas surfaces inline; tool-call inspector.
4. **Agents** — list of agents the gateway exposes (skills + Hermes if installed); switch which one this device routes to.
5. **Voice** — full-screen voice session; waveform, transcript, interruption.
6. **Settings** — gateway URL/host, re-pair, push prefs, theme, diagnostic logs.

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

If OpenClaw doesn't yet expose a CopilotKit-compatible runtime endpoint, we
ship a tiny adapter (`packages/openclaw-copilot-runtime`) that the user runs
alongside the gateway — see `compatibility.md`.

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

- **Pairing UX must mirror OpenClaw's existing model.** OpenClaw already uses DM pairing codes for unknown messaging senders, approved with `openclaw pairing approve <channel> <code>`. We use the same shape so users only learn one mental model.
- **Don't fork the agent contract.** Skills are prompt files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`) in the workspace. The mobile app never writes to those — it just renders what agents emit and forwards what the user says.
- **Hermes-as-agent path is via OpenClaw routing.** We don't talk to Hermes directly. The gateway routes the active conversation to a Hermes process (or any other compatible agent). One thread, one gateway, multiple possible agents.
- **MCP tools surface through the agent, not the app.** Hermes supports MCP; OpenClaw exposes tools via the skill files. The mobile app does not host MCP servers itself.

---

## 9. Risks & open issues

Tracked in `open-questions.md`. Highlights:

- The exact WS message schema, Canvas surface schema, and voice transport for OpenClaw's "iOS/Android node" mode aren't documented in the README. We need to read the source (or ask).
- CopilotKit's RN packages and OpenClaw's runtime contract may not match out of the box — we may need a tiny adapter.
- Reaching a home gateway from cellular: no clean answer yet; v1 may require Tailscale or a relay.
- Background WS on iOS is fragile; we'll need push as a "wake the app" signal for voice-call-style scenarios.

---

## 10. What "v1 done" looks like

- Install the app, pair to your gateway, see your agents, pick Hermes (or an OpenClaw skill), have a streaming chat that works on iOS, Android, and Web from the same Expo build.
- One Canvas surface type renders correctly inline.
- Push-to-talk voice round-trips through the gateway to the active agent and back.
- Push notification when an agent pings you while the app is backgrounded.
- No crashes on the golden path; tests cover the gateway client and the pairing reducer.

See `milestones.md` for sequencing and `compatibility.md` for the harness/agent matrix.
