# Open questions

What we now know vs. what's still blocking. Group A blocks scaffolding past
M2; Group B can wait until the relevant milestone.

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

1. **OpenClaw WS / "device node" protocol**
   - Exact pairing handshake (token issuance, refresh, revocation).
   - Wire format for messages (JSON-RPC? Custom envelope?).
   - Topic/subscription model for threads, agents, Canvas, voice.
   - Heartbeats / reconnect semantics.
   - We will read this from the OpenClaw source before starting M2 — or, if it's not finalized, propose the schema and PR it back upstream.

2. **CopilotKit runtime compatibility with OpenClaw**
   - Does the OpenClaw gateway already speak the CopilotKit runtime protocol on some path (e.g. `/copilot/runtime`)?
   - If not, do we (a) ship a tiny adapter package the user installs alongside the gateway, or (b) bypass CopilotKit's transport and use our own chat UI with CopilotKit only for the action/readable abstractions? Decide before M3.

3. **CopilotKit React Native package names + versions**
   - Pin the exact RN-capable packages before M3 (the names have shifted as the RN support has landed).

4. **Canvas surface schema**
   - Need the spec (component types, props, update/patch format, event shape) before M4. If undocumented, propose a v1 schema covering: heading, text, button, form field, list — and confirm with the OpenClaw maintainers.

5. **Voice transport**
   - Frames-over-WS vs WebRTC. iOS background audio constraints will push us toward WebRTC if call-style usage matters.

6. **Reachability from cellular**
   - LAN works at home; does OpenClaw provide a relay, or do we rely on the user running Tailscale/Cloudflare Tunnel/ngrok? Documentation + recovery UI required either way.

7. **Hermes-as-agent wiring**
   - How exactly does Hermes register itself as an agent route inside OpenClaw? Is `hermes claw migrate` one-shot, or does Hermes run as a sibling daemon the gateway routes to? Affects whether `listAgents()` shows Hermes as one entry or many (per-tool / per-model).

8. **Branding / naming**
   - Display name, bundle id (e.g. `dev.openclaw.mobile`), icon, color tokens.

---

## B. Decisions we can make as we go

9. **State management** — Default: Zustand for UI, React Query for server cache.
10. **Telemetry** — Default: Sentry for crashes; defer product analytics until we have users.
11. **EAS vs bare** — Stay on Expo managed unless a native module (e.g. WebRTC) forces config plugins or a custom dev client.
12. **mDNS discovery on LAN** — nice-to-have; defer past v1 unless trivial.
13. **iPad / large-screen layout** — stretch.
14. **Continuous voice + barge-in** — stretch.
15. **Skill/agent editor** — stretch (read-only first).

---

## C. Assumptions still active (call out if wrong)

- The phone is always a **client** of a user-hosted gateway. We do not embed OpenClaw or Hermes on-device.
- One gateway per user for v1 (multi-gateway is stretch).
- Pairing tokens behave like long-lived OAuth refresh tokens; the WS uses them as bearer credentials.
- The CopilotKit runtime concept (HTTP endpoint that streams chat + tool calls) can be exposed by either the gateway directly or a small adapter we ship; the mobile app does not need to know which.
- Hermes does not need to be talked to directly from the phone — it's reachable via OpenClaw routing only.

If any of those flip (especially the last two), `plan.md` §3 and §6 need to shift before M3.
