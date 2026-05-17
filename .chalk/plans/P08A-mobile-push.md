# P08A — Mobile push registration

**App:** mobile (`apps/mobile`)
**Estimated effort:** 0.5 day
**Depends on:** P04A
**Blocks:** P08B end-to-end
**Can run in parallel with:** P08B

## Context

Register the device with Expo Notifications, send the resulting token to
the desktop at pairing time (or post-pair), and handle incoming pushes
including deep-links into threads. Per `plan.md` §1 (goals: notifications)
and `desktop-app.md` §2 (desktop drives push fan-out).

## Goal

Phone receives push when an agent pings while the app is backgrounded.
Tapping the notification opens the relevant thread.

## Outputs

- `apps/mobile/src/push/register.ts`
- `apps/mobile/src/push/handler.ts` — receive, route, deep-link.
- Hook into pairing flow: send device token to desktop on first pair + on token refresh.
- iOS + Android entitlements/config.

## Steps

1. `pnpm --filter @openclaw/mobile add expo-notifications`.
2. Configure Expo plugin in `app.config.ts`; add iOS APNs entitlement, Android `POST_NOTIFICATIONS` permission.
3. `register.ts`:
   - Request notification permission.
   - Get Expo push token.
   - POST to desktop `/devices/<id>/push-token`.
   - Re-register on token refresh.
4. `handler.ts`:
   - `Notifications.addNotificationResponseReceivedListener` → parse payload → `router.push('/threads/[id]')`.
   - Foreground notifications: surface as in-app banner instead of system notification.
5. Wire into `PairingProvider`: on `paired` event, call `register()`.
6. Tests:
   - Token registration sends expected POST body.
   - Deep-link router given a payload routes correctly.

## Success criteria

- [ ] On a real device, sending a test push from the desktop (P08B) wakes the phone.
- [ ] Tapping the notification opens the correct thread.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck && test
# Manual: real device + P08B running.
```

## Commit

```
Register mobile device for push notifications via Expo

Request permission on first pair, send Expo push token to desktop,
re-register on refresh, and deep-link into the right thread on
notification tap. Foreground notifications surface as in-app banners.
```

## Notes

- Expo's push service simplifies the iOS APNs / Android FCM split.
- iOS asks for notification permission on first request — wrap it in a screen explaining what notifications are for.
- Web push is out of scope for v1.
- Don't try to launch voice calls from notification taps in v1; deep-link to thread is enough.
