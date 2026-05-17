# Master plan — sub-agent dispatch order

This file is the **orchestration layer** for the per-task plans in
`.chalk/plans/`. Each plan is self-contained and designed to be handed to a
sub-agent. This document defines the **dependency graph** and **execution
waves** so a coordinator (human or root agent) knows what can run in
parallel and what must wait.

Read this top-to-bottom. The high-level vision lives in `plan.md`. Host
assumptions in `host-target.md`. Inter-app contract in `desktop-app.md`.

---

## 1. How to use this

- Every plan in `plans/` has an ID (e.g. `P02A`), a list of dependencies, and a "Can parallel with" set.
- The coordinator dispatches a plan only when **all** its dependencies have completed.
- Plans within the same **wave** are mutually independent and SHOULD be dispatched in parallel (single message, multiple `Agent` tool calls).
- Each plan ends with a verification step. The coordinator does not mark a plan complete until verification passes.

### Dispatch template

When dispatching a plan to a sub-agent, pass:

1. The plan file contents (read from `.chalk/plans/<id>-<slug>.md`).
2. A pointer to `plan.md`, `desktop-app.md`, `host-target.md`, and `compatibility.md` for context.
3. The list of outputs from completed dependency plans.
4. Instruction to commit and push when done (each plan owns a focused commit).

---

## 2. Plan inventory

| ID    | Title                                 | App           | Effort | File                                          |
| ----- | ------------------------------------- | ------------- | ------ | --------------------------------------------- |
| P00   | Monorepo bootstrap                    | root          | 0.5d   | `plans/P00-monorepo-bootstrap.md`             |
| P01A  | Protocol package skeleton             | protocol      | 1d     | `plans/P01A-protocol-package.md`              |
| P01B  | CI workflows                          | root          | 0.5d   | `plans/P01B-ci-workflows.md`                  |
| P02A  | Mobile app skeleton (Expo)            | mobile        | 0.5d   | `plans/P02A-mobile-skeleton.md`               |
| P02B  | Desktop app skeleton (Electron)       | desktop       | 0.5d   | `plans/P02B-desktop-skeleton.md`              |
| P03A  | Mobile pairing UI (vs mock)           | mobile        | 1d     | `plans/P03A-mobile-pairing-ui.md`             |
| P03B  | Desktop pairing service + approval UI | desktop       | 1.5d   | `plans/P03B-desktop-pairing-service.md`       |
| P04A  | Mobile Bonjour discovery + WS client  | mobile        | 1.5d   | `plans/P04A-mobile-transport.md`              |
| P04B  | Desktop Bonjour advertise + WS server | desktop       | 1.5d   | `plans/P04B-desktop-transport.md`             |
| P05C  | CopilotKit runtime adapter (desktop)  | desktop       | 1.5d   | `plans/P05C-copilot-runtime-adapter.md`       |
| P05A  | Mobile CopilotKit chat                | mobile        | 2d     | `plans/P05A-mobile-copilot-chat.md`           |
| P05B  | Desktop chat UI                       | desktop       | 2d     | `plans/P05B-desktop-chat-ui.md`               |
| P06.0 | Canvas schema in protocol             | protocol      | 0.5d   | `plans/P06.0-canvas-schema.md`                |
| P06A  | Mobile Canvas renderer                | mobile        | 1.5d   | `plans/P06A-mobile-canvas-renderer.md`        |
| P06B  | Desktop Canvas renderer               | desktop       | 1.5d   | `plans/P06B-desktop-canvas-renderer.md`       |
| P07.0 | Voice transport decision + protocol   | protocol      | 0.5d   | `plans/P07.0-voice-protocol.md`               |
| P07A  | Mobile voice capture + playback       | mobile        | 2.5d   | `plans/P07A-mobile-voice.md`                  |
| P07B  | Desktop voice routing                 | desktop       | 1.5d   | `plans/P07B-desktop-voice-routing.md`         |
| P08A  | Mobile push registration              | mobile        | 0.5d   | `plans/P08A-mobile-push.md`                   |
| P08B  | Desktop push fan-out (APNs/FCM)       | desktop       | 1d     | `plans/P08B-desktop-push-fanout.md`           |
| P09A  | Mobile EAS build + release            | mobile        | 1d     | `plans/P09A-mobile-release.md`                |
| P09B  | Desktop notarize + .dmg release       | desktop       | 1d     | `plans/P09B-desktop-release.md`               |
| P09C  | Web deploy                            | mobile        | 0.5d   | `plans/P09C-web-deploy.md`                    |
| P10.0 | OpenClaw upstream protocol survey     | root (doc)    | 1d     | `plans/P10.0-openclaw-source-survey.md`       |
| P10A  | Real OpenClaw gateway bridge          | desktop       | 2–3d   | `plans/P10A-openclaw-bridge.md` — **RETIRED (chat-only bridge superseded by clawg-ui plugin; see P11A/P11D)** |
| P10B  | Align `@openclaw/protocol` w/ upstream| protocol      | 0.5–2d | `plans/P10B-protocol-align-upstream.md` — **RETIRED (clawg-ui adapts server-side; envelope churn no longer needed)** |
| P10C  | E2E against real `openclaw gateway`   | root          | 1d     | `plans/P10C-e2e-real-gateway.md` — **RETIRED → reframed as P11E (e2e against gateway + clawg-ui plugin)** |
| P10D  | Upstream contributions (PRs)          | upstream      | open   | `plans/P10D-upstream-prs.md` — **RETIRED (most PR-back items obsolete; Canvas/Voice deferred to P11C)** |
| P11.0 | clawg-ui pivot architecture summary   | root (doc)    | 0.25d  | `plans/P11.0-clawg-ui-pivot-summary.md`       |
| P11A  | Adopt clawg-ui as real-mode chat path | mobile+desktop| 1–1.5d | `plans/P11A-adopt-clawg-ui-clients.md`        |
| P11B  | clawg-ui pairing UX in the desktop    | desktop       | 1–1.5d | `plans/P11B-clawg-ui-pairing-ux.md`           |
| P11C  | Canvas + Voice real-mode strategy     | root (doc)    | 0.5d   | `plans/P11C-canvas-voice-realmode-strategy.md`|
| P11D  | Tear down P10A OpenClawBridge         | desktop       | 0.5d   | `plans/P11D-tear-down-openclaw-bridge.md`     |
| P11E  | E2E against gateway + clawg-ui plugin | root          | 1–1.5d | `plans/P11E-e2e-clawg-ui.md`                  |

