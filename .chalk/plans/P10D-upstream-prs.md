# P10D — Upstream contributions (Canvas, Voice, runtime adapter)

**App:** upstream (`openclaw/openclaw`)
**Estimated effort:** Open-ended — we don't own the merge timeline
**Depends on:** P10.0 (for the PR-back list)
**Blocks:** —
**Can run in parallel with:** P10A, P10B

## Context

P10.0 ends with a recommended list of upstream contributions: protocol
additions our work produced that upstream may want (Canvas schema, Voice
protocol with WebRTC handshake, the CopilotKit runtime adapter shape).
This plan opens those PRs / issues and tracks them.

## Goal

For each item on P10.0's PR-back list, an open PR (or at minimum a tracking
issue) on the upstream repo with a working reference implementation drawn
from our codebase.

## Inputs

- P10.0's PR-back section.
- Permission to push to forks of `openclaw/openclaw` and `NousResearch/hermes-agent`.

## Outputs

- PRs or issues filed on the relevant upstream repo(s).
- Links + status tracked in `.chalk/openclaw-upstream.md` (a new "Upstream contributions" section).
- For each PR: a branch in our forks that the upstream can pull from.

## Anti-patterns

- Don't open a PR for every delta — only the ones that genuinely belong upstream (additive, well-tested, generally useful).
- Don't block our own roadmap on upstream merge decisions; if a PR stalls, document the divergence and ship.
- Don't propose breaking changes to upstream's existing users — additions only.

## Detailed steps + success criteria

**Defer until P10.0 lands.** This file is the placeholder.
