# P04B — Desktop Bonjour advertise + WS server

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1.5 days
**Depends on:** P03B
**Blocks:** P05C, end-to-end transport
**Can run in parallel with:** P04A

## Context

Open the desktop's pairing-service host to the LAN, advertise it via
Bonjour, and stand up the authenticated WebSocket endpoint mobile will
connect to after pairing. Per `desktop-app.md` §2 and §5.

## Goal

The desktop advertises `_openclaw._tcp.local.` so mobile discovers it
automatically; the WS endpoint (`/ws`) validates bearer tokens via the
Keychain key and routes messages on topics `threads.*`, `agents.*`,
`canvas.*`, `voice.*`, `system.*`. Until the real OpenClaw gateway WS is
wired (separate effort), the WS server uses an in-process bridge to a stub
gateway that returns the same shapes `@openclaw/protocol`'s mock produces.

## Inputs

- P03B complete.
- `@openclaw/protocol` envelope helpers + types available.

## Outputs

- `apps/desktop/src/main/transport/bonjour.ts` — advertise service.
- `apps/desktop/src/main/transport/wsServer.ts` — `ws`-based server with token validation.
- `apps/desktop/src/main/transport/router.ts` — topic-based dispatch.
- `apps/desktop/src/main/gateway/stub.ts` — in-process stub bridging to a fake agent.
- `apps/desktop/src/main/pair/server.ts` updated to listen on `0.0.0.0` (LAN) gated by setting.
- Tests for token validation + router dispatch.

## Steps

1. `pnpm --filter @openclaw/desktop add bonjour-service ws @types/ws`.
2. `bonjour.ts`:
   - On app ready: `bonjour.publish({ name: "OpenClaw (<hostname>)", type: "openclaw", protocol: "tcp", port: 18789, txt: { gateway_id, version } })`.
   - On quit: `bonjour.unpublishAll`.
3. `wsServer.ts`:
   - Attach a `WebSocket.Server` to the fastify HTTP server (share the port).
   - On upgrade: read `Authorization: Bearer <token>` (or `?token=…` query for web clients), call `verifyToken`. Reject 401 if invalid.
   - On connection: register the socket in a `Sessions` map keyed by `device_id`.
   - 30s ping; close socket if no pong within 90s.
4. `router.ts`:
   - `subscribe(topic, handler)` / `publish(topic, payload)`.
   - On incoming frame: validate envelope with Zod (from protocol package); dispatch to topic handler.
   - On outgoing publish: encode envelope; send to all subscribed sessions.
5. `gateway/stub.ts`:
   - In-process implementation that:
     - Returns 2 agents on `agents.list`.
     - Echoes messages on `threads.post` with a streamed fake reply.
     - Emits a Canvas surface for one trigger phrase.
   - This is the bridge that real OpenClaw gateway integration will replace later.
6. Update `pair/server.ts`:
   - Add a setting (in `userData/settings.json`) `lan_enabled: boolean`, default `true`.
   - When `true`, bind to `0.0.0.0:18789`; else `127.0.0.1`.
   - Surface a toggle in the renderer Settings page (stub UI for now).
7. Tests:
   - `wsServer`: connects with valid token, rejects invalid token.
   - `router`: subscribe/publish round-trip.
   - `stub`: `agents.list` returns two; `threads.post` emits the streamed reply.
8. Update Tray menu: show current network state ("LAN: enabled", "Bonjour: advertising") for diagnostics.

## Success criteria

- [ ] `dns-sd -B _openclaw._tcp` on another Mac on the same Wi-Fi shows the service.
- [ ] `curl -i http://<mac>.local:18789/healthz` from another machine succeeds.
- [ ] `wscat -c "ws://<mac>.local:18789/ws" -H "Authorization: Bearer <token>"` connects with a valid token.
- [ ] Invalid token returns 401 on upgrade.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
pnpm --filter @openclaw/desktop build
# Manual on a Mac:
pnpm --filter @openclaw/desktop dev
# From another machine on same Wi-Fi:
dns-sd -B _openclaw._tcp .
curl -i http://<host>.local:18789/healthz
```

## Commit

```
Open desktop to LAN with Bonjour + authenticated WebSocket server

Advertise _openclaw._tcp.local. via bonjour-service. WebSocket server
shares the pairing port, validates bearer tokens against the Keychain
key, and dispatches messages on topic-based routes via a small router.
An in-process stub gateway returns shapes matching @openclaw/protocol
so mobile end-to-end works before the real OpenClaw gateway is wired.
```

## Notes

- The stub gateway is **explicit** — leave a `// TODO: replace with real OpenClaw gateway bridge` comment at its top.
- `bonjour-service` works on macOS without extra deps. On Linux you may need Avahi; we don't optimize for Linux here.
- macOS will prompt for **Local Network** permission the first time the app advertises Bonjour. Add the matching usage description in the packaged Info.plist (P09B will own the production version).
- Ensure the WS server **doesn't** expose the gateway over LAN until pairing succeeds — auth check happens on upgrade, not on the message loop.
- Do **not** implement the CopilotKit runtime here. That's P05C.
- Update the `runtime_url` returned in P03B's `/pair/status` to point at the now-live `/copilot/runtime` placeholder (which P05C will implement).
