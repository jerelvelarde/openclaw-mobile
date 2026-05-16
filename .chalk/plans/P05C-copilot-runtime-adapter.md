# P05C — CopilotKit runtime adapter (in desktop)

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1.5 days
**Depends on:** P04B
**Blocks:** P05A
**Can run in parallel with:** —

## Context

CopilotKit (used in mobile P05A) expects a `runtimeUrl` that speaks its
runtime protocol (HTTP POST with streaming responses). The desktop app
embeds this adapter in-process so mobile points at `/copilot/runtime` on
the same host:port and gets a normal CopilotKit experience, while the
adapter translates to/from the OpenClaw gateway's topic-based WS internally.
Per `desktop-app.md` §2 and `compatibility.md`.

## Goal

`POST /copilot/runtime` on the desktop accepts CopilotKit runtime requests,
forwards them through the in-process gateway stub (or real bridge), and
streams responses back. Mobile + desktop chat UIs both produce identical
behavior against this endpoint.

## Inputs

- P04B complete (WS server + stub gateway live).
- CopilotKit runtime spec version pinned (record exact version in this plan
  before starting — see Notes).

## Outputs

- `apps/desktop/src/main/copilot/runtime.ts` — fastify route handler.
- `apps/desktop/src/main/copilot/adapter.ts` — translates CopilotKit runtime msgs ↔ gateway topics.
- `apps/desktop/src/main/copilot/stream.ts` — SSE / chunked-encoding helpers.
- Tests covering: simple completion, tool call, error path.

## Steps

1. Add CopilotKit runtime SDK if it has a Node helper: `pnpm --filter @openclaw/desktop add @copilotkit/runtime` (check exact package name).
   - If no Node helper exists, implement the wire format directly per the spec — capture the spec link in `open-questions.md`.
2. `runtime.ts`:
   - Register `POST /copilot/runtime` on the existing fastify server.
   - Authenticate using the same bearer token model as WS (P04B).
3. `adapter.ts`:
   - Receive a CopilotKit runtime request → translate to `threads.post` envelope → publish via router.
   - Subscribe to the corresponding `threads.<id>.event` topic → translate streamed agent output back to CopilotKit's expected chunk format.
   - Tool-call translation: CopilotKit "actions" ↔ gateway "tool_call" events.
4. `stream.ts`:
   - SSE writer with backpressure handling.
   - Heartbeats every 15s so connections survive proxy idle timers.
5. Wire `runtime_url` in P03B's `/pair/status` response to point at this endpoint (`http://<host>:18789/copilot/runtime`).
6. Tests:
   - Mock the router; assert one CopilotKit request → one gateway publish → streamed reply.
   - Tool call: assert action invocation maps to a `tool_call` envelope and back.
   - Error: gateway emits error event → adapter writes a CopilotKit-shaped error chunk.

## Success criteria

- [ ] `curl -N -X POST -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' -d '{…CopilotKit body…}' http://<host>:18789/copilot/runtime` streams a response.
- [ ] CopilotKit's reference client (if installable as a test fixture) successfully sends a message and renders the streamed reply.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
# Manual:
pnpm --filter @openclaw/desktop dev
# Send a CopilotKit-shaped request via curl (capture the exact body shape in this plan's appendix).
```

## Commit

```
Embed CopilotKit runtime adapter in desktop app

POST /copilot/runtime accepts CopilotKit runtime requests, translates
to gateway threads.post envelopes, and streams responses back as SSE
chunks. Authenticated with the same bearer-token model as the
WebSocket. Mobile and desktop chat UIs can both point at the same
endpoint.
```

## Notes

- **Before starting:** pin the exact CopilotKit runtime spec version we're targeting. Their API has been evolving; lock it in this plan and update `open-questions.md` with the link.
- If CopilotKit publishes a `@copilotkit/runtime` Node helper, use it — only hand-roll the wire format if no helper exists.
- Tool/action translation is the trickiest part. Start with the read-only case (just streamed text); add tool-call mapping in a follow-up commit if it grows the plan.
- The adapter is **stateless per request** — all conversation state lives in the gateway. Don't introduce a cache here.
- Authentication: reuse `verifyToken` from P03B. No second auth mechanism.
- SSE on Electron's fastify needs careful header flushing; test against a real curl client, not just inject.
- Do **not** touch mobile in this plan. P05A consumes this endpoint.
