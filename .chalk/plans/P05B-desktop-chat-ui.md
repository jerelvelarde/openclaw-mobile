# P05B — Desktop chat UI

**App:** desktop (`apps/desktop`)
**Estimated effort:** 2 days
**Depends on:** P04B, P05C
**Blocks:** P06B
**Can run in parallel with:** P05A

## Context

A minimal but real chat surface in the Electron renderer that talks to the
same runtime adapter mobile uses (P05C). This proves the protocol is
client-agnostic and gives users a desk-side experience that complements the
phone. Per `desktop-app.md` §1, §2.

## Goal

Click the tray icon → main window opens → user types a message → sees
streamed reply from the same adapter mobile hits. Tool calls visible
inline. Active-agent switcher matches mobile's behavior.

## Inputs

- P04B + P05C complete.

## Outputs

- `apps/desktop/src/renderer/pages/Chat.tsx` — main chat UI.
- `apps/desktop/src/renderer/pages/Agents.tsx` — agent picker.
- `apps/desktop/src/renderer/hooks/useGateway.ts` — wraps protocol client for renderer use.
- `apps/desktop/src/renderer/components/MessageList.tsx`, `MessageInput.tsx`, `ToolCallView.tsx`.
- Tests for hooks + components.

## Steps

1. Decide on UI primitives. Default for v1: plain CSS + a small set of components. Don't pull in a full design system.
2. Add CopilotKit React (web) packages if they suit, OR roll a tiny custom chat — the runtime is HTTP/SSE so either works. Default: **plain fetch-based client** to keep desktop bundle small. Reuse stream parsing helpers from P05C if available.
3. `useGateway.ts`:
   - Establishes WS to `127.0.0.1:18789/ws` using the local desktop's own pairing token (issued to "self" device).
   - Exposes `agents`, `threads`, `activeAgent`, `setActiveAgent`, `postMessage`.
4. `Chat.tsx`:
   - Top: agent pill + thread selector.
   - Middle: `<MessageList/>` scrollable.
   - Bottom: `<MessageInput/>` with Enter-to-send, Shift-Enter for newline.
5. `MessageList.tsx`:
   - Renders user + agent bubbles.
   - Below each agent message: `<ToolCallView/>` collapsible.
6. `Agents.tsx`:
   - Lists agents from `listAgents()`.
   - Tap to switch.
7. Wire navigation: tray "Show" or clicking the icon opens the window on the Chat route.
8. Self-token: on first run, the desktop issues a token to itself (`device_id: "self"`) and stores it in Keychain so the renderer can authenticate without a pairing dance.
9. Tests:
   - `useGateway` connects + receives messages (mocked WS).
   - Components render expected DOM.

## Success criteria

- [ ] Click tray → window opens to Chat.
- [ ] Send a message → see streamed reply (against P05C + stub gateway from P04B).
- [ ] Tool calls show in the inspector.
- [ ] Switching agent updates the active pill and routes new messages.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
# Manual on macOS dev box:
pnpm --filter @openclaw/desktop dev
```

## Commit

```
Add minimal desktop chat UI against shared runtime adapter

Renderer-side React chat using fetch+SSE to /copilot/runtime,
WS to /ws for thread/agent state, and a small component set
(MessageList, MessageInput, ToolCallView). Tray click opens the
window directly into Chat. Self-issued bearer token authenticates
the renderer without a pairing dance.
```

## Notes

- Resist the urge to share React components with mobile via react-native-web for v1. Desktop chat is small enough to own its own UI. We can converge later if it pays off.
- Self-token (one issued to `device_id: "self"`) must NOT be exposed over LAN — it's a local-only artifact stored in Keychain.
- Keep CSS minimal — system fonts, system colors, a couple of accent colors. Polish in P09.
- Do **not** add Canvas here. P06B.
- Do **not** add voice. P07B.
- If electron-vite's HMR hiccups on hooks, just hard-reload during dev; don't chase HMR perfection here.
