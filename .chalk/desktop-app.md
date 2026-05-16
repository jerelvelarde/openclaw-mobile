# openclaw-desktop — the Electron companion (sibling repo)

We're following the **Claude pattern**: a desktop app that lives on the user's
always-on machine + a mobile app that pairs with it. This document specifies
the desktop app from the mobile app's perspective — the contract it has to
expose so this repo can ship against it.

The desktop app lives in its own repo (suggested name: **`openclaw-desktop`**)
because:

- It has a different stack (Electron + Node, not React Native).
- It needs to be code-signed and notarized for macOS separately.
- It will eventually want Windows/Linux builds too, with their own quirks.
- Splitting the repos keeps the mobile bundle small and lets each ship on its own cadence.

This file lives in the mobile repo because mobile-side design decisions
(pairing UX, transports, push, voice) depend on what the desktop app
guarantees.

---

## 1. Why we need it (not just the openclaw CLI)

The raw OpenClaw CLI + launchd daemon works, but it's not a product
experience. The Electron app turns it into one:

| Need                                       | CLI alone               | With openclaw-desktop                         |
| ------------------------------------------ | ----------------------- | --------------------------------------------- |
| Daemon supervision & auto-update           | manual launchctl        | Electron supervises, prompts for updates      |
| Pairing approval                           | type a command          | tap "Approve" in a notification               |
| See what's running / errored               | tail logs               | menu-bar icon + log viewer                    |
| Desktop chat surface                       | nothing                 | full chat + Canvas, same UI patterns as phone |
| Tailscale / remote-access onboarding       | docs only               | step-by-step in-app flow                      |
| Notarized, App-Store-grade install         | brew/npm tarball        | signed `.dmg`                                 |
| Bonjour service advertisement              | depends on gateway      | guaranteed; controlled lifecycle              |

For the mobile app specifically: without a real desktop app, every pairing
requires the user to open a terminal on their Mac mini. With it, pairing is a
single tap on a macOS notification.

---

## 2. Responsibilities (the contract mobile depends on)

The desktop app MUST:

1. **Supervise the gateway.** Start/stop `openclaw gateway` (either as a child process or by managing the launchd agent). Restart on crash. Surface health to the menu bar.
2. **Advertise on the LAN.** Register `_openclaw._tcp.local.` via Bonjour with `host`, `port`, `version`, and `gateway_id` (stable UUID per Mac).
3. **Own the pairing flow.** When a new device requests pairing, show a system notification + a modal in the desktop app: "Pair iPhone (Jerel)? — Code: 482915". Persist approvals; allow revocation in Settings → Devices.
4. **Issue and validate pairing tokens.** Tokens are bound to a `device_id` and signed by a per-gateway keypair. Mobile presents the token on every WS connect.
5. **Expose the gateway WS / HTTP** with a documented protocol (see §5).
6. **Bridge to CopilotKit runtime.** Either the gateway speaks it natively or the desktop app embeds the adapter. The mobile app does not care which; it just hits `runtimeUrl`.
7. **Drive push notifications.** The desktop app holds APNs/FCM credentials and posts to mobile when an agent needs the user. The mobile app never polls.
8. **Surface agent state.** Whatever `listAgents()` returns to mobile must match what the desktop app shows in its own Agents panel — single source of truth (the gateway).

The desktop app MAY:

