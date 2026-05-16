# P04A — Mobile Bonjour discovery + WS client

**App:** mobile (`apps/mobile`)
**Estimated effort:** 1.5 days
**Depends on:** P03A, P03B (for end-to-end test)
**Blocks:** P05A
**Can run in parallel with:** P04B

## Context

Replace the in-memory mock with a real transport: Bonjour discovery on LAN,
HTTP pairing against the desktop, then an authenticated WebSocket. The
`GatewayClient` interface is unchanged — only the implementation differs.
Per `plan.md` §3 and `desktop-app.md` §3.

## Goal

A user on the same Wi-Fi as the desktop opens the app → discover shows
their Mac → pair → token stored → reconnect cleanly across LAN ↔ Tailscale
↔ cellular without re-pairing.

## Inputs

- P03A + P03B complete.
- Desktop reachable at `http://<host>:18789` exposing `/pair/*` + `/healthz`.

## Outputs

- `apps/mobile/src/openclaw/transport/bonjour.ts` — discovery.
- `apps/mobile/src/openclaw/transport/http.ts` — pairing requests.
- `apps/mobile/src/openclaw/transport/ws.ts` — authenticated WS.
- `apps/mobile/src/openclaw/transport/RealGateway.ts` — `GatewayClient` impl wrapping the three.
- `apps/mobile/src/openclaw/transport/reconnect.ts` — backoff + state machine.
- `apps/mobile/app/(pairing)/discover.tsx` — uses real Bonjour browse.
- "Can't reach your Mac" banner component used app-wide.
- Tests for reconnect logic + envelope decoding.

## Steps

1. Decide on Bonjour lib. Options:
   - `react-native-zeroconf` — well-maintained, requires a custom dev client (Expo prebuild).
   - `react-native-network-info` + manual `dns-sd` — fragile.
   - **Recommended:** `react-native-zeroconf`. Run `npx expo prebuild` to generate native projects.
2. `pnpm --filter @openclaw/mobile add react-native-zeroconf`; configure plugins in `app.config.ts`.
3. `bonjour.ts`:
   - `browse({ onFound, onLost }): Unsubscribe` over `_openclaw._tcp.`.
   - On web: no-op (return synthetic empty stream).
4. `http.ts`:
   - `requestPairing(host, body)` → `POST /pair/request`.
   - `pollPairingStatus(host, pairId)` → polls `/pair/status` with backoff, resolves when approved or denied.
5. `ws.ts`:
   - Open `ws(s)://host:18789/ws` with `Authorization: Bearer <token>` header (use `WebSocket` constructor with subprotocols or query-string fallback if RN doesn't allow headers).
   - Encode/decode using `@openclaw/protocol`'s envelope helpers.
   - 30s heartbeat ping; emit `disconnected` if no pong in 90s.
6. `reconnect.ts`:
   - Exponential backoff (1s, 2s, 5s, 10s, 30s, capped at 30s + jitter).
   - Surface state: `connecting | connected | reconnecting | offline`.
7. `RealGateway.ts`:
   - Implements `GatewayClient` from `@openclaw/protocol`.
   - Composes the three transports.
   - Used by `PairingProvider` in place of `InMemoryMockGateway` once a token exists.
8. `discover.tsx` (updated):
   - Browse Bonjour on mount; debounce results.
   - Tap a host → call `requestPairing` against its HTTP base.
   - Fallback "Paste URL" field at the bottom for non-LAN cases (Tailscale, ngrok).
9. Add a "Can't reach your Mac" banner that listens to the reconnect state machine and shows on `offline` or `reconnecting > 5s`.
10. Tests:
    - Reconnect: simulate disconnect → assert backoff schedule.
    - Envelope: malformed payload rejected.
    - Mock the Bonjour browser to return one fake host; assert discover screen renders it.

## Success criteria

- [ ] App on phone (or Expo Dev Client) discovers the Mac mini's desktop instance over LAN within 5s.
- [ ] Pairing completes end-to-end against the real desktop (P03B).
- [ ] After pairing, WS connects and `listAgents()` returns the desktop's agent list (whatever P03B's `/healthz` and an MVP `agents` endpoint expose; if the WS protocol isn't implemented yet on the desktop side, leave a TODO for P04B and mock the WS response in dev).
- [ ] Toggling Wi-Fi off shows the "Can't reach your Mac" banner within 10s; toggling back reconnects without re-pairing.
- [ ] Token persists across app relaunches; reconnect uses the saved token.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
# Manual (requires P03B running on a Mac on same Wi-Fi):
pnpm --filter @openclaw/desktop dev   # in one terminal
pnpm --filter @openclaw/mobile start  # in another; open on real device
```

## Commit

```
Add real Bonjour + WS transport for the mobile gateway client

Replace the in-memory mock with react-native-zeroconf for LAN
discovery, an HTTP client for pairing, and an authenticated WebSocket
client with backoff reconnect. RealGateway implements the same
GatewayClient interface so screens are unchanged. Connection-state
banner surfaces transient network failures without forcing a re-pair.
```

## Notes

- Adding `react-native-zeroconf` means we cross from Expo Go to a **custom dev client** (`npx expo prebuild`). Document this in the mobile README so contributors know `expo start` alone won't cut it after this plan.
- iOS requires `NSLocalNetworkUsageDescription` and `NSBonjourServices` entries in `Info.plist`. Configure via `app.config.ts` `ios.infoPlist`.
- Android requires Wi-Fi multicast lock: see `react-native-zeroconf` docs.
- WS headers: RN's `WebSocket` accepts headers as the third constructor arg; React Native Web doesn't. For web, fall back to passing the token in the URL query (`?token=…`) and have the desktop accept either.
- Reconnect should be **token-bound, not host-bound**. If LAN drops and Tailscale picks up, we want a clean swap.
- Do **not** add CopilotKit or chat code here. Just transport.
