# Harness / agent compatibility

What this app talks to, and how it stays compatible with the OpenClaw +
Hermes ecosystem rather than forking it.

---

## The picture

- **Harness:** [OpenClaw](https://github.com/openclaw/openclaw) gateway daemon, running on the user's machine.
- **Agents:** any agent OpenClaw can route to. Day-one targets:
  - OpenClaw's own skill agents (workspace at `~/.openclaw/workspace`, skills as `AGENTS.md` / `SOUL.md` / `TOOLS.md`).
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research, which interoperates with OpenClaw (`hermes claw migrate`) and is model-agnostic across Nous Portal, OpenRouter, NovitaAI, NVIDIA NIM, OpenAI, Hugging Face, etc.
- **Mobile app:** an OpenClaw "device node" — pairs to the gateway over WebSocket, surfaces chat + Canvas + voice, never runs an agent itself.

```
phone (this app)  ──WSS──►  openclaw gateway :18789  ──►  agent (Hermes or OpenClaw skill)  ──►  LLM provider
                                       │
                                       └──► other channels (Telegram, WhatsApp, Slack, Discord, Signal, iMessage)
```

---

## Harness compatibility — OpenClaw

| Concern               | Approach                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------- |
| Install / run         | We don't bundle or wrap OpenClaw. User runs `openclaw onboard --install-daemon` then `openclaw gateway --port 18789`. |
| Pairing               | Mirror OpenClaw's DM pairing-code UX. Approval happens on the host via `openclaw pairing approve mobile <code>` (or the menu-bar app). |
| Transport             | WebSocket to the gateway (`ws://host:18789` on LAN, `wss://…` via Tailscale or relay).    |
| Workspace             | We never write to `~/.openclaw/workspace`. v1 reads agent/skill list only.                |
| Multi-agent routing   | Use the gateway's built-in router; expose "active agent" switching in the UI.             |
| Channels              | We're a peer to Telegram/Slack/etc., not a replacement. Optional "forward to channel" action lets the user route a thread elsewhere. |
| CopilotKit runtime    | If the gateway exposes one natively, use it. Otherwise ship a small adapter (`packages/openclaw-copilot-runtime`) the user can run alongside the gateway. |

### Adapter strategy (only if needed)

If OpenClaw's WS protocol doesn't map directly onto CopilotKit's runtime
contract, we ship a single-binary Node adapter:

- Listens on a local HTTP port (e.g. `:18790`).
- Speaks CopilotKit's runtime protocol on `/copilot/runtime`.
- Translates to OpenClaw's WS topics underneath.
- Installable via `npx @openclaw/copilot-adapter` or as a sibling daemon.

The mobile app doesn't need to know which mode is in use — `runtimeUrl`
points wherever the user configured it.

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

- [ ] Pairing works end-to-end with the upstream `openclaw gateway` binary, no fork.
- [ ] No writes to `~/.openclaw/workspace` from the app.
- [ ] `listAgents()` correctly reflects both OpenClaw skills and a Hermes-routed agent when both are installed.
- [ ] Chat against Hermes streams tokens and tool calls without app-side special-casing.
- [ ] Canvas surfaces from OpenClaw render with no agent-specific branches.
- [ ] Voice round-trips through the gateway to the active agent regardless of which agent it is.
- [ ] App degrades cleanly if only OpenClaw skills are installed (no Hermes), and vice versa.

---

## What we explicitly do not promise (v1)

- Compatibility with agents that bypass OpenClaw and try to connect to the app directly.
- Hosting an OpenClaw or Hermes instance on the device.
- Migrating skill/agent definitions between hosts from the phone.
- Cross-gateway sync (multi-gateway is stretch).