- Provide a full desktop chat UI (recommended, since we're already building the RN one — Electron can reuse the same React components with platform forks where needed).
- Offer global shortcuts (⌘⇧Space → quick ask).
- Integrate with macOS Focus modes.
- Manage Hermes installation as a one-click flow ("Install Hermes Agent → routes through OpenClaw").

---

## 3. Pairing flow (cross-app sequence)

```
phone (openclaw-mobile)                Mac mini (openclaw-desktop + gateway)
─────────────────────────────────      ───────────────────────────────────
1. user opens app, first run
2. Bonjour scan finds         ◄────►   3. desktop advertises _openclaw._tcp
   "Jerel's Mac mini"
4. phone hits  POST /pair/request
   { device_name, public_key }   ────► 5. desktop receives request
                                       6. shows code 482915 +
                                          system notification with
                                          [Approve] [Deny]
7. phone polls /pair/status            8. user clicks [Approve] (or runs
                                          `openclaw pairing approve <code>`)
9. phone receives           ◄────────  10. desktop signs token, returns it
   { token, gateway_id,                    + gateway endpoint
     runtime_url }
11. phone stores token in
    expo-secure-store
12. phone connects WSS with token ────► 13. gateway validates, upgrades to
                                            authenticated session
```

This is the same flow whether the user is on LAN (Bonjour) or remote
(Tailscale URL pasted manually).

---

## 4. Shared package: `@openclaw/protocol`

Both repos depend on a shared TypeScript package that owns:

- All WS message types (`PairingRequest`, `PairingApproved`, `ThreadEvent`, `CanvasPatch`, `VoiceFrame`, …).
- Zod schemas for runtime validation at the WS boundary.
- The `GatewayClient` interface (what `plan.md` §7 sketches).
- Token format + signature verification helpers.

Owning this in one place means mobile and desktop can't drift. CI in both
repos pulls the published package; for local dev we use a pnpm workspace
when both repos are checked out side by side.

---

## 5. Protocol surface (provisional)

Until we read the OpenClaw source, this is our best guess at what
`openclaw-desktop` should expose. It maps to the `GatewayClient` interface
on the mobile side.

**HTTP (over the same port):**

- `GET  /healthz` — `{ ok, gateway_id, version }`
- `POST /pair/request` — `{ device_name, public_key } → { code, pair_id, expires_at }`
- `GET  /pair/status?pair_id=…` — polls; returns `{ status: "pending" | "approved" | "denied", token?, runtime_url? }`
- `POST /copilot/runtime` — CopilotKit runtime endpoint (or proxied)

**WebSocket (after pairing, bearer auth):**

- Topics: `threads.*`, `agents.*`, `canvas.*`, `voice.*`, `system.*`
- Frame envelope: `{ id, topic, type, payload, ts }`
- Heartbeat: 30s ping/pong

We'll lock this down when we read the source or PR a spec upstream; for v1
mobile we code against the shared package, never against `fetch` directly.

---

## 6. Cross-repo development workflow

When both repos are checked out:

```
~/code/
  openclaw-mobile/    # this repo (Expo)
  openclaw-desktop/   # Electron app (new repo)
  protocol/           # @openclaw/protocol (shared)
```

A top-level pnpm workspace (or just `pnpm link`) makes `@openclaw/protocol`
changes immediately visible to both. The mobile dev loop:

1. Start `openclaw-desktop` in dev (`pnpm dev` — opens Electron, supervises a dev gateway).
2. Start the Expo dev server (`pnpm start`).
3. Open the app on a real device (or simulator); Bonjour discovers the dev desktop; pair with one tap.

For mobile-only iteration, use the in-app **mock gateway** (see `milestones.md` M0–M1) — it implements the same `GatewayClient` interface without needing the desktop running.

---

## 7. What this means for the mobile repo right now

The mobile plan does not change scope — we're still shipping the Expo app
described in `plan.md` and `milestones.md`. But we should:

- Land the `GatewayClient` interface inside the mobile repo first.
- Extract it into `@openclaw/protocol` once we start the desktop repo.
- Keep all pairing/runtime concerns behind that interface so swapping the mock for the real desktop is a one-line change.

The Electron app is **not** in scope for this repo's first sprint. We design
the mobile app so it cleanly meets the desktop when the desktop arrives.

---

## 8. Open questions specific to the desktop app

Tracked alongside the mobile open questions in `open-questions.md`:

- Does OpenClaw upstream want us to contribute the Electron supervisor back, or is `openclaw-desktop` a separate community project?
- Notarization signing identity (Anthropic team account, a new entity, or the user's own dev cert)?
- Auto-update channel — Squirrel.Mac, electron-updater, or roll our own?
- Where does the per-gateway signing keypair live (Keychain on macOS, presumably)?
- Should the desktop app's chat UI reuse mobile's React Native components (via react-native-web in Electron) or have its own desktop-tailored UI? Default for v1: separate, simpler desktop UI; converge later if it pays off.
