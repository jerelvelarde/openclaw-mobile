# P01B — CI workflows

**App:** root
**Estimated effort:** 0.5 day
**Depends on:** P00
**Blocks:** — (quality gate; doesn't block features)
**Can run in parallel with:** P01A

## Context

We need CI from day one so subsequent plans land cleanly. GitHub Actions
running typecheck + lint + test across all workspaces on every PR. Path
filtering keeps PRs touching only one app from triggering the other's heavy
matrix.

## Goal

`.github/workflows/ci.yml` (and supporting workflows) that:
- Run on every PR to any branch and on push to `main`.
- Install pnpm + cache the store.
- Run `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`.
- Run the protocol package's `build` to ensure it compiles cleanly.
- Use path filters so mobile-only changes don't run desktop-only checks (and vice versa), but always run protocol + lint + typecheck.

## Inputs

- P00 complete.

## Outputs

- `.github/workflows/ci.yml`
- `.github/workflows/protocol.yml` (or jobs within `ci.yml`)
- (Optional) `.github/dependabot.yml` for pnpm + GH Actions updates.

## Steps

1. Create `.github/workflows/ci.yml`:
   - Triggers: `pull_request`, `push` to `main`.
   - One job `quality` running on `ubuntu-latest`:
     - `actions/checkout@v4`
     - `pnpm/action-setup@v3` with version from root `package.json` `packageManager`.
     - `actions/setup-node@v4` with `cache: pnpm`, `node-version-file: .nvmrc`.
     - `pnpm install --frozen-lockfile`.
     - `pnpm format:check`.
     - `pnpm -r typecheck`.
     - `pnpm -r lint`.
     - `pnpm -r test`.
     - `pnpm --filter @openclaw/protocol build`.
2. Add path filters via `paths` on the workflow trigger OR via a `dorny/paths-filter` step that conditionally runs per-app jobs. For v1, keep it simple: one job that runs everything. Optimize later if CI time becomes painful.
3. (Optional) Add a separate `.github/workflows/release.yml` stub that triggers on tag push — actual release wiring is in P09A/P09B/P09C; leave a comment placeholder.
4. (Optional) `.github/dependabot.yml`:
   - `package-ecosystem: github-actions`, weekly.
   - `package-ecosystem: npm`, weekly, scoped to root.
5. Push a trivial change (e.g. add a newline to README) to verify the workflow runs green on the dev branch.

## Success criteria

- [ ] CI workflow runs on the current dev branch and exits green.
- [ ] All four `pnpm -r …` commands appear in the log.
- [ ] pnpm store cache hit on a second run.
- [ ] No workflow steps marked `continue-on-error: true` (no hidden failures).

## Verification

- GitHub Actions tab on the repo shows a successful run on the latest commit of `claude/plan-mobile-app-55yoU`.
- Re-running the workflow uses cached pnpm store (visible in logs).

## Commit

```
Add GitHub Actions CI for typecheck, lint, test, format, protocol build

One quality job runs across all workspaces on PR and push to main. Use
pnpm/action-setup + actions/setup-node cache for fast installs.
```

## Notes

- Pin GH Action versions to major (`@v4`) not floating (`@latest`) for reproducibility.
- If the dev branch isn't yet protected by branch rules, don't add status-check requirements — that's the user's call.
- Do **not** add an Expo or Electron build step here. Release builds live in P09A/P09B.
- If pnpm install fails because the lockfile isn't checked in yet, ensure P00's commit included `pnpm-lock.yaml`. If not, file an issue and proceed (the plan will be re-run after lockfile lands).
