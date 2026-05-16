# P02A — Mobile app skeleton (Expo)

**App:** mobile (`apps/mobile`)
**Estimated effort:** 0.5 day
**Depends on:** P00, P01A
**Blocks:** P03A, P04A, P05A, P06A, P07A, P08A, P09A, P09C
**Can run in parallel with:** P02B

## Context

Scaffold the Expo Router app inside `apps/mobile`, wire it to
`@openclaw/protocol` via the workspace, and verify it boots on iOS, Android,
and Web. No real screens yet — just the route shell. Per `plan.md` §5.

## Goal

`apps/mobile` is a working Expo app: `pnpm --filter @openclaw/mobile start`
launches Metro; the app boots into a placeholder home screen on iOS sim,
Android emu, and web. Protocol import resolves and types flow.

## Inputs

- P00 (monorepo) + P01A (`@openclaw/protocol` built) complete.

## Outputs

- `apps/mobile/` populated with a real Expo project:
  - `app.json` / `app.config.ts`
  - `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app/(tabs)/index.tsx`, etc. (placeholder screens per `plan.md` §5)
  - `src/openclaw/gateway.ts` re-exports from `@openclaw/protocol`.
  - `src/theme/` tokens stub (colors, spacing, type).
  - `babel.config.js`, `metro.config.js` (with workspace symlink handling).
  - `tsconfig.json` extending `tsconfig.base.json`.
  - `jest.config.js` + `jest-setup.ts` + one smoke test.
- `apps/mobile/package.json` filled in with deps + scripts.

## Steps

1. Inside `apps/mobile`, run `pnpm create expo-app . --template tabs` (interactive — pick TypeScript).
2. **Critical:** configure `metro.config.js` to support pnpm workspaces:
   - Watch the monorepo root.
   - Resolve `@openclaw/protocol` from `../../packages/protocol/dist` (or src via tsconfig paths).
   - Disable hierarchical lookup if needed.
   - Reference Expo's official monorepo guide.
3. Update `apps/mobile/package.json`:
   - Add `"@openclaw/protocol": "workspace:*"`.
   - Scripts: `start`, `ios`, `android`, `web`, `typecheck`, `lint`, `test`.
4. Update `tsconfig.json`:
   - Extend `../../tsconfig.base.json`.
   - Add path alias `@openclaw/protocol` → `../../packages/protocol/src` (for dev type-checking).
5. Replace template screens with placeholder versions matching `plan.md` §5 IA:
   - `app/_layout.tsx` — Stack root.
   - `app/(pairing)/welcome.tsx`, `discover.tsx`, `code.tsx` — empty `<Text>"P03A"</Text>` placeholders.
   - `app/(tabs)/_layout.tsx` — Tabs nav.
   - `app/(tabs)/index.tsx` — "Home (P05A)".
   - `app/(tabs)/threads/index.tsx`, `[id].tsx` — placeholders.
   - `app/(tabs)/agents.tsx`, `voice.tsx`, `settings.tsx` — placeholders.
6. Add `src/openclaw/gateway.ts`:
   ```ts
   export type { GatewayClient } from "@openclaw/protocol";
   export { InMemoryMockGateway } from "@openclaw/protocol";
   ```
7. Add `src/theme/tokens.ts` with `colors`, `spacing`, `radius`, `fontSize` constants (small palette for now).
8. Add Jest + React Native Testing Library:
   - `pnpm add -D jest jest-expo @testing-library/react-native @testing-library/jest-native @types/jest`.
   - `jest.config.js` using `jest-expo` preset.
   - `__tests__/smoke.test.tsx` — renders `<Text>hi</Text>` to confirm jest works.
9. Smoke test: `pnpm --filter @openclaw/mobile start --web` and confirm it loads in browser. (If running headless, just confirm Metro starts without errors.)
10. Run `pnpm --filter @openclaw/mobile typecheck && test`.

## Success criteria

- [ ] `pnpm install` succeeds.
- [ ] `pnpm --filter @openclaw/mobile typecheck` exits 0.
- [ ] `pnpm --filter @openclaw/mobile test` exits 0.
- [ ] `pnpm --filter @openclaw/mobile start --web` opens a browser tab showing a tab layout with the home placeholder.
- [ ] `import { InMemoryMockGateway } from "@openclaw/protocol"` resolves and types are visible in editor.
- [ ] No hierarchical-resolution warnings in Metro startup.

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build      # ensures protocol dist is fresh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
pnpm --filter @openclaw/mobile start --web --non-interactive  # smoke; kill after 30s
```

## Commit

```
Scaffold apps/mobile (Expo + Expo Router) wired to @openclaw/protocol

Initialize the Expo tabs template, configure Metro for pnpm workspaces,
add placeholder routes matching the planned IA, theme tokens stub, and
Jest smoke test. Imports from @openclaw/protocol resolve via workspace
link.
```

## Notes

- Metro + pnpm workspaces is the #1 source of pain. If `@openclaw/protocol` doesn't resolve, the fix is almost always in `metro.config.js` `watchFolders` + `resolver.nodeModulesPaths`. Check Expo's monorepo example before improvising.
- Use the **tabs template** so we get bottom-tab nav for free; we'll restructure routes in P03A onwards.
- Do **not** install CopilotKit or any networking deps here. Those land in P05A and P04A.
- Do **not** scaffold real screens beyond placeholders — UI work belongs to the per-feature plans.
- If `pnpm create expo-app` insists on initializing a git repo or its own `node_modules`, clean those up afterward so the monorepo's lockfile remains the source of truth.
