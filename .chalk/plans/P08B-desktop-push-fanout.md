# P08B — Desktop push fan-out

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1 day
**Depends on:** P04B, P08A (for token registration endpoint to be exercised)
**Blocks:** —
**Can run in parallel with:** P08A

## Context

The desktop is always-on, so it's the right place to fan out push
notifications to paired mobile devices. Use Expo's push service (matches
mobile's setup in P08A) to avoid managing APNs/FCM credentials directly
for v1. Per `desktop-app.md` §2.

## Goal

When the gateway emits an event that warrants notifying a user (agent
needs input, long task finished, agent requests voice), the desktop calls
Expo's push API to deliver a notification to each paired mobile device,
with a deep-link payload.

## Outputs

- `apps/desktop/src/main/push/expoClient.ts` — minimal Expo push API client.
- `apps/desktop/src/main/push/dispatch.ts` — translates gateway events to push payloads.
- `apps/desktop/src/main/push/devices.ts` — extends device store from P03B with push tokens.
- `POST /devices/:id/push-token` route in pairing server.
- Tests.

## Steps

1. `pnpm --filter @openclaw/desktop add expo-server-sdk`.
2. `devices.ts`:
   - Extend `addDevice` / `listDevices` to include `pushToken?: string`, `pushPlatform?: "ios" | "android"`.
   - `setPushToken(deviceId, token)`.
3. `expoClient.ts`:
   - Thin wrapper around `expo-server-sdk`'s `Expo` class.
   - `sendNotification({ token, title, body, data })`.
   - Handle Expo's chunking and receipt polling (best-effort for v1).
4. `dispatch.ts`:
   - Subscribe to gateway events that warrant notifications.
   - For each event, look up paired devices with push tokens, build a payload, send.
   - Throttle: max 1 notification per thread per 30s to avoid spam.
5. Add `POST /devices/:id/push-token` in `pair/server.ts`:
   - Auth: bearer token, same as WS.
   - Body: `{ token, platform }`.
   - Persist via `devices.setPushToken`.
6. Tests:
   - Token persistence round-trip.
   - Dispatch: gateway event → expected Expo payload.
   - Throttle behavior.

## Success criteria

- [ ] Mobile (P08A) registers a token; desktop persists it.
- [ ] Triggering an "agent finished" event on the desktop sends a real push to the registered device.
- [ ] Throttle prevents spam in a tight loop.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck && test
# Manual: pair a phone (P03B + P04B + P08A), trigger a stub event, observe push.
```

## Commit

```
Fan out push notifications from desktop via Expo push service

Persist push tokens per paired device; dispatch gateway events into
Expo notifications with deep-link payloads. Throttled per-thread to
avoid spam. /devices/:id/push-token route registers tokens during the
pairing post-step.
```

## Notes

- Using Expo's push service avoids us needing our own APNs cert / FCM service account in v1. We can move to direct APNs/FCM later.
- Receipts: Expo recommends polling for delivery receipts after sending; minimum-viable v1 can fire-and-forget and log failures.
- Don't notify on every chat message — only on events that warrant attention. Tune the trigger list in `dispatch.ts`.
- Make the throttle configurable per user preference later (out of v1 scope).