**Total estimated effort:** ~25 person-days for Waves 1–13, plus 1d for P10.0 + ~5d for Wave 15 (P11.*). With 2 sub-agents running mobile and desktop in parallel: ~13–15 wall-clock days for Waves 1–13.

**Current status (as of commit `2c10c8c`):** Waves 1–12 complete. v0.1.0 dev preview tagged locally as `v0.1.0-dev-preview`. Wave 13 (release) deferred — needs Apple Developer + EAS + web host credentials. P10.0 (upstream protocol survey) shipped. P10A (chat-only OpenClawBridge) shipped on `main` but **retired** as of Wave 15 — the `contextablemark/clawg-ui` gateway plugin (vendored at `vendor/clawg-ui/` @ `v0.7.0`) solves the chat translation problem server-side, so the bridge becomes legacy code (removed in P11D). Wave 15 (clawg-ui pivot) starting next.

---

## 3. Dependency graph

```
                                  P00 (monorepo bootstrap)
                                       │
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
                   P01A (protocol)                P01B (CI)
                       │
           ┌───────────┴───────────┐
           ▼                       ▼
       P02A (mobile sk)        P02B (desktop sk)
           │                       │
           ▼                       ▼
       P03A (pair UI)          P03B (pair svc)
           │                       │
           └──────────┬────────────┘
                      │
           ┌──────────┴──────────┐
           ▼                     ▼
       P04A (mobile WS)      P04B (desktop WS)
           │                     │
           └─────────┬───────────┘
                     │
                     ▼
                P05C (runtime adapter, desktop)
                     │
           ┌─────────┼─────────┐
           ▼         ▼         ▼
       P05A      P05B       (P05C is its own row above)
       (mobile   (desktop
        chat)    chat UI)
           │         │
           └────┬────┘
                ▼
           P06.0 (canvas schema, protocol)
                │
           ┌────┴────┐
           ▼         ▼
       P06A      P06B
                │
           P07.0 (voice protocol)  — can start any time after P05A/B
                │
           ┌────┴────┐
           ▼         ▼
       P07A      P07B

           P08A ─┐    (mobile push; can start after P04A)
                 ├── P08B (desktop fan-out)
                 ▼
              v1 chat+push working

       P09A · P09B · P09C  (release; after everything stabilizes)

       P10.0 (done) ─► P10A (shipped, retired) ─► [P10B/P10C/P10D RETIRED]

       P11.0 (pivot summary, doc)
              │
       ┌──────┴──────┬──────────────┐
       ▼             ▼              ▼
     P11A          P11B          P11C (doc-only)
     (clients      (pairing
      to clawg-ui) UX wrap)
       │             │
       └──────┬──────┘
              ▼
            P11D (tear down OpenClawBridge)
              │
              ▼
            P11E (e2e against daemon + clawg-ui)
```

