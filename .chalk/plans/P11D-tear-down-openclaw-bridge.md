# P11D — Tear down the P10A OpenClawBridge

**App:** desktop (`apps/desktop`)
**Estimated effort:** 0.5 day
**Depends on:** P11A (clients must already be on clawg-ui)
**Blocks:** P11E (e2e plan uses the post-teardown shape)
**Can run in parallel with:** P11B, P11C

## Context

P11A switched the desktop's real-mode chat path from `OpenClawBridge`
(P10A, in `apps/desktop/src/main/gateway/openclaw-bridge.ts`) to a
direct HTTP/SSE client against the clawg-ui plugin's `/v1/clawg-ui`
endpoint. After P11A, the bridge module is `@deprecated` and not
invoked from `index.ts`, but the files are still in the tree and the
tests still run.

This plan deletes them. The `gateway_mode` setting persists (renamed in
P11A to `"stub" | "clawg-ui"`), as does the keystore facade — clawg-ui's
device token still needs persistence, and stub mode still needs its
config row.

## Goal

After this plan lands:

- `apps/desktop/src/main/gateway/openclaw-bridge.ts` is deleted.
- `apps/desktop/src/main/gateway/openclaw-bridge-handshake.ts` is
  deleted.
- `apps/desktop/src/main/gateway/__tests__/openclaw-bridge.test.ts` is
  deleted.
- `apps/desktop/src/main/gateway/__tests__/openclaw-bridge-handshake.test.ts`
  is deleted.
- `apps/desktop/src/main/gateway/__fixtures__/` — review for bridge-
  specific fixtures and delete those; keep stub-related fixtures.
- All imports of the deleted symbols are removed; the renderer
  Settings UI's "Bridge (deprecated)" radio option (introduced as an
  escape hatch in P11A) is removed.
- `gateway_mode` enum is now `"stub" | "clawg-ui"` only. The migration
  helper that mapped `"real"` → `"clawg-ui"` (P11A) stays, since users
  may still have stored `"real"` in their settings.
- The bridge identity (Ed25519 keypair persisted by
  `loadOrCreateBridgeIdentity` in P10A) is wiped from the keystore
  namespace if present, since nothing else references it. The clawg-ui
  identity store (P11A) is unaffected.
- Existing stub-mode tests stay green. New tests cover the keystore
  migration (old bridge identity gets removed cleanly).

## Inputs

- P11A's commit — confirm bridge is unreferenced from `index.ts`.
- `apps/desktop/src/main/pair/keystore.ts` — locate the namespace the
  bridge wrote its identity under (per `openclaw-bridge-handshake.ts`).
- `apps/desktop/src/main/settings.ts` — for the second narrowing of
  `GatewayMode`.

## Outputs

Deleted files:

- `apps/desktop/src/main/gateway/openclaw-bridge.ts` (737 lines).
- `apps/desktop/src/main/gateway/openclaw-bridge-handshake.ts`
  (412 lines).
- `apps/desktop/src/main/gateway/__tests__/openclaw-bridge.test.ts`.
- `apps/desktop/src/main/gateway/__tests__/openclaw-bridge-handshake.test.ts`.
- Any bridge-specific entries under
  `apps/desktop/src/main/gateway/__fixtures__/`.

New files:

- `apps/desktop/src/main/clawg-ui/__tests__/keystore-migration.test.ts`
  — assert that on first boot after upgrade, a pre-existing
  `bridgeIdentity` entry is removed.

Edited files:

- `apps/desktop/src/main/settings.ts` — narrow `GatewayMode` to
  `'stub' | 'clawg-ui'`; keep the `'real'` → `'clawg-ui'` coercion.
  Remove any reference to "bridge" mode.
- `apps/desktop/src/main/index.ts` — remove the deprecated import +
  any leftover branches.
- `apps/desktop/src/renderer/.../Settings.tsx` — remove the "Bridge
  (deprecated)" radio option.
- `apps/desktop/src/main/clawg-ui/identity.ts` — on first construction
  per boot, call `keystore.delete('bridgeIdentity')` (no-op if absent).

## Steps

1. **Confirm preconditions.** Grep:
   ```sh
   git grep -n 'openclaw-bridge\|attachOpenClawBridge\|OpenClawBridge\|BridgeIdentity\|HandshakeTransport' apps/
   ```
   Expect: zero hits outside the files we're about to delete. If any
   hit remains in `apps/desktop/src/main/index.ts` or the renderer,
   stop and fix it first.
2. **Delete the files** listed in §Outputs.
3. **Narrow the enum.** Update `apps/desktop/src/main/settings.ts`'s
   `GatewayMode` to `'stub' | 'clawg-ui'`. Drop any "bridge" string.
   Keep the `'real'` coercion (legacy migration). Update the unit
   tests.
4. **Renderer cleanup.** Remove the "Bridge (deprecated)" option from
   Settings.tsx. Re-test the radio defaults.
5. **Keystore cleanup.** In `apps/desktop/src/main/clawg-ui/identity.ts`,
   add a one-shot migration: on first construction per process,
   delete the legacy `bridgeIdentity` key from the keystore. Add a
   test using the in-memory keystore stub.
6. **Run baseline.** Expect `pnpm -r typecheck` to flag any missed
   import; fix and re-run.
7. **Commit.**

## Success criteria

- `git grep -rn 'OpenClawBridge\|openclaw-bridge' apps/ packages/` →
  zero hits.
- `pnpm install && pnpm --filter @openclaw/protocol build && pnpm
  format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
  all exit 0.
- The `gateway_mode` setting accepts exactly `'stub'` and `'clawg-ui'`
  (verified by a test).
- An existing `userData/keystore.{enc,json}` containing a
  `bridgeIdentity` entry has it removed on next boot (verified by a
  test that pre-populates the in-memory keystore, instantiates the
  identity store, then asserts absence).

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test

# spot-check
git grep -n 'OpenClawBridge\|openclaw-bridge\|BridgeIdentity' apps/ packages/ || echo "clean"
```

## Commit

Single commit:

```
Remove the P10A OpenClawBridge (P11D)

Delete openclaw-bridge.ts (737 LOC) + openclaw-bridge-handshake.ts
(412 LOC) + their tests + fixtures. gateway_mode narrows to
"stub" | "clawg-ui"; the legacy "real" value still coerces to
"clawg-ui". Wipe the legacy bridgeIdentity entry from the keystore
on first boot post-upgrade.
```

## Notes

- Anti-pattern: do not delete `apps/desktop/src/main/gateway/stub.ts`
  — stub mode is alive and well, and the P05C in-process adapter
  still uses it for hermetic dev.
- Anti-pattern: do not move bridge files to `__fixtures__/` as a
  half-step. Once tests are clawg-ui-based (P11E), the bridge is
  dead weight; delete cleanly.
- Anti-pattern: do not amend P11A's commit to fold this in. Two
  commits keep `git log` legible — "P11A flips clients to clawg-ui"
  and "P11D removes the now-dead bridge" are separate stories.
- If `git grep` in step 1 turns up references in `docs/` or
  `README.md`, update those too (in the same commit if trivial; else
  punt to a follow-up doc plan).
