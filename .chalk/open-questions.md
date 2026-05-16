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