---

## 4. Execution waves

Dispatch each wave in parallel. Wait for the whole wave to complete before
starting the next.

### Wave 1 — Foundation (sequential, single agent)
- **P00** — Monorepo bootstrap.

### Wave 2 — Shared scaffolding (parallel × 2)
- **P01A** — Protocol package skeleton.
- **P01B** — CI workflows.

### Wave 3 — App skeletons (parallel × 2)
- **P02A** — Mobile app skeleton.
- **P02B** — Desktop app skeleton.

### Wave 4 — Pairing (parallel × 2)
- **P03A** — Mobile pairing UI against mock gateway.
- **P03B** — Desktop pairing service + approval UI.

### Wave 5 — Real transport (parallel × 2)
- **P04A** — Mobile Bonjour + WS client.
- **P04B** — Desktop Bonjour + WS server.

### Wave 6 — Runtime adapter (sequential, single agent)
- **P05C** — CopilotKit runtime adapter inside `apps/desktop`. This must land before mobile chat can be tested end-to-end.

### Wave 7 — Chat surfaces (parallel × 2)
- **P05A** — Mobile CopilotKit chat.
- **P05B** — Desktop chat UI.

### Wave 8 — Canvas schema (sequential, single agent)
- **P06.0** — Lock Canvas schema in `packages/protocol`.

### Wave 9 — Canvas renderers (parallel × 2)
- **P06A** — Mobile renderer.
- **P06B** — Desktop renderer.

### Wave 10 — Voice protocol (sequential, single agent)
- **P07.0** — Decide voice transport (WebRTC vs frames-over-WS) and extend protocol.

### Wave 11 — Voice implementation (parallel × 2)
- **P07A** — Mobile voice.
- **P07B** — Desktop voice routing.

### Wave 12 — Push (parallel × 2)
- **P08A** — Mobile registration.
- **P08B** — Desktop fan-out.

### Wave 13 — Release (parallel × 3) — **deferred, needs credentials**
- **P09A** — Mobile EAS / TestFlight / Play.
- **P09B** — Desktop notarize / .dmg / auto-update.
- **P09C** — Web deploy.

