# P03A — Mobile pairing UI (against mock)

**App:** mobile (`apps/mobile`)
**Estimated effort:** 1 day
**Depends on:** P02A
**Blocks:** P04A
**Can run in parallel with:** P03B, P02B (already complete by this wave)

## Context

Build the three-screen pairing flow against the in-memory mock gateway from
`@openclaw/protocol`. No real network yet — Bonjour + WS land in P04A.
Behavior should mirror what `plan.md` §5 and `desktop-app.md` §3 specify.

## Goal

A user opens the app, walks through `welcome → discover → code`, and
arrives at the paired tabs root. Pairing token persists in
`expo-secure-store`. Re-launching the app skips pairing if the token is
still valid. A dev-only "approve" button advances the mock from pending to
approved (since there's no real desktop yet).

## Inputs

- P02A complete.
- `@openclaw/protocol` exports `InMemoryMockGateway` with `requestPairing`, `awaitPaired`, and a test-only `_approvePairing(code)`.

## Outputs

- `apps/mobile/app/(pairing)/welcome.tsx`
- `apps/mobile/app/(pairing)/discover.tsx`
- `apps/mobile/app/(pairing)/code.tsx`
- `apps/mobile/src/pairing/PairingProvider.tsx` (React context)
- `apps/mobile/src/pairing/store.ts` (token persistence via expo-secure-store)
- `apps/mobile/src/pairing/state.ts` (XState or reducer for the pairing state machine)
- `apps/mobile/app/_layout.tsx` routes between `(pairing)` and `(tabs)` based on paired state.
- Unit tests for the pairing reducer + token store.

## Steps

1. `cd apps/mobile && pnpm add expo-secure-store`.
2. Implement `src/pairing/store.ts`:
   - `savePairingToken(token: Token): Promise<void>`
   - `loadPairingToken(): Promise<Token | null>`
   - `clearPairingToken(): Promise<void>`
   - Uses `SecureStore` on native, `localStorage` on web (gate via `Platform.OS`).
3. Implement `src/pairing/state.ts` as a reducer:
   - States: `idle | discovering | requesting | awaiting_approval | paired | error`.
   - Events: `START`, `HOST_SELECTED`, `CODE_ISSUED`, `APPROVED`, `FAILED`, `RESET`.
4. Implement `src/pairing/PairingProvider.tsx`:
   - Holds reducer state and the active `GatewayClient` (mock for now).
   - Exposes `usePairing()` hook returning `{ state, dispatch, code, error }`.
   - On mount: load token; if present, set state to `paired` and skip pairing screens.
5. `app/_layout.tsx`:
   - Wrap in `<PairingProvider>`.
   - `<Stack.Screen>` redirects to `(tabs)` when `state === "paired"`, else `(pairing)`.
6. `app/(pairing)/welcome.tsx`:
   - Headline + paragraph explaining what's about to happen.
   - "Continue" button → `router.push("(pairing)/discover")`.
7. `app/(pairing)/discover.tsx`:
   - For P03A: hardcode a single "Mock Mac mini" entry from the mock gateway.
   - Tapping it dispatches `HOST_SELECTED` and calls `requestPairing({ deviceName: Device.modelName })`.
   - On code issued, `router.push("(pairing)/code")`.
   - Show a "paste URL" field below; non-functional for now (lands in P04A).
8. `app/(pairing)/code.tsx`:
   - Big 6-digit code display.
   - "Waiting for approval…" spinner.
   - Dev-only button "Simulate approval" calls `mock._approvePairing(code)`.
   - On approval, save token, transition to `paired`, navigate to `(tabs)`.
9. Tests:
   - `src/pairing/__tests__/state.test.ts` — reducer transitions.
   - `src/pairing/__tests__/store.test.ts` — save/load/clear round-trip.

## Success criteria

- [ ] Fresh install lands on welcome screen.
- [ ] Walking through welcome → discover → code → tap "Simulate approval" → arrives in tabs.
- [ ] Killing and relaunching skips pairing (token loaded from secure store).
- [ ] "Settings → Re-pair" (add a stub button somewhere) clears the token and returns to welcome.
- [ ] `pnpm --filter @openclaw/mobile typecheck && test` exits 0.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
pnpm --filter @openclaw/mobile start --web --non-interactive   # manual click-through
```

## Commit

```
Add mobile pairing flow against the in-memory mock gateway

Implement welcome / discover / code screens, a reducer-backed pairing
state machine, expo-secure-store token persistence, and a
PairingProvider that gates the tabs root behind a valid pairing token.
Dev-only "simulate approval" button stands in for the real desktop
approval that lands in P03B.
```

## Notes

- The "discover" screen here shows a single hardcoded mock host. Real Bonjour browse is P04A — don't try to install `react-native-zeroconf` in this plan; it requires a custom dev client.
- expo-secure-store doesn't exist on web. Fall back to `localStorage` with a short comment noting this is intentional (security guarantees on web are weaker; we accept that for v1).
- Do **not** add WS/HTTP code here. Everything routes through the mock.
- If you need a state machine library, prefer `useReducer` for v1; only reach for XState if the transitions get unwieldy.
- Keep styling minimal — design polish is P09's job.
