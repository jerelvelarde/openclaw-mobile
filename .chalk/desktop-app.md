# apps/desktop — the Electron companion

We're following the **Claude pattern**: a desktop app that lives on the user's
always-on Mac (mini or MacBook) + a mobile app that pairs with it. This
document specifies the desktop app's responsibilities and the contract it
exposes to `apps/mobile`.

Both apps live in this monorepo:

```
apps/
  mobile/      # Expo / React Native — what the phone runs
  desktop/     # Electron — what the always-on Mac runs
packages/
  protocol/    # @openclaw/protocol — shared types/schemas/GatewayClient
```

Keeping them in one repo (vs. siblings) buys:

- One PR can change the wire format on both sides atomically.
- `@openclaw/protocol` is consumed via pnpm `workspace:*` — no publish cycle for protocol churn during early dev.
- Shared CI, shared lint config, single dependency lockfile.
- Easier code review for cross-app changes.

Costs we accept:

- Electron-specific deps live in the same lockfile as RN deps (mitigated by pnpm's isolated `node_modules`).
- CI matrix has to cover both apps.
- The repo name `openclaw-mobile` is now slightly misleading — flagged for renaming in `open-questions.md`.

---

## 1. Why we need it (not just the openclaw CLI)

The raw OpenClaw CLI + launchd daemon works, but it's not a product
experience. The Electron app turns it into one:

| Need                                       | CLI alone               | With apps/desktop                         |
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
phone (openclaw-mobile)                Mac mini (apps/desktop + gateway)
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

Both apps depend on `packages/protocol` (`@openclaw/protocol`), which owns:

- All WS message types (`PairingRequest`, `PairingApproved`, `ThreadEvent`, `CanvasPatch`, `VoiceFrame`, …).
- Zod schemas for runtime validation at the WS boundary.
- The `GatewayClient` interface (what `plan.md` §7 sketches).
- Token format + signature verification helpers.
- An in-memory mock gateway used by both apps in dev and tests.

Owning this in one workspace package means mobile and desktop can't drift.
Apps reference it via `"@openclaw/protocol": "workspace:*"` so protocol
changes are picked up instantly without a publish cycle. If we later need
external consumers we publish from this same package.

---

## 5. Protocol surface (provisional)

Until we read the OpenClaw source, this is our best guess at what
`apps/desktop` should expose. It maps to the `GatewayClient` interface
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

## 6. Monorepo development workflow

Single checkout, single install:

```
openclaw-mobile/             # repo root
├── apps/
│   ├── mobile/              # Expo
│   └── desktop/             # Electron
└── packages/
    └── protocol/            # @openclaw/protocol
```

Top-level scripts (see master-plan.md and plan P0):

- `pnpm install` — installs everything.
- `pnpm --filter desktop dev` — runs Electron with a supervised dev gateway.
- `pnpm --filter mobile start` — Expo dev server.
- `pnpm -r typecheck` / `pnpm -r test` — across all workspaces.

The mobile dev loop:

1. `pnpm --filter desktop dev` — opens the Electron app.
2. `pnpm --filter mobile start` — Expo dev server.
3. Open the app on a device or simulator; Bonjour discovers the dev desktop; pair with one tap (you click "Approve" in the Electron window).

For mobile-only iteration, use the in-app **mock gateway** from
`packages/protocol` — it implements the same `GatewayClient` interface without
needing the desktop running.

---

## 7. What this means for the mobile repo right now

The mobile plan does not change scope — we're still shipping the Expo app
described in `plan.md` and broken down in `master-plan.md` + `plans/`. But we should:

- Land the `GatewayClient` interface inside the mobile repo first.
- Extract it into `@openclaw/protocol` once we start the desktop repo.
- Keep all pairing/runtime concerns behind that interface so swapping the mock for the real desktop is a one-line change.

The Electron app is **not** in scope for this repo's first sprint. We design
the mobile app so it cleanly meets the desktop when the desktop arrives.

---

## 8. Open questions specific to the desktop app

Tracked alongside the mobile open questions in `open-questions.md`:

- Does OpenClaw upstream want us to contribute the Electron supervisor back, or is `apps/desktop` a separate community project?
- Notarization signing identity (Anthropic team account, a new entity, or the user's own dev cert)?
- Auto-update channel — Squirrel.Mac, electron-updater, or roll our own?
- Where does the per-gateway signing keypair live (Keychain on macOS, presumably)?
- Should the desktop app's chat UI reuse mobile's React Native components (via react-native-web in Electron) or have its own desktop-tailored UI? Default for v1: separate, simpler desktop UI; converge later if it pays off.
