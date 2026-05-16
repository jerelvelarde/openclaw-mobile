# Harness / agent compatibility

What this app talks to, and how it stays compatible with the OpenClaw +
Hermes ecosystem rather than forking it.

---

## The picture

- **Host hardware:** always-on Mac — Mac mini or docked MacBook (see `host-target.md`).
- **Desktop companion:** **`apps/desktop`** (Electron, in this monorepo — see `desktop-app.md`). Supervises the gateway, handles pairing approvals, advertises Bonjour, fans out push notifications.
- **Harness:** [OpenClaw](https://github.com/openclaw/openclaw) gateway daemon, supervised by the desktop app.
- **Agents:** any agent OpenClaw can route to. Day-one targets:
  - OpenClaw's own skill agents (workspace at `~/.openclaw/workspace`, skills as `AGENTS.md` / `SOUL.md` / `TOOLS.md`).
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research, which interoperates with OpenClaw (`hermes claw migrate`) and is model-agnostic across Nous Portal, OpenRouter, NovitaAI, NVIDIA NIM, OpenAI, Hugging Face, etc.
- **Mobile app:** an OpenClaw "device node" — pairs to the gateway over WebSocket via the desktop app, surfaces chat + Canvas + voice, never runs an agent itself.

```
phone (this app) ──WSS──► apps/desktop (Electron) ──IPC──► openclaw gateway :18789 ──► agent (Hermes / skill) ──► LLM provider
                                   │                                       │
                                   └─ Bonjour, pairing UI,                 └─ other channels (Telegram, WA, Slack, …)
                                      push fan-out, supervision
```

---

## Harness compatibility — OpenClaw

| Concern               | Approach                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Install / run         | Recommended: install `apps/desktop` (signed `.dmg`); it installs and supervises the gateway. Fallback: `openclaw onboard --install-daemon` + manual `openclaw gateway --port 18789`. |
| Pairing               | Mirror OpenClaw's DM pairing-code UX. Approval happens in the **apps/desktop** UI / macOS notification (fallback: `openclaw pairing approve mobile <code>` CLI). |
| Transport             | WebSocket to the gateway, advertised by the desktop app at pairing time (`ws://host:18789` on LAN, `wss://…` via Tailscale or relay). |
| Workspace             | Neither app writes to `~/.openclaw/workspace`. v1 reads agent/skill list only.            |
| Multi-agent routing   | Use the gateway's built-in router; both apps expose "active agent" switching in their UI. |
| Channels              | Both apps are peers to Telegram/Slack/etc., not a replacement. Optional "forward to channel" action lets the user route a thread elsewhere. |
| CopilotKit runtime    | If the gateway exposes one natively, use it. Otherwise the desktop app embeds the adapter and advertises `runtime_url` to mobile at pairing time. |

### Adapter strategy (only if needed)

If OpenClaw's WS protocol doesn't map directly onto CopilotKit's runtime
contract, the **apps/desktop** Electron app embeds the adapter
in-process:

- Listens on a local HTTP port (e.g. `:18790`).
- Speaks CopilotKit's runtime protocol on `/copilot/runtime`.
- Translates to OpenClaw's WS topics underneath.
- Bundled inside the Electron app so users don't manage a separate process.

The mobile app doesn't need to know which mode is in use — it uses whatever
`runtime_url` the desktop app handed it at pairing time.

---

## Agent compatibility — Hermes

| Concern               | Approach                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Install               | User installs Hermes per its README. We don't ship or manage it.                          |
| Wiring into OpenClaw  | Use Hermes's existing OpenClaw interop (`hermes claw migrate` / gateway side-by-side). The mobile app reaches Hermes only through OpenClaw's router. |
| Model selection       | Surfaced by Hermes, not by us. `agents.tsx` shows "Hermes (active model: …)" if Hermes reports it; switching models stays inside Hermes (`hermes model`). |
| Tools / MCP           | Tools execute agent-side. The phone renders the tool-call timeline; it does not host MCP servers. |
| Identity              | Hermes appears in `listAgents()` as one entry (or more, if OpenClaw routes per persona/skill). UI is agnostic to count. |

### What Hermes-specific code we'll *avoid* writing

- No direct Hermes HTTP/CLI calls from the phone.
- No Hermes-specific message envelope. Everything flows through the same `GatewayClient` interface.
- No on-device LLM provider config. If the user wants to switch from OpenRouter to Nous Portal, that's a Hermes config change on the host machine.

This keeps the door open for swapping in other agents (or future Nous projects) without touching the app.

---

## Conformance checklist (run before tagging v1)

- [ ] Pairing works end-to-end via `apps/desktop` on a real Mac mini + upstream `openclaw gateway`, no fork of either.
- [ ] CLI-only fallback pairing (no desktop app) still works on a Linux host.
- [ ] No writes to `~/.openclaw/workspace` from either app.
- [ ] `listAgents()` correctly reflects both OpenClaw skills and a Hermes-routed agent when both are installed.
- [ ] Chat against Hermes streams tokens and tool calls without app-side special-casing.
- [ ] Canvas surfaces from OpenClaw render identically in mobile and desktop with no agent-specific branches.
- [ ] Voice round-trips through the gateway to the active agent regardless of which agent it is.
- [ ] App degrades cleanly if only OpenClaw skills are installed (no Hermes), and vice versa.
- [ ] Mobile reconnects cleanly when the network transport changes (LAN ↔ Tailscale ↔ cellular) without re-pairing.

---

## What we explicitly do not promise (v1)

- Compatibility with agents that bypass OpenClaw and try to connect to the app directly.
- Hosting an OpenClaw or Hermes instance on the device.
- Migrating skill/agent definitions between hosts from the phone.
- Cross-gateway sync (multi-gateway is stretch).
