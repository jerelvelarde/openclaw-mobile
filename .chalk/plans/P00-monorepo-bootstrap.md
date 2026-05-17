# P00 — Monorepo bootstrap

**App:** root
**Estimated effort:** 0.5 day
**Depends on:** —
**Blocks:** P01A, P01B, P02A, P02B (everything)
**Can run in parallel with:** —

## Context

Repo currently contains only `README.md` and `.chalk/`. We're turning it into
a pnpm workspace monorepo for two apps (mobile, desktop) and one shared
package (protocol). The structure is defined in `plan.md` §1.

## Goal

A pnpm monorepo where `pnpm install` succeeds, root scripts (`typecheck`,
`lint`, `test`, `format`) run across workspaces, and `apps/mobile`,
`apps/desktop`, `packages/protocol` exist as empty workspaces ready for
later plans to fill in.

## Inputs

- Empty repo (just `README.md` + `.chalk/`).
- pnpm available (or installable in CI).

## Outputs

- `pnpm-workspace.yaml`
- Root `package.json` with scripts and devDependencies (typescript, eslint, prettier).
- `tsconfig.base.json` (shared tsconfig for workspaces to extend).
- Root `.eslintrc.cjs` and `.prettierrc`.
- `.nvmrc` pinning Node 22.
- `.gitignore` for Node + Expo + Electron + macOS junk.
- `apps/mobile/`, `apps/desktop/`, `packages/protocol/` each with a stub `package.json` + `.gitkeep`.
- Updated root `README.md` describing the monorepo layout and dev commands.

## Steps

1. Install pnpm if missing (`npm i -g pnpm@9` or use Corepack).
2. Create `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "apps/*"
     - "packages/*"
   ```
3. Create root `package.json` with:
   - `"name": "openclaw"`, `"private": true`, `"packageManager": "pnpm@9.x.x"`.
   - devDependencies: `typescript`, `eslint`, `@typescript-eslint/*`, `prettier`, `eslint-config-prettier`, `eslint-plugin-import`.
   - Scripts: `typecheck` (`pnpm -r typecheck`), `lint` (`pnpm -r lint`), `test` (`pnpm -r test`), `format` (`prettier --write .`), `format:check`.
4. Create `tsconfig.base.json` with strict mode, `module: ESNext`, `target: ES2022`, `moduleResolution: bundler`, `skipLibCheck: true`, declaration on.
5. Create `.eslintrc.cjs` extending `eslint:recommended`, `@typescript-eslint/recommended`, `prettier`.
6. Create `.prettierrc` with project defaults (single quotes, trailing commas: all, print width 100).
7. Create `.nvmrc` containing `22`.
8. Create `.gitignore` covering: `node_modules/`, `.expo/`, `dist/`, `build/`, `out/`, `.DS_Store`, `*.log`, `.env*`, `coverage/`, Xcode and Android Studio junk.
9. Create stub packages:
   - `apps/mobile/package.json`: `{ "name": "@openclaw/mobile", "version": "0.0.0", "private": true, "scripts": { "typecheck": "tsc --noEmit", "lint": "eslint .", "test": "echo no tests yet" } }` + `.gitkeep`.
   - `apps/desktop/package.json`: same shape with `@openclaw/desktop`.
   - `packages/protocol/package.json`: `{ "name": "@openclaw/protocol", "version": "0.0.0", "private": true, "main": "dist/index.js", "types": "dist/index.d.ts", "scripts": {…} }` + `.gitkeep`.
10. Run `pnpm install` and verify it succeeds.
11. Rewrite root `README.md`:
    - Project overview (one paragraph).
    - Monorepo layout diagram (`apps/` + `packages/`).
    - Quick-start commands (`pnpm install`, `pnpm --filter mobile start`, `pnpm --filter desktop dev`).
    - Link to `.chalk/plan.md` for the full plan.

## Success criteria

- [ ] `pnpm install` exits 0.
- [ ] `pnpm -r typecheck` exits 0 (each stub has no TS files yet, but the script resolves).
- [ ] `pnpm -r lint` exits 0.
- [ ] `pnpm format:check` exits 0.
- [ ] `apps/mobile`, `apps/desktop`, `packages/protocol` all show up in `pnpm list -r --depth -1`.
- [ ] README accurately describes layout + dev commands.

## Verification

```sh
pnpm install
pnpm -r typecheck
pnpm -r lint
pnpm format:check
pnpm list -r --depth -1
```

All five exit 0.

## Commit

```
Bootstrap pnpm monorepo with mobile, desktop, protocol workspaces

Add pnpm-workspace.yaml, root tsconfig/eslint/prettier configs, stub
packages for apps/mobile, apps/desktop, packages/protocol, and a
top-level README explaining the layout.
```

Branch: `claude/plan-mobile-app-55yoU`.

## Notes

- **Do not** scaffold the actual Expo or Electron apps here — those are P02A and P02B. Stubs only.
- Use pnpm@9 unless the user has a strong reason otherwise.
- If installing pnpm in CI later trips up, prefer `corepack enable && corepack prepare pnpm@9 --activate`.
- Do not add any deps to the stub `package.json` files yet — keep them empty so later plans control their dep trees.
- Flag in `open-questions.md` if you discover the user wants a different package manager (npm/yarn workspaces are alternatives).
