# P09B — Desktop notarize + .dmg release

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1 day
**Depends on:** all desktop feature plans (P02B–P08B)
**Blocks:** —
**Can run in parallel with:** P09A, P09C

## Context

Code-sign and notarize the macOS build, produce a signed `.dmg`, set up
auto-update via `electron-updater`. Per `desktop-app.md` §1, §8 and
`open-questions.md` §A9.

## Goal

A signed, notarized `.dmg` that installs on macOS without Gatekeeper
warnings, auto-updates via GitHub Releases.

## Outputs

- `apps/desktop/electron-builder.yml` finalized.
- `apps/desktop/build/` with signed icons, entitlements plist.
- `.github/workflows/desktop-release.yml` building + signing + notarizing on tag push.
- Apple Developer ID Application cert + Apple ID stored as GH Action secrets.
- README updates documenting install + update.

## Steps

1. Finalize `electron-builder.yml`:
   - `appId: dev.openclaw.desktop` (or finalized id).
   - `mac.target: dmg`, `mac.notarize: true`, `mac.hardenedRuntime: true`.
   - `mac.entitlements`, `mac.entitlementsInherit` pointing at `build/entitlements.mac.plist`.
   - Publish provider: `github`.
2. Entitlements:
   - `com.apple.security.network.client`
   - `com.apple.security.network.server` (we serve LAN)
   - `com.apple.security.device.audio-input` (for voice routing)
   - `com.apple.security.app-sandbox` — **skip** for v1 (we need raw network); document the security trade-off.
3. Apple credentials in GH secrets:
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
   - `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`.
4. GH Action `desktop-release.yml`:
   - Trigger on `v*` tag push.
   - Install pnpm + Node 22.
   - `pnpm install`.
   - `pnpm --filter @openclaw/desktop build`.
   - `pnpm --filter @openclaw/desktop dist` (electron-builder).
   - Upload to GitHub Release.
5. Wire `electron-updater`:
   - `pnpm --filter @openclaw/desktop add electron-updater`.
   - `autoUpdater.checkForUpdatesAndNotify()` in main on app ready.
6. Manual end-to-end test:
   - Tag `v0.1.0`, push.
   - Watch CI produce a signed `.dmg`.
   - Download + install on a clean Mac mini.
   - Bump to `v0.1.1`, tag, push; verify auto-update prompt on the installed app.

## Success criteria

- [ ] Tag push produces a signed, notarized `.dmg` attached to a GitHub Release.
- [ ] Installing the `.dmg` on a fresh macOS user account succeeds without Gatekeeper warnings.
- [ ] Auto-update prompt appears after publishing a higher version.

## Verification

- GitHub Release shows the `.dmg` + `.dmg.blockmap` + `latest-mac.yml`.
- `spctl --assess --verbose --type install <path>.dmg` reports accepted.

## Commit

```
Add macOS notarization + signed .dmg release for desktop

Finalize electron-builder config, add entitlements, wire
electron-updater, and add a GitHub Actions workflow that builds,
signs, and notarizes the app on v* tag push. Releases publish to
GitHub with auto-update metadata.
```

## Notes

- This plan **requires Apple Developer Program enrollment** + a valid Developer ID cert. Coordinator must have both before dispatch.
- Without `app-sandbox`, we lose some App Store paths — but App Store distribution is out of scope for v1 (we're side-loading). Document this trade-off in README.
- Windows / Linux builds are stretch. Same `electron-builder.yml` can produce them later.
- If notarization fails repeatedly, capture the `notarytool log` output before retrying — the failures are usually entitlements or signature issues, not transient.
