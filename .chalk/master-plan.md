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

**Total estimated effort:** ~25 person-days. With 2 sub-agents running mobile and desktop in parallel: ~13–15 wall-clock days.

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

### Wave 13 — Release (parallel × 3)
- **P09A** — Mobile EAS / TestFlight / Play.
- **P09B** — Desktop notarize / .dmg / auto-update.
- **P09C** — Web deploy.

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
