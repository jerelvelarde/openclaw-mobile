# P03B — Desktop pairing service + approval UI

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1.5 days
**Depends on:** P02B
**Blocks:** P04B (end-to-end pairing)
**Can run in parallel with:** P03A

## Context

The desktop app is the **trust anchor**: it issues pairing tokens, holds the
signing keypair in macOS Keychain, and shows the user the approval modal
(plus a native macOS notification). Per `desktop-app.md` §2–3.

## Goal

A local HTTP server on the desktop accepts `POST /pair/request`, shows a
macOS notification + an approval modal in the Electron window, and on
"Approve" returns a signed pairing token to the polling client. Tokens are
persisted on disk; the signing key lives in Keychain.

## Inputs

- P02B complete.
- `@openclaw/protocol` exports pairing request/response types.

## Outputs

- `apps/desktop/src/main/pair/server.ts` — HTTP server on `127.0.0.1:18789` (or env-configurable).
- `apps/desktop/src/main/pair/keypair.ts` — Keychain-backed Ed25519 keypair via `keytar`.
- `apps/desktop/src/main/pair/token.ts` — issue + verify signed pairing tokens.
- `apps/desktop/src/main/pair/store.ts` — persist approved devices (`~/Library/Application Support/openclaw/devices.json`).
- `apps/desktop/src/renderer/pages/ApprovePairing.tsx` — modal UI.
- `apps/desktop/src/main/notifications.ts` — macOS notification helper.
- Tests for keypair + token + store.

## Steps

1. `cd apps/desktop && pnpm add keytar fastify` (fastify chosen for small surface; `express` is also fine).
2. `keypair.ts`:
   - On first run: generate Ed25519 keypair (use `crypto.generateKeyPairSync` or `tweetnacl`); store private key bytes in Keychain under service `dev.openclaw.desktop`, account `signing-key`.
   - Expose `getSigningKey()` and `getPublicKey()`.
3. `token.ts`:
   - `issueToken({ device_id, device_name }) → string`: signed JSON `{ device_id, device_name, gateway_id, issued_at, exp }` using the Keychain key.
   - `verifyToken(token: string) → Claim | null`.
4. `store.ts`:
   - JSON file at `app.getPath("userData")/devices.json`.
   - `addDevice(device)`, `listDevices()`, `revokeDevice(id)`.
5. `server.ts` (fastify):
   - `POST /pair/request` body `{ device_name, public_key }` → assigns `pair_id` + 6-digit `code`, stores pending in memory, returns `{ code, pair_id, expires_at }`.
   - `GET /pair/status?pair_id=…` → `{ status: "pending" | "approved" | "denied", token?, runtime_url? }`.
   - `GET /healthz` → `{ ok, gateway_id, version }`.
   - Binds to `127.0.0.1` only (LAN exposure comes in P04B).
6. `notifications.ts`:
   - On new pairing request: native macOS Notification with `[Approve] [Deny]` buttons (use Electron's `Notification` with `actions`).
   - Clicking the notification focuses the Electron window and routes to `ApprovePairing` page.
7. Renderer:
   - `ApprovePairing.tsx` shows the device name + the 6-digit code mirrored from main (so the user can compare).
   - Two buttons: Approve / Deny.
   - On Approve: IPC → main → flips pending pair to approved, signs token, returns to the polling client; persists device.
8. IPC wiring in `preload/index.ts`:
   - `pairing.listPending()`, `pairing.approve(pairId)`, `pairing.deny(pairId)`, `pairing.onPending(handler)`.
9. Tests (vitest):
   - Keypair: generates, persists, reloads.
   - Token: issue → verify; tampered token rejected.
   - Store: add → list → revoke.
   - Server: integration test using fastify's inject method for the three routes.
10. Update tray menu: add "Paired devices…" item that opens a renderer page listing approved devices.

## Success criteria

- [ ] On first run, keypair lands in Keychain (visible in Keychain Access on macOS).
- [ ] `curl -X POST -H "Content-Type: application/json" -d '{"device_name":"Phone","public_key":"…"}' http://127.0.0.1:18789/pair/request` returns a code.
- [ ] macOS notification appears with [Approve] / [Deny].
- [ ] After approval, `GET /pair/status?pair_id=…` returns `{ status: "approved", token, runtime_url }`.
- [ ] Token validates with `verifyToken`.
- [ ] All tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
pnpm --filter @openclaw/desktop build
# Manual on macOS dev box:
pnpm --filter @openclaw/desktop dev
# In another terminal:
curl -i -X POST -H 'Content-Type: application/json' \
  -d '{"device_name":"DevPhone","public_key":"base64..."}' \
  http://127.0.0.1:18789/pair/request
# Approve in the notification, then:
curl -i 'http://127.0.0.1:18789/pair/status?pair_id=…'
```

## Commit

```
Add desktop pairing service with Keychain-backed signing + approval UI

Local fastify server exposes /pair/request, /pair/status, /healthz.
Ed25519 signing key persists in macOS Keychain via keytar. Pairing
requests trigger a native macOS notification + an Approve/Deny modal
in the renderer. Approved devices persist to userData/devices.json.
```

## Notes

- Bind to `127.0.0.1` only in this plan — opening to LAN happens in P04B.
- Do **not** add WebSocket here. Only HTTP for pairing.
- Use Electron's built-in `Notification`; don't add `node-notifier` or similar.
- `keytar` ships native bindings — make sure electron-builder's `nativeRebuild` handles it (electron-vite does this by default).
- The "runtime_url" in the approval response is the CopilotKit runtime URL the desktop app will host. For P03B, return a placeholder `null` or `"http://127.0.0.1:18789/copilot/runtime"` — actual adapter lands in P05C.
- Devices file should NOT contain raw tokens — only `{ device_id, device_name, paired_at, last_seen }`. Tokens live only on the device that holds them.
- If the user has Touch ID configured, prompt for it before exposing the signing key (`keytar` doesn't gate this — use `local-authentication` patterns later; for v1 it's fine to skip).