### Wave 14 — Upstream OpenClaw integration (mostly sequential) — partially shipped, mostly retired
- **P10.0** — OpenClaw source survey & spec (sequential, single agent). Documents the real upstream wire format and identifies deltas vs `@openclaw/protocol`. **Shipped.**
- **P10A** — Real OpenClaw gateway bridge (sequential, single agent). Replaces the in-process stub with supervision of the real `openclaw gateway` daemon. **Shipped (chat-only happy path, commit `8b2aeed`).** **Retired** by Wave 15: clawg-ui plugin does the same translation server-side; bridge removed in P11D.
- **P10B** — Protocol alignment. **Retired** without execution: clawg-ui's `RunAgentInput`/AG-UI SSE shape is what our clients already speak; no envelope churn needed.
- **P10C** — End-to-end test against the real daemon. **Retired** → reframed as P11E (e2e against `openclaw gateway` + `@contextableai/clawg-ui` plugin).
- **P10D** — Upstream contributions / PRs. **Retired** without execution: the Canvas/Voice PR-back items are deferred to P11C's strategy doc; the CopilotKit-runtime-as-plugin item is effectively done by clawg-ui itself.

### Wave 15 — clawg-ui pivot (mostly sequential after P11.0)
- **P11.0** — Architecture pivot summary (sequential, doc only). Explains the decision to adopt `contextablemark/clawg-ui` for real-mode chat and what changes for clients vs. what stays. **Blocks** P11A/B/C/D/E (they reference it).
- **P11A** — Adopt clawg-ui as real-mode chat path (sequential, single agent, mobile + desktop). Mobile + desktop AG-UI clients re-target `<host>:18789/v1/clawg-ui` when `gateway_mode === "clawg-ui"` (renamed from `"real"`). Marks P10A bridge `@deprecated` without removing it.
- **P11B** — Desktop UI wrap for clawg-ui's pairing approval (parallel with P11A, coordinate on `settings.ts`). Spawns `openclaw pairing approve clawg-ui <code>` from a tray + Settings banner.
- **P11C** — Canvas + Voice real-mode strategy (parallel with P11A/P11B, doc only). Recommends Option C for v1 (stub-only Canvas/Voice in real mode) with Option B (sibling plugins) as the phased post-v1 path.
- **P11D** — Tear down the P10A `OpenClawBridge` (sequential after P11A). Deletes the 1149 LOC of bridge + handshake + tests; narrows `gateway_mode` to `"stub" | "clawg-ui"`.
- **P11E** — E2E against real `openclaw gateway` + clawg-ui plugin (sequential after P11A + P11B + P11D). Docker-Compose'd daemon, scripted pair → approve → chat scenario, CI job `e2e-clawg-ui`.

---

## 5. Critical path

The longest dependency chain determines minimum wall-clock time:

```
P00 → P01A → P02A → P03A → P04A → P05C → P05A → P06.0 → P06A → P07.0 → P07A → P08A → P09A
0.5 +  1  + 0.5 +  1  + 1.5 + 1.5 +  2  +  0.5 +  1.5 +  0.5 +  2.5 + 0.5 +  1   = ~13 days
```

Whichever app finishes faster in each wave should pick up a stretch task
(see `plan.md` §Stretch) or help review the other side.

---

## 6. Parallelization opportunities outside the critical path

- **P01B** (CI) runs alongside P01A in Wave 2 — same wave, no extra time.
- **P02B / P03B / P04B** (desktop track) run in parallel with their mobile counterparts.
- **P08A / P08B** (push) can start as early as Wave 6 finishes — they don't block chat polish.
- **P09C** (web deploy) can land any time after P05A merges.

---

## 7. Coordinator checklist (per wave)

For the human/root agent driving execution:

1. **Pre-wave:** verify all dependencies' verification steps passed.
2. **Dispatch:** send one message with one `Agent` call per plan in the wave.
3. **Mid-wave:** if a plan blocks on a question, surface it; don't unblock by guessing.
4. **Post-wave:** review the commits each agent pushed; run `pnpm -r typecheck && pnpm -r test && pnpm -r lint` locally; only then mark the wave complete.
5. **Update:** check off the wave in this file (or in a tracking issue).

---

## 8. What's deliberately not planned yet

These show up in `plan.md` §Stretch and don't get plans until after v1:

- Multi-gateway switching.
- Continuous voice + barge-in.
- Mobile skill/agent editor.
- iPad / large-screen layouts.
- "Forward to channel" action.
- Windows / Linux desktop builds.

When any of these get prioritized, add a new `plans/Pxx-….md` file and a row
in §2.
