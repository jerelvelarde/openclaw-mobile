# P02B — Desktop app skeleton (Electron)

**App:** desktop (`apps/desktop`)
**Estimated effort:** 0.5 day
**Depends on:** P00, P01A
**Blocks:** P03B, P04B, P05B, P05C, P06B, P07B, P08B, P09B
**Can run in parallel with:** P02A

## Context

Scaffold the Electron menu-bar app inside `apps/desktop`, wired to
`@openclaw/protocol`. No supervision, pairing, or chat yet — those are
P03B+. Per `desktop-app.md` and `plan.md` §3.

## Goal

`apps/desktop` is a working Electron app: `pnpm --filter @openclaw/desktop
dev` opens an Electron window with a menu-bar (macOS) icon, a basic
renderer-side React UI, and the ability to import `@openclaw/protocol` from
both main and renderer processes.

## Inputs

- P00 (monorepo) + P01A (`@openclaw/protocol` built) complete.

## Outputs

- `apps/desktop/` populated with electron-vite scaffolding:
  - `electron.vite.config.ts`
  - `src/main/index.ts` — main process; tray + single window.
  - `src/preload/index.ts` — context-isolated IPC bridge.
  - `src/renderer/` — React app (placeholder).
  - `resources/icon.png` (placeholder), `resources/trayTemplate.png`.
  - `tsconfig.*.json` per process.
- `apps/desktop/package.json` with deps + scripts.
- `apps/desktop/electron-builder.yml` stub (build config; release is P09B).
- One smoke test (`vitest`).

## Steps

1. Inside `apps/desktop`, scaffold electron-vite (manually or via `pnpm create @quick-start/electron`; if interactive, choose React + TypeScript).
2. Update `apps/desktop/package.json`:
   - `"main": "out/main/index.js"`.
   - Add `"@openclaw/protocol": "workspace:*"`.
   - Scripts: `dev` (`electron-vite dev`), `build` (`electron-vite build`), `start` (preview), `typecheck`, `lint`, `test`.
3. `src/main/index.ts`:
   - `app.whenReady().then(...)`.
   - Create a hidden main window (only shown on tray click for v1).
   - Create a `Tray` with `trayTemplate.png` and a basic menu (`Show`, `Quit`).
   - `app.dock.hide()` on macOS so it lives in the menu bar only.
   - Single-instance lock.
4. `src/preload/index.ts`:
   - `contextBridge.exposeInMainWorld("api", { ping: () => "pong" })`.
   - No node integration in renderer.
5. `src/renderer/src/App.tsx`:
   - Render a heading "openclaw-desktop".
   - Call `window.api.ping()` and display the result.
   - Import a type from `@openclaw/protocol` (e.g. `Agent`) just to prove the workspace link works.
6. tsconfig:
   - `tsconfig.node.json` for main/preload (Node-style resolution).
   - `tsconfig.web.json` for renderer (DOM lib).
   - Both extend `../../tsconfig.base.json`.
7. Stub `electron-builder.yml`:
   - `appId: dev.openclaw.desktop`
   - `productName: OpenClaw`
   - `mac.target: dmg`
   - **No** signing identity yet (P09B owns that). Mark `mac.identity: null` with a comment.
8. Vitest setup:
   - `pnpm add -D vitest @testing-library/react jsdom`.
   - `vitest.config.ts` for renderer tests; one test that renders `<App/>` and asserts the heading.
9. Smoke test: `pnpm --filter @openclaw/desktop dev` opens the Electron window with the tray icon visible (on macOS dev box). On Linux/headless CI, just confirm `electron-vite build` exits 0.

## Success criteria

- [ ] `pnpm install` succeeds.
- [ ] `pnpm --filter @openclaw/desktop typecheck` exits 0.
- [ ] `pnpm --filter @openclaw/desktop test` exits 0.
- [ ] `pnpm --filter @openclaw/desktop build` produces `out/main/index.js`, `out/preload/index.js`, `out/renderer/`.
- [ ] On macOS dev box: `pnpm --filter @openclaw/desktop dev` shows a tray icon; clicking shows the renderer with "pong".
- [ ] `@openclaw/protocol` import works in both main and renderer.

## Verification

```sh
pnpm install
pnpm --filter @openclaw/protocol build
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
pnpm --filter @openclaw/desktop build
```

All exit 0.

## Commit

```
Scaffold apps/desktop (Electron + electron-vite + React) menu-bar shell

Initialize electron-vite project with main/preload/renderer split, a
macOS tray icon, hidden main window, context-isolated preload, and a
renderer React app importing types from @openclaw/protocol. Vitest
smoke test covers the renderer.
```

## Notes

- We use **electron-vite** (not electron-forge) because vite gives faster dev rebuilds and matches the renderer's React/Vite story.
- macOS-only behaviors (Tray, `app.dock.hide`) should be guarded with `process.platform === "darwin"` so Linux/Windows dev still boots.
- Do **not** add `node-mdns`, `keytar`, `express`, or any pairing/transport deps here. Those land in P03B and P04B.
- Do **not** wire the renderer to a real chat UI. That's P05B.
- Signing identity for macOS notarization is intentionally absent — leave a `// TODO P09B` comment in `electron-builder.yml`.
- If `electron-vite` insists on its own `node_modules`, fix the install to use the monorepo lockfile.
