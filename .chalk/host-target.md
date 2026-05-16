# Host target — Mac mini (always-on)

This app is designed against one concrete host shape: a **Mac mini (or any
always-on Apple Silicon Mac) sitting at home**, running the
**`openclaw-desktop`** Electron companion (which supervises the OpenClaw
gateway daemon) 24/7. See `desktop-app.md` for the desktop app's contract.

Other hosts (Linux servers, work laptops, Windows/WSL2) should still work
in CLI-only mode — they're just not what we optimize for in v1.

Locking the v1 host target lets us make decisions instead of leaving them
"configurable":

- We can lean on **Bonjour/mDNS** for `*.local` LAN discovery (Apple platforms make this trivial).
- We can lean on **launchd** as the daemon manager and assume the gateway is always running.
- We can lean on **Tailscale's Mac client** as the recommended remote-access path.
- We can assume the host can act as a **WebRTC peer** for voice (macOS has stable WebRTC implementations).
- We can assume **AC power** and treat the host as always reachable — failures are network failures, not "the host went to sleep" failures (we tell users to disable sleep).

---

## Host profile (the assumption the app is built against)

| Attribute              | Assumed value                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Hardware               | Mac mini (Apple Silicon), or equivalent always-on Mac                                  |
| OS                     | macOS 14+ (Sonoma) — for current launchd/Bonjour/Network framework behavior            |
| Power                  | Wall power; **system sleep disabled** (display sleep is fine)                          |
| Network                | Wired or stable Wi-Fi; static or DHCP-reserved local IP                                |
| Reachable hostname     | `openclaw.local` (Bonjour) on LAN; Tailscale MagicDNS name remotely                    |
| Daemon                 | `openclaw gateway --port 18789` installed via `openclaw onboard --install-daemon`      |
| Helper app             | Optional menu-bar app (OpenClaw ships one) for pairing approvals & status              |
| Agents                 | At least one OpenClaw skill; optionally `hermes-agent` installed alongside             |
| Remote-access overlay  | **Tailscale** (recommended). Alternatives: Cloudflare Tunnel, ngrok, self-hosted VPN.  |

The app must **detect** which of these are present rather than require all
of them, but the design language is "Mac mini at home".

---

## How the app meets the host (transport priority)

1. **Bonjour discovery on LAN.** On launch and on network change, the app
   browses for `_openclaw._tcp.local.` (service name we'll register on the
   host). If exactly one is found, pre-fill it. If multiple, show a picker.
2. **Saved hostname** (from previous pairing). After pairing, we store the
   hostname the user actually used (`openclaw.local`, a Tailscale name, or a
   custom hostname). On reconnect we try that first.
3. **Tailscale name.** If the user enables "remote access" during onboarding,
   we ask for their Mac mini's Tailscale name (we don't auto-discover it —
   that requires the Tailscale client on the phone to be authenticated).
4. **Manual URL.** Bottom of the connect screen always allows pasting a
   `ws(s)://…` URL for edge cases (Cloudflare Tunnel, ngrok, custom proxy).

The transport layer underneath `GatewayClient` (see `plan.md` §7) is the same
in all four cases — only the URL differs.

---

## Host-side setup (what we ask the user to do — once)

The recommended path is to install **`openclaw-desktop`** (Electron app — see
`desktop-app.md`) on the Mac mini. It supervises the gateway, handles
pairing approvals via a native macOS notification, and surfaces health in
the menu bar.

1. Install `openclaw-desktop` from the signed `.dmg` and launch it; it will install/start the gateway daemon on first run.
2. **Disable system sleep:** System Settings → Energy → "Prevent automatic sleeping when the display is off" (or `sudo pmset -a sleep 0 disablesleep 1` for headless). The desktop app nudges the user about this on first run.
3. Reserve a DHCP IP for the Mac mini (router-side) so the Bonjour name stays stable.
4. (Optional, recommended for remote use) Install Tailscale, sign in, note the MagicDNS name (e.g. `mini.tailnet-name.ts.net`). The desktop app has a one-screen helper for this.
5. (Optional) Install Hermes per its README; the desktop app's Agents panel will pick it up automatically.

CLI-only fallback (no desktop app): `openclaw onboard --install-daemon`, then
approve pairings with `openclaw pairing approve mobile <code>`.

The mobile app shows a "Host checklist" on the Settings screen so users can
self-diagnose ("Bonjour OK · Daemon OK · Tailscale not detected · Desktop
app v1.2 installed").

---

## Implications for the app

### Onboarding

- **Local-first onboarding.** The app's first screen assumes the user is on
  the same Wi-Fi as the Mac mini for initial pairing. Cellular-first remote
  pairing is supported but de-emphasized (more failure modes, harder error
  recovery).
- **One pairing covers all networks.** The pairing token is bound to the
  device, not the network. Once paired on Wi-Fi, the same token works over
  Tailscale or any other reachable URL.

### Connection state

- **"Always reachable" is the default narrative.** A disconnected banner
  reads "Can't reach your Mac mini" not "Server offline" — it implies the
  network, not the agent.
- **Aggressive reconnect.** Because the gateway is always-on, "no answer for
  10s" almost always means a network glitch. We reconnect fast, with jitter
  bounded at 30s.

### Push notifications

- The Mac mini, being always-on, **drives push from the host side**. The
  gateway holds APNs/FCM credentials (provided by us) and pushes when an
  agent needs the user. The phone does not poll. This works specifically
  because we can assume the host is up.

### Voice

- WebRTC is on the table for v1 specifically because a Mac mini can be a
  stable, low-latency peer. (For an intermittently online host, we'd fall
  back to frames-over-WS.)

### Multi-device

- Multiple Macs are stretch. v1 = one gateway per user. The app does
  support pairing additional phones/tablets/web sessions to the same Mac
  mini — they all show up in the host's "paired devices" list.

---

## Anti-goals for v1 (deliberate, not oversights)

- **No iCloud / Apple ID linkage.** Pairing is local; nothing leaves the LAN unless the user opts into Tailscale or similar.
- **No "host on the phone" mode.** Even though iOS could technically run a tiny gateway, we don't ship one.
- **No host-side installer from the app.** We don't auto-install OpenClaw or Hermes on the Mac mini.
- **No remote control of the Mac mini itself.** This is not a Screens / VNC replacement. We only speak to the gateway.

---

## When the host shape changes

If a user runs OpenClaw on, say, a Linux NUC instead of a Mac mini, the app
should still work because we never hardcode "macOS" anywhere — we just
prefer Bonjour and assume always-on. The behaviors that degrade gracefully:

- Bonjour: many Linux setups run Avahi and broadcast on `.local` just fine. If not, the user pastes a URL.
- launchd: irrelevant from the app's perspective — we just need the gateway running. systemd works the same way for us.
- Menu-bar app: optional; pairing also works via the CLI.
- Tailscale: cross-platform; same UX.

So "designed for Mac mini" is a tightening, not a lock-out.
