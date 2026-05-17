# openclaw

A pnpm-workspace monorepo for the OpenClaw client surfaces: a mobile app
(Expo / React Native / Web), a desktop companion (Electron, runs on the
always-on Mac), and the shared protocol package both consume. The full
product plan lives in [`.chalk/plan.md`](./.chalk/plan.md); per-task
sub-agent plans live in [`.chalk/plans/`](./.chalk/plans/).

> Repo name note: still called `openclaw-mobile` for now since the desktop
> app was added later. Rename tracked in `.chalk/open-questions.md`.

## Layout

```
openclaw/
├── apps/
│   ├── mobile/      # @openclaw/mobile  — Expo (iOS / Android / Web)
│   └── desktop/     # @openclaw/desktop — Electron menu-bar app
├── packages/
│   └── protocol/    # @openclaw/protocol — shared types, Zod schemas, GatewayClient
├── .chalk/          # planning docs + sub-agent plans
├── pnpm-workspace.yaml
└── package.json
```

All three workspaces are stubs at this point. Real scaffolding lands in
plans P01A (protocol), P02A (mobile), and P02B (desktop).

## Prerequisites

- Node 22.16+ (see `.nvmrc`; `nvm use` or `fnm use` picks it up).
- pnpm 9 — pinned via Corepack. Run `corepack enable` once and pnpm will
  match the version in `packageManager`.

## Quick start

```sh
corepack enable           # one time per machine
pnpm install              # installs every workspace
pnpm -r typecheck         # TypeScript across all workspaces
pnpm -r lint              # ESLint across all workspaces
pnpm -r test              # tests across all workspaces
pnpm format               # Prettier --write
pnpm format:check         # Prettier --check (CI)
```

Per-workspace dev loops (not wired up yet — see plans P02A/P02B):

```sh
pnpm --filter @openclaw/mobile start    # Expo dev server (after P02A)
pnpm --filter @openclaw/desktop dev     # Electron dev (after P02B)
```

## Where things live

- Vision and architecture: [`.chalk/plan.md`](./.chalk/plan.md)
- Wave-by-wave delivery plan: [`.chalk/master-plan.md`](./.chalk/master-plan.md)
- Desktop companion contract: [`.chalk/desktop-app.md`](./.chalk/desktop-app.md)
- Host (Mac) assumptions: [`.chalk/host-target.md`](./.chalk/host-target.md)
- Harness / agent matrix: [`.chalk/compatibility.md`](./.chalk/compatibility.md)
- Open questions: [`.chalk/open-questions.md`](./.chalk/open-questions.md)
