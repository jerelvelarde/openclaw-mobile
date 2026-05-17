# Voice v1

`@openclaw/protocol`'s voice module defines the wire shapes the mobile and
desktop clients use to talk to an OpenClaw agent over audio. Like `Canvas`,
the schema is intentionally small (one options shape, one signaling shape,
one frame shape, one transcript shape) so transports stay implementable in
an afternoon and agent authors can hand-emit valid payloads.

All shapes are exported from `@openclaw/protocol`. Use the Zod schemas
(`VoiceOptsSchema`, `VoiceSignalSchema`, `VoiceFrameSchema`,
`VoiceTranscriptSchema`) at the WS / WebRTC boundary; use the plain TS
interfaces inside renderers and agent code.

## Decision: WebRTC for v1, WS-frames as fallback

We picked **WebRTC** as the primary voice transport. Rationale:

- **The host is always a Mac.** `host-target.md` locks v1 to an always-on
  Apple Silicon Mac running the gateway. macOS has a stable, well-supported
  WebRTC implementation, so the host can act as a competent peer.
- **Latency matters for natural voice.** A WebRTC peer connection gives us
  sub-100ms end-to-end audio over the LAN. Buffered, length-prefixed audio
  over a WebSocket would add hundreds of ms of head-of-line delay before we
  even start tuning jitter buffers.
- **iOS background audio has a clearer path.** Voice while the app is
  backgrounded is out of scope for v1, but `CallKit` + `PushKit` interop is
  a documented WebRTC story. WS-frames in a background RN process is not.
- **Expo prebuild is already required.** We prebuild after P04A, so the
  "needs a custom dev client / native modules" cost is already paid.

WS-frames remain in the protocol as a **per-call fallback** for environments
where WebRTC signaling or media fails (corporate firewalls, strict NATs,
broken TURN). The client decides which path to use after the signaling
exchange; the agent doesn't care which transport delivered the bytes.

The decision can be revisited if WebRTC quality on real iOS hardware
disappoints, or if we discover the fallback is exercised more often than
expected in production. Until then, P07A/P07B target WebRTC first.

## Wire shapes

### `VoiceOpts`

Caller options for opening a voice session.

```ts
{ agentId: "openclaw.default", format: "opus", sampleRate: 48000 }
```

- `agentId` — routing target. Mirrors `Agent.id`.
- `format` — `"opus"` or `"pcm16"`. Opus for production; PCM16 for tests
  and short turns where transcoding overhead matters more than bandwidth.
- `sampleRate` — Hz. Typical values: 16 000 (PCM16 narrowband), 48 000
  (Opus wideband). The agent is expected to decode at this rate or the
  gateway transcodes.

### `VoiceSignal` (WebRTC)

```ts
{ type: "offer",  sdp: "v=0\r\n…" }
{ type: "answer", sdp: "v=0\r\n…" }
{ type: "ice",    candidate: "candidate:1 1 UDP 2122194687 …" }
```

One frame in the WebRTC handshake. `type` discriminates; `sdp` carries
session descriptions; `candidate` carries one ICE candidate (empty string
or omitted = end-of-candidates). Either peer may emit any type — both sides
send `ice` candidates as they're discovered.

### `VoiceFrame` (WS-frames fallback)

```ts
{ seq: 0, data: Uint8Array([…]) }
```

One audio frame. `seq` is monotonic per session; receivers MAY drop frames
with `seq < lastSeen`. `data` is the encoded payload (Opus packet or
interleaved PCM16 samples — agreed via the surrounding `VoiceOpts.format`).
Timing is implicit from `sampleRate` + frame size; we can add explicit
timestamps in a future schema version.

### `VoiceTranscript`

```ts
{ text: "Hello world", isFinal: true, ts: 1730000000000 }
```

Live transcript fragment from the agent. `isFinal: false` is an interim
hypothesis (renderers show it as "ghost" text); `isFinal: true` is the
committed text. Multiple finals concatenate to form the running transcript.

## Topics

All voice messages flow inside the standard envelope on three sub-topics:

| Topic                          | Payload shape     | Transport hint            |
| ------------------------------ | ----------------- | ------------------------- |
| `voice.<sessionId>.signal`     | `VoiceSignal`     | JSON over WS              |
| `voice.<sessionId>.frame`      | `VoiceFrame`      | Binary WS (fallback only) |
| `voice.<sessionId>.transcript` | `VoiceTranscript` | JSON over WS              |

Use the `voiceTopics` helper (`voiceTopics.signal(id)` etc.) so the naming
stays centralized. The envelope (`{ id, topic, type, payload, ts }`) is
the same one used for chat and Canvas — see `envelope.ts`.

## WebRTC sequence (happy path)

```
client (mobile/desktop)        gateway              agent
        │                         │                   │
        │  openVoice(opts)        │                   │
        │────────────────────────►│                   │
        │                         │  spawn session    │
        │                         │──────────────────►│
        │                         │                   │
        │  signal: offer (sdp)    │                   │
        │────────────────────────►│──────────────────►│
        │                         │                   │
        │                         │  signal: answer   │
        │◄────────────────────────│◄──────────────────│
        │                         │                   │
        │  signal: ice (×N)       │                   │
        │◄──────── relay ────────►│                   │
        │                         │                   │
        │ ════ RTP audio (peer-to-peer / via SFU) ═══►│
        │                         │                   │
        │                         │     transcript    │
        │◄────────────────────────│◄──────────────────│
        │                         │  (interim/final)  │
        │                         │                   │
        │  close()                │                   │
        │────────────────────────►│  teardown ───────►│
```

The gateway is a **signaling relay**, not a media peer. Audio flows on the
WebRTC peer connection (LAN-direct when possible, otherwise via a STUN/TURN
server we'll stand up alongside the gateway in P07A).

## WS-frames fallback flow

If WebRTC fails to establish (ICE timeout, no relay reachable, peer
unsupported), the client falls back to sending audio frames over the
existing WebSocket connection:

```
client            gateway            agent
  │  openVoice      │                  │
  │────────────────►│ spawn session ──►│
  │                 │                  │
  │  frame (seq 0)  │                  │
  │────────────────►│─────────────────►│
  │  frame (seq 1)  │                  │
  │────────────────►│─────────────────►│
  │       …         │                  │
  │                 │   transcript     │
  │◄────────────────│◄─────────────────│
  │                 │                  │
  │  close()        │                  │
  │────────────────►│  teardown ──────►│
```

Frames are binary WS messages; the envelope's `type` is `"voice.frame"` and
the `payload` is a `VoiceFrame`. Drop detection is `seq`-based.

## Notes for agent authors

- Treat `VoiceSignal` as opaque — your agent process gets SDP and ICE; the
  P07B agent runtime wires them into the local `RTCPeerConnection`. You
  don't parse SDP yourself.
- Emit `VoiceTranscript` early and often: a tight stream of `isFinal:false`
  fragments is what makes voice feel responsive. The client merges them.
- Don't assume Opus — check `VoiceOpts.format`. PCM16 is a valid request
  for short utterances; transcoding adds latency you may not want.
- `close()` is a contract, not a request. When you receive a session
  teardown, stop emitting transcripts immediately; the client has already
  torn down its peer.
