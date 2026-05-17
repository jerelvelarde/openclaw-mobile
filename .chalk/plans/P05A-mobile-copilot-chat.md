# P05A — Mobile CopilotKit chat

**App:** mobile (`apps/mobile`)
**Estimated effort:** 2 days
**Depends on:** P04A, P05C
**Blocks:** P06A
**Can run in parallel with:** P05B

## Context

Wire CopilotKit's React Native packages to the desktop-hosted runtime
adapter (P05C). Render the chat surface inside `threads/[id].tsx`,
register client-side actions and readables, and surface tool calls
inline. Per `plan.md` §6.

## Goal

Open the app, tap a thread, type a message → see streamed reply from the
desktop-routed agent (stub or real Hermes). Client actions
(`switchAgent`, `openThread`) work. The "active agent" pill in the header
reflects what the gateway reports.

## Inputs

- P04A complete (real WS + token storage).
- P05C complete (CopilotKit runtime endpoint live).
- CopilotKit RN package name + version pinned in P05C.

## Outputs

- `apps/mobile/app/_layout.tsx` wraps tree in `<CopilotKit>`.
- `apps/mobile/app/(tabs)/threads/[id].tsx` renders `CopilotChat`.
- `apps/mobile/src/copilot/actions.ts` — client actions.
- `apps/mobile/src/copilot/readables.ts` — `useCopilotReadable` hooks.
- `apps/mobile/src/copilot/runtimeUrl.ts` — derives URL from paired host + runtime path.
- Tests for action handlers + readable composition.

## Steps

1. Install pinned CopilotKit RN packages (verify names in P05C):
   `pnpm --filter @openclaw/mobile add @copilotkit/react-core @copilotkit/react-native` (or whatever the current names are).
2. `runtimeUrl.ts`:
   - From paired host + `runtime_url` returned at pairing time, build the absolute URL.
   - Inject bearer token in headers via CopilotKit's `headers` prop.
3. `_layout.tsx`:
   - Inside the paired branch, wrap in:
     ```tsx
     <CopilotKit
       runtimeUrl={runtimeUrl}
       agent={activeAgent ?? "openclaw.default"}
       headers={{ Authorization: `Bearer ${token}` }}
     >
       <Slot />
     </CopilotKit>
     ```
4. `app/(tabs)/threads/[id].tsx`:
   - Render `<CopilotChat>` (or the RN equivalent).
   - Header shows `<ActiveAgentPill/>` reading from gateway state.
   - Below messages: tool-call inspector (collapsible). For each tool call, show name + args + result.
5. `actions.ts`:
   - `useCopilotAction({ name: "switchAgent", parameters: [...], handler })`.
   - `useCopilotAction({ name: "openThread", ... })`.
   - Both call into the existing `GatewayClient` to mutate state.
6. `readables.ts`:
   - `useCopilotReadable({ description: "current thread", value: thread })`.
   - `useCopilotReadable({ description: "device network type", value: networkType })`.
   - `useCopilotReadable({ description: "active agent", value: activeAgent })`.
7. `app/(tabs)/agents.tsx` — list `listAgents()` results; tap to `setActiveAgent`.
8. Tests:
   - Action handlers: given a fake gateway, calling `switchAgent` updates state.
   - Readables: composition produces the expected object.

## Success criteria

- [ ] Sending a message in `threads/[id]` displays a streamed reply from the desktop adapter (stub agent for now).
- [ ] Tool-call inspector shows at least the stub gateway's fake tool call.
- [ ] Switching agent via `agents.tsx` updates the active agent pill and re-routes new messages.
- [ ] Killing Wi-Fi mid-stream → "Can't reach your Mac" banner shows; restoring reconnects without re-pairing.
- [ ] All tests pass.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
# Manual (desktop dev running + paired phone):
pnpm --filter @openclaw/desktop dev
pnpm --filter @openclaw/mobile start
```

## Commit

```
Wire CopilotKit chat in mobile against desktop runtime adapter

Add CopilotKit provider at the paired root, render CopilotChat in
threads/[id], register switchAgent / openThread client actions, and
expose thread / agent / network readables. Active-agent pill in the
header reflects gateway state.
```

## Notes

- **Lock the CopilotKit package versions** before starting. Their RN support and APIs have shifted; pin in `package.json` and document the pin in this plan's header.
- If `@copilotkit/react-native` doesn't exist yet, fall back to `@copilotkit/react-core` + a custom RN renderer wrapping a `FlatList` of messages. Flag this in `open-questions.md`.
- Streaming on RN works fine with `EventSource` polyfills or CopilotKit's built-in transport — don't roll your own SSE client unless you have to.
- Do **not** add Canvas rendering here. That's P06A.
- Do **not** add voice. That's P07A.
- The tool-call inspector is intentionally minimal — collapsible JSON view is fine; don't build a fancy DSL renderer.
