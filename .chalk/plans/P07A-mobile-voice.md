# P07A — Mobile voice capture + playback

**App:** mobile (`apps/mobile`)
**Estimated effort:** 2.5 days
**Depends on:** P07.0
**Blocks:** —
**Can run in parallel with:** P07B

## Context

Push-to-talk voice on the phone, routed through the desktop to the active
agent. WebRTC peer to the desktop (per P07.0). Per `plan.md` §5 (`voice.tsx`).

## Goal

Open `voice.tsx`, hold the big button → speak → agent transcribes + replies
in voice. Tap release → reply plays through phone speaker. Live transcript
visible. Works on iOS, Android, and Web.

## Outputs

- `apps/mobile/app/(tabs)/voice.tsx`
- `apps/mobile/src/voice/usePushToTalk.ts`
- `apps/mobile/src/voice/webrtc.ts` — peer setup, signaling via gateway WS.
- `apps/mobile/src/voice/permissions.ts` — mic permission flow.
- Background audio entitlements wired (iOS `Info.plist`, Android `AndroidManifest`).
- Tests for state machine + signaling round-trip.

## Steps

1. `pnpm --filter @openclaw/mobile add react-native-webrtc`. Configure as Expo plugin; document custom dev client requirement.
2. `permissions.ts` — request mic permission with friendly rationale; persist denial state.
3. `webrtc.ts`:
   - Open `RTCPeerConnection` against TURN-less local network for v1 (Mac mini on same LAN).
   - Use gateway WS as signaling channel (topics `voice.<sessionId>.signal` per P07.0).
   - Add ICE candidate trickle.
4. `usePushToTalk.ts`:
   - State machine: `idle → arming → listening → sending → receiving → idle`.
   - Hold → start sending audio; release → stop.
   - Exposes transcript stream from `voice.<sessionId>.transcript`.
5. `voice.tsx`:
   - Full-screen layout: waveform, big PTT button, live transcript, agent-reply caption.
   - Interruption: tap during agent playback cancels and starts a new turn.
6. Background audio:
   - iOS: `UIBackgroundModes: ["audio"]` in `Info.plist`.
   - Android: foreground service for active call (or accept "kills on background" for v1).
7. Tests:
   - State machine transitions.
   - Signaling round-trip with a mocked gateway.

## Success criteria

- [ ] Hold-to-talk yields a streamed agent reply with audio playback on iOS + Android.
- [ ] Live transcript appears as you speak (assuming the agent emits transcripts).
- [ ] Works against the desktop's stub gateway by playing back a pre-recorded reply audio file.
- [ ] All tests pass.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
# Manual: device required for mic.
```

## Commit

```
Add push-to-talk voice on mobile via WebRTC peer to desktop

Mic capture via react-native-webrtc, signaling over gateway WS,
live-transcript display, and audio playback for agent replies.
voice.tsx hosts the PTT UI. Background audio entitlement wired for
iOS; Android uses a foreground service stub.
```

## Notes

- `react-native-webrtc` requires a **custom dev client**. We crossed that bridge in P04A; confirm here.
- TURN servers aren't needed for LAN. If we add remote-via-Tailscale voice later, evaluate STUN/TURN then.
- Web support for `react-native-webrtc` is partial; on web we can fall back to browser-native `RTCPeerConnection` via a tiny shim — but only if it falls out easily. Otherwise web voice is stretch.
- iOS interruption handling (incoming phone call, etc.) — handle at minimum by pausing/stopping the session; full CallKit integration is post-v1.
- Don't optimize codec choice in this plan. Default to Opus at 16kHz mono.
