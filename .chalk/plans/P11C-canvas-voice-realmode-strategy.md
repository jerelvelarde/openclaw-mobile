# P11C — Canvas + Voice real-mode strategy (plan-only)

**App:** root (doc/strategy)
**Estimated effort:** 0.5 day (no code; this is a recommendation
document, not an execution plan)
**Depends on:** P11.0
**Blocks:** any future plan that ships Canvas or Voice in real mode
**Can run in parallel with:** P11A, P11B, P11D

## Context

`contextablemark/clawg-ui` (vendored at `vendor/clawg-ui/` @ `v0.7.0`)
is **chat-only**. It sets `chatTypes: ["direct"]` + `blockStreaming:
true` (`vendor/clawg-ui/src/channel.ts:20–23`), exposes one HTTP route
(`POST /v1/clawg-ui`), and emits AG-UI `TEXT_MESSAGE_*` /
`TOOL_CALL_*` / `RUN_*` events only (`vendor/clawg-ui/README.md:177–207`).

Our P06 (Canvas) and P07 (Voice) surfaces have no equivalent in
clawg-ui — and they diverge fundamentally from what upstream OpenClaw
ships:

- **Canvas (P06):** ours is a schema-driven tree of typed nodes
  (`StackNode`/`HeadingNode`/…) with `CanvasPatch` ops
  (`packages/protocol/src/canvas/types.ts`). Upstream is an HTML/WebView
  surface served from a separate port (default 18793,
  `/__openclaw__/canvas/<file>.html?oc_cap=<token>`, see
  `.chalk/openclaw-upstream.md` §6). Live update is a literal `"reload"`
  broadcast on `/__openclaw__/ws`. User actions post back through a JS
  bridge in the page using **A2UI** (Google's Agent-to-UI protocol).
- **Voice (P07):** ours uses WebRTC for the realtime path and a
  typed `VoiceFrameWire` shape for the in-process JSON fallback
  (`packages/protocol/src/voice/types.ts`,
  `.chalk/openclaw-upstream.md` §4.4). Upstream's `talk.*` RPCs carry
  base64 PCM/Opus inside JSON for the `gateway-relay` transport
  (`/tmp/upstream-openclaw/src/gateway/protocol/schema/channels.ts:223–230`),
  and use WebRTC for the `webrtc` transport.

Neither surface is reachable through clawg-ui today. So when the user
flips to real mode, Canvas + Voice **break** — the mobile UI tries to
emit `canvas.*` / `voice.*` topics that the desktop has no real-mode
handler for. We need a stance.

This plan is **plan-only**: it documents three strategies, recommends
one, and produces a doc to commit. It does not execute anything.

## Goal

A single committed strategy document
`.chalk/architecture/canvas-voice-realmode.md` (~120–200 lines) that:

1. Restates the constraints (what clawg-ui doesn't do; what upstream
   OpenClaw does that diverges from ours).
2. Enumerates three options (A / B / C below) with concrete trade-offs.
3. Recommends one for v1, with the next concrete plan id reserved (e.g.
   "If we pick B, the next plan is P12A: scaffold `@openclaw/canvas-ui`
   sibling plugin").
4. Lists the open questions the chosen path opens, ready to be added to
   `.chalk/open-questions.md` once the recommendation is accepted.

## Options to evaluate

### Option A — Extend clawg-ui (fork + PR upstream)

**What:** Open PRs against `contextablemark/clawg-ui` to add Canvas
and Voice surfaces alongside the existing chat surface. Probably a new
event family in `vendor/clawg-ui/index.ts` (e.g. `CANVAS_PATCH`,
`VOICE_FRAME`) emitted through the same `/v1/clawg-ui` SSE stream, and
new HTTP routes (`/v1/clawg-ui/canvas/...`, `/v1/clawg-ui/voice/...`)
for client→server traffic.

**Pros:**
- Single endpoint, single device-token pairing for everything.
- Mobile + desktop stay on one HTTP+SSE pattern.
- Wins for the broader AG-UI ecosystem (Canvas/Voice in CopilotKit
  by extension).

**Cons:**
- AG-UI core (`@ag-ui/core@0.0.52`) has no Canvas or Voice event
  types; we'd be inventing a non-standard event taxonomy and pushing
  for upstream adoption. Slow.
- Voice in particular is a poor fit for SSE (one-way server→client)
  unless we add a WebRTC-style sidecar transport.
- We'd own the fork until upstream merges. The user explicitly said
  no fork for v1.

### Option B — Sibling plugin(s) on the gateway

**What:** Author `@openclaw/canvas-ui` and/or `@openclaw/voice-ui` as
sibling OpenClaw plugins, each exposing its own HTTP route on the
gateway (e.g. `/v1/canvas-ui` and `/v1/voice-ui`). Same device-pairing
flow as clawg-ui (we'd lift the pairing helpers from
`vendor/clawg-ui/src/http-handler.ts:97–136` into a shared module —
or PR a shared module to clawg-ui first). Mobile gets three
endpoints and three device tokens, one per surface.

**Pros:**
- No need to fork clawg-ui.
- Each surface picks the right transport (Canvas: SSE for the diff
  stream, JSON POST for events; Voice: WebRTC offer/answer + a
  signaling SSE channel).
- Composable: a user can install just the surfaces they want.
- We own the plugins and the cadence.

**Cons:**
- Three pairings is poor UX (we'd hide it behind the desktop, but it's
  still three CLI invocations per gateway for a fresh user).
- Each plugin reimplements the auth + session-key machinery. Mitigation:
  publish a `@openclaw/agui-plugin-kit` shared helper.
- Voice in particular requires the plugin to mediate a WebRTC
  signaling channel through the gateway's existing routing — not
  trivial.

### Option C — Keep stub-only; no real-mode Canvas/Voice for v1

**What:** Document that Canvas + Voice are **stub-mode-only** in v1.
In real mode, the mobile UI hides the Canvas tab and the Voice button;
or shows them as "Coming soon — not available against this gateway".
Real-mode v1 ships chat only.

**Pros:**
- Zero new infra. The user's question ("can I use real chat now?")
  gets a yes; Canvas + Voice stay in the stub demo.
- Most honest about what clawg-ui actually delivers.

**Cons:**
- We've built Canvas (P06A/P06B) and Voice (P07A/P07B) end-to-end
  against the stub. Shipping with "this only works in dev mode" feels
  like a regression of effort.
- Doesn't move the upstream conversation forward.

## Recommendation

**Option B (sibling plugins), staged:**

1. **Phase 1 (post-v1):** ship `@openclaw/canvas-ui` as a sibling
   plugin. Canvas's diff/patch model maps cleanly to SSE; the JS
   bridge for user actions becomes a JSON POST. Reuse the device-
   pairing pattern from clawg-ui (initially copy-paste; PR a shared
   `@openclaw/agui-plugin-kit` once both plugins exist).
2. **Phase 2 (post-v1 + 1):** ship `@openclaw/voice-ui` once we have
   a clearer story for WebRTC signaling through OpenClaw plugins.
   Until then, Voice stays stub-only (effectively a temporary Option
   C for Voice).
3. **For v1 specifically (right now):** apply **Option C for both**.
   Real-mode UI hides Canvas + Voice (`features` capability flag wired
   in a small follow-up plan; cheap once the clawg-ui base URL is
   plumbed in P11A). This unblocks the v1 launch on real chat without
   committing to a Canvas/Voice transport design we haven't validated.

The committed strategy doc spells out Phase 1 → 2 trigger conditions:

- **Trigger for Phase 1 (Canvas):** at least one user asks for real-
  mode Canvas via an issue / TestFlight feedback. Or: we want to ship
  a feature whose UX needs an interactive form-style surface in real
  mode.
- **Trigger for Phase 2 (Voice):** the user asks for hands-free voice
  in real mode, OR we have a working WebRTC-via-OpenClaw reference
  (e.g. upstream `talk.session.create transport:"webrtc"` matures and
  we can wrap it).

Option A (PR clawg-ui) is the **fallback** if Option B's plugin
authoring runs into OpenClaw plugin-SDK limitations we can't work
around. Reassess when Phase 1 starts.

## Inputs

- `.chalk/openclaw-upstream.md` §4.4 (talk methods), §6 (Canvas),
  §13 (PR-back candidates).
- `.chalk/openclaw-deltas.md` §E (Canvas), §F (Voice).
- `vendor/clawg-ui/src/channel.ts` (channel capabilities),
  `vendor/clawg-ui/openclaw.plugin.json` (plugin SDK shape).
- `apps/mobile/src/canvas/` + `apps/desktop/src/main/canvas/` —
  what we'd be hiding in stub-only mode.
- `apps/mobile/src/voice/` + `apps/desktop/src/main/voice/` — same.

## Outputs

- `.chalk/architecture/canvas-voice-realmode.md` — the strategy doc.
- Three new entries appended to `.chalk/open-questions.md` (#44 is
  reserved for the umbrella question; the executor adds child
  questions for each Phase trigger when this plan commits).
- **No** code changes. **No** edits to existing plans.

## Steps

1. Re-read `vendor/clawg-ui/src/channel.ts` and confirm
   `chatTypes: ["direct"]` is the current declaration. (If clawg-ui
   has grown more channel types since `v0.7.0`, the analysis below
   needs revisiting.)
2. Read `apps/mobile/src/canvas/` and `apps/mobile/src/voice/`
   shallowly (one file each) to confirm what "hide Canvas/Voice in
   real mode" means in renderer code — i.e. a settings-aware
   conditional in the tab nav.
3. Write `.chalk/architecture/canvas-voice-realmode.md`:
   - Sections: Constraints, Option A, Option B, Option C,
     Recommendation, Phase 1 trigger, Phase 2 trigger, Risks.
   - Cite line numbers in `vendor/clawg-ui/` and the upstream survey
     for every claim.
4. **Do NOT** modify `apps/mobile/`, `apps/desktop/`, or
   `packages/protocol/`. Hiding the tabs in real mode is a follow-up
   plan (probably bundled into P11A's renderer Settings change).
5. **Do NOT** edit other `P11*.md` plan files from this plan.

## Success criteria

- The strategy doc exists and is internally consistent.
- The recommendation is **one** of A / B / C (no waffling).
- Every Option pros/cons row cites a real file path — no hand-waving.
- The doc names the next plan id we'd open if the recommendation is
  accepted (e.g. "P12A — Scaffold `@openclaw/canvas-ui` sibling plugin").

## Verification

```sh
pnpm install
pnpm format:check       # .chalk/ ignored
pnpm --filter @openclaw/protocol build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

All five exit 0. (They will — doc only.)

## Commit

Single commit:

```
Canvas + Voice real-mode strategy (P11C)

Document three options (extend clawg-ui via fork+PR; sibling plugins
@openclaw/canvas-ui + voice-ui; stub-only for v1) and recommend
Option C for v1 with Option B as the phased post-v1 path. Plan-only
output; no code changes.
```

## Notes

- Anti-pattern: do not start scaffolding `@openclaw/canvas-ui` from
  this plan. That's a follow-up plan if/when the recommendation is
  accepted.
- The "hide Canvas/Voice in real mode" UX change is small enough
  that it can ride with P11A's settings work. The strategy doc
  flags this so P11A's executor knows to land that tab gating.
- Open question: clawg-ui's `OperatorAguiHttpHandler`
  (`vendor/clawg-ui/src/http-handler.ts:362–395`) suggests there's a
  pattern for operator-scoped routes. If Canvas/Voice surfaces follow
  the same pattern, the desktop's existing operator auth could mint
  the device token automatically — worth checking in Phase 1 design.
