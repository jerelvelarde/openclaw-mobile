# P07B — Desktop voice routing

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1.5 days
**Depends on:** P07.0
**Blocks:** —
**Can run in parallel with:** P07A

## Context

The desktop sits between the phone (WebRTC peer) and the active agent. It
either:
- Acts as a SFU-lite forwarder (phone ↔ desktop WebRTC; desktop sends frames to the agent over the gateway protocol).
- Or runs the agent in-process and bridges audio directly.

For v1, the desktop is the WebRTC peer endpoint; it forwards audio frames
to the agent via the gateway's voice topics and streams transcripts and
agent reply audio back.

## Goal

Phone holds-to-talk → desktop receives WebRTC audio → forwards to active
agent → receives agent reply audio + transcript → streams back to phone.

## Outputs

- `apps/desktop/src/main/voice/peer.ts` — `RTCPeerConnection` per session.
- `apps/desktop/src/main/voice/router.ts` — voice topic dispatch.
- `apps/desktop/src/main/voice/agentBridge.ts` — translates frames ↔ gateway/agent.
- Tests covering signaling round-trip + frame forwarding.

## Steps

1. `pnpm --filter @openclaw/desktop add wrtc`. (Or `@roamhq/wrtc`; pin whichever is currently maintained.)
2. `peer.ts`:
   - Per `voice.<sessionId>` topic, create a `RTCPeerConnection`.
   - Handle offer/answer/ICE per P07.0 signaling.
   - Receive audio tracks; pipe frames to `agentBridge`.
3. `agentBridge.ts`:
   - Forward inbound frames to gateway under `voice.<sessionId>.frame` (if the agent prefers frames) or via the agent's own audio entry point.
   - Subscribe to agent's reply transcript/audio and route back over the WebRTC track or `voice.<sessionId>.transcript`.
4. `router.ts`:
   - Maintain session lifecycle: create on first signaling msg, destroy on close.
5. Update `apps/desktop/src/main/gateway/stub.ts`:
   - Stub agent emits a pre-recorded reply audio clip + transcript so end-to-end voice can be tested without a real agent.
6. Tests:
   - Signaling: offer → answer flow with a mock peer.
   - Frame forwarding: bytes in, same bytes out via the mocked agent bridge.

## Success criteria

- [ ] Phone (P07A) successfully completes a voice turn against desktop stub.
- [ ] Transcripts arrive at the phone.
- [ ] Reply audio plays back on the phone.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
# Manual end-to-end with P07A on a real device.
```

## Commit

```
Route voice between phone WebRTC peer and active agent

Per-session RTCPeerConnection in main process, agent bridge that
forwards frames to/from the gateway under voice.<sessionId>.* topics,
and a session lifecycle router. Stub agent now emits a canned reply
clip so the full PTT loop is testable end-to-end.
```

## Notes

- `wrtc` ships native binaries. Confirm electron-builder rebuilds them for the target Electron version.
- Real agent integration is out of scope here — the stub provides the canned reply.
- If `wrtc` is unstable on Apple Silicon, fall back to spawning a tiny native WebRTC subprocess (e.g. a Rust helper) — but only after the JS path is shown not to work.
- Don't add voice activity detection on the desktop side; that's the phone's job (and stretch for v1).
