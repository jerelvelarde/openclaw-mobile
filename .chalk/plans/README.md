# `.chalk/plans/` — sub-agent dispatch plans

Each file here is a **self-contained task** designed to be handed to a
sub-agent for execution. The orchestrator (a human or root agent) reads
`../master-plan.md` to know which plans to dispatch in which wave.

## Plan file format

Every plan follows the same template:

```markdown
# <Plan ID> — <Title>

**App:** mobile | desktop | protocol | root
**Estimated effort:** X days
**Depends on:** [list of plan IDs]
**Blocks:** [list of plan IDs]
**Can run in parallel with:** [list of plan IDs]

## Context
What the executing agent needs to know that isn't in plan.md.

## Goal
One paragraph: what done looks like.

## Inputs
Files / packages / decisions that must exist before this plan starts.

## Outputs
Files / packages / endpoints this plan produces.

## Steps
Numbered, concrete steps. Commands, package names, file paths.

## Success criteria
Checklist the agent must satisfy before committing.

## Verification
Commands to run + expected output. Coordinator re-runs these.

## Commit
Suggested commit message + branch (always `claude/plan-mobile-app-55yoU`
unless noted).

## Notes
Gotchas, decisions to flag, anti-patterns to avoid.
```

## Dispatching a plan

The orchestrator should send a sub-agent prompt like:

> Execute the plan in `.chalk/plans/<id>-<slug>.md`. Read `.chalk/plan.md`,
> `.chalk/desktop-app.md`, `.chalk/host-target.md`, and
> `.chalk/compatibility.md` for context. Follow the plan exactly; flag any
> ambiguity instead of guessing. When done, run the Verification commands,
> commit with the suggested message, push, and report back the commit SHA
> + any deviations.

## Conventions

- All plans target branch `claude/plan-mobile-app-55yoU` (current dev branch). When v1 is closer, split branches per plan.
- Plans never edit other plans, `master-plan.md`, or `plan.md`. If a plan reveals new info, the executor writes findings to `open-questions.md` instead.
- Each plan owns one commit. If a plan grows to multiple commits, it should have been split.
- Plans are **idempotent**: re-running a plan on a clean tree should produce the same diff.
- **Always-run baseline gates** (in addition to per-plan Verification). Sub-agents MUST run these before committing, even when the per-plan Verification doesn't list them, because CI gates on them:
  - `pnpm install` — no resolution churn.
  - `pnpm format:check` — Prettier-clean across all touched files.
  - `pnpm -r typecheck` — TS clean across all workspaces.
  - `pnpm -r lint` — passes (stubs are echo-only until per-app ESLint lands).
  - `pnpm -r test` — passes (stubs are echo-only until per-app tests land).

## Adding new plans

When a new task appears:

1. Pick the next free ID per the numbering scheme in `master-plan.md` §2.
2. Add a row to `master-plan.md` §2 inventory.
3. Add it to the right wave in §4, or add a new wave.
4. Update §3 (dependency graph) and §5 (critical path) if it changes them.
