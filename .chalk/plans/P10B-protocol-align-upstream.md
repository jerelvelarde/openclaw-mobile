# P10B — Align `@openclaw/protocol` with upstream

**App:** protocol (`packages/protocol`)
**Estimated effort:** 0.5–2 days (highly dependent on P10.0 findings)
**Depends on:** P10.0
**Blocks:** P10A (if non-trivial deltas), P10C
**Can run in parallel with:** —

## Context

Our hand-rolled `@openclaw/protocol` was built to satisfy our stub gateway,
not upstream. P10.0 surfaces deltas. This plan applies the changes
required to align the wire format with whatever upstream actually speaks.

## Possible outcomes (scope unknown until P10.0)

1. **Trivial deltas.** Rename a few topics, add a couple of fields. Half a day, minor cherry-picks on both apps.
2. **Material deltas.** Envelope shape differs (e.g. JSON-RPC vs our custom shape), token format differs, topic taxonomy differs. 1–2 days of protocol changes plus matching apps/* updates.
3. **Hard divergence.** Upstream's contract is incompatible with ours (e.g. binary framing, different auth model). Re-spec needed; coordinate with upstream via PR or issue first. Could turn this plan into "propose changes upstream" (P10D) instead.

## Goal

`@openclaw/protocol` exports match upstream's wire format closely enough
that P10A's bridge is a thin translator (or no translator at all). Apps
(mobile + desktop) updated to consume the new shapes. All tests green.

## Inputs

- P10.0's `.chalk/openclaw-upstream.md` and `.chalk/openclaw-deltas.md`.

## Outputs

- Updated `packages/protocol/src/{types,schemas,client,envelope}.ts`.
- Updated `packages/protocol/src/{canvas,voice}/*` if those concepts exist or differ upstream.
- Migration notes in `.chalk/openclaw-deltas.md` updated to reflect what changed.
- Apps mobile + desktop updated to the new shapes (this plan owns the breaking change; both apps must land in the same commit so CI stays green).
- New tests where the shape changed.

## Anti-patterns

- Don't keep both old and new shapes "for compatibility" — there are no external consumers yet, just pick the new shape.
- Don't break Canvas/voice unless P10.0 says we have to.
- Don't ship upstream-only shapes if we'd want to PR an addition upstream; coordinate via P10D.

## Detailed steps + success criteria

**Defer until P10.0 lands.** This file is the placeholder.
