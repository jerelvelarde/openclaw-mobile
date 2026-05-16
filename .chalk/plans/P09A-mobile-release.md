# P09A — Mobile EAS build + release

**App:** mobile (`apps/mobile`)
**Estimated effort:** 1 day
**Depends on:** all mobile feature plans (P02A–P08A)
**Blocks:** —
**Can run in parallel with:** P09B, P09C

## Context

Configure EAS Build profiles, ship preview builds to TestFlight + Android
internal track. Production release is the user's call. Per `plan.md` §10.

## Goal

A green `eas build --profile preview` produces installable artifacts on
both platforms; TestFlight invite + Play internal track link work.

## Outputs

- `apps/mobile/eas.json` with `development`, `preview`, `production` profiles.
- `apps/mobile/app.config.ts` updated with proper bundle id, version, icons.
- Icons + splash assets in `apps/mobile/assets/`.
- GH Action `.github/workflows/mobile-release.yml` building on tag push (optional v1).
- Release notes template.

## Steps

1. `pnpm --filter @openclaw/mobile add -D eas-cli`. Verify EAS account is configured.
2. `eas.json` profiles:
   - `development`: dev client, internal distribution.
   - `preview`: store-compatible build, internal distribution (TestFlight + Play internal).
   - `production`: store-ready.
3. `app.config.ts`:
   - `ios.bundleIdentifier: "dev.openclaw.mobile"` (or finalized id).
   - `android.package: "dev.openclaw.mobile"`.
   - `version`, `runtimeVersion` strategy.
   - Icon + splash + adaptive icon paths.
4. Assets:
   - Generate icon set + adaptive icon (use an existing tool or design).
   - Add splash images.
5. First builds:
   - `eas build --profile preview --platform all`.
   - On success, submit:
     - `eas submit --platform ios --latest` → TestFlight.
     - `eas submit --platform android --latest --track internal`.
6. (Optional) GH Action that runs `eas build` on `v*` tag push.
7. Document in mobile README the steps to cut a release.

## Success criteria

- [ ] Preview build installs on a real iOS device via TestFlight.
- [ ] Preview build installs on Android via internal track.
- [ ] App boots, pairs, chats, and the basics work on both stores' preview channels.

## Verification

- TestFlight build number visible to the team.
- Play internal track shows the new APK.

## Commit

```
Add EAS build profiles + store submission config for mobile

Configure eas.json with development/preview/production profiles,
finalize app.config.ts (bundle id, version, icons, splash), and add
release notes template. Preview builds ship to TestFlight + Play
internal track.
```

## Notes

- EAS costs real money + a real Apple developer account. Coordinator should confirm both are in place before dispatch.
- Bundle id `dev.openclaw.mobile` is a placeholder — finalize before this plan starts. Add to `open-questions.md` if unclear.
- Production submission (App Store / Play public) is intentionally manual for v1.
- Don't auto-bump versions in CI yet; manual `version` bumps + release notes are fine for a small team.
