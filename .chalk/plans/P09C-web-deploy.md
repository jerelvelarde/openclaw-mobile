# P09C — Web deploy

**App:** mobile (`apps/mobile`, web target)
**Estimated effort:** 0.5 day
**Depends on:** P05A (chat working on web)
**Blocks:** —
**Can run in parallel with:** P09A, P09B

## Context

Ship the web build of `apps/mobile` as a static site. Useful for the
"desktop fallback in a browser" case when the user can't / won't install
the Electron app on a given machine. Per `plan.md` §1 (one codebase, three
surfaces).

## Goal

`apps/mobile`'s web build deploys to a static host (Vercel / Cloudflare
Pages / Netlify) on push to `main`, with the same chat / pairing flows
working in a browser.

## Outputs

- `apps/mobile/vercel.json` (or equivalent for chosen host).
- `.github/workflows/web-deploy.yml`.
- Updated README with the deployed URL once available.

## Steps

1. Pick a static host. Default: **Vercel** (free tier, good CI).
2. `pnpm --filter @openclaw/mobile expo export -p web` produces a static `dist/`.
3. Configure host:
   - Vercel: connect the GitHub repo; configure root directory `apps/mobile`; build command `pnpm install --frozen-lockfile && pnpm --filter @openclaw/protocol build && pnpm --filter @openclaw/mobile expo export -p web`; output directory `dist/`.
4. Add `apps/mobile/vercel.json` for SPA routing (rewrite all to `index.html`).
5. (Optional) GH Action `.github/workflows/web-deploy.yml`:
   - On push to `main`, trigger Vercel deploy hook.
6. Verify:
   - Open the deployed URL.
   - Pair with a desktop that's reachable over Tailscale / public URL (LAN won't work from a hosted browser).
   - Confirm chat works.

## Success criteria

- [ ] Web build deploys successfully on every push to `main`.
- [ ] Visiting the URL renders the welcome screen.
- [ ] Pairing works when given a reachable host URL.
- [ ] Chat round-trip works in browser.

## Verification

- Deployed URL responds 200.
- Lighthouse score baseline captured (we're not optimizing yet, just establishing a starting point).

## Commit

```
Deploy mobile web build to Vercel on push to main

Add vercel.json for SPA routing, configure the project to build via
expo export -p web, and document the deployed URL in the README. Web
build pairs over a reachable URL (LAN Bonjour discovery is intentionally
unsupported in browsers).
```

## Notes

- Bonjour discovery doesn't work in browsers. Web users must paste a URL.
- `react-native-zeroconf`, `react-native-webrtc`, `expo-secure-store`, and `expo-notifications` all have web limitations — guard with `Platform.OS === "web"` and provide reasonable fallbacks or feature-gate the screens.
- Web voice (P07A's stretch) is out of scope for this plan.
- Don't add web-specific styling here — degrade gracefully from the mobile UI.
