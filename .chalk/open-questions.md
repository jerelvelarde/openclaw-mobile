# Open questions

Things we need to answer (or pick a default for) before / during M0–M2.
Group A blocks scaffolding; Group B can wait until the relevant milestone.

---

## A. Blockers before code (need from you)

1. **OpenClaw location & API**
   - Repo URL / docs URL?
   - REST, GraphQL, or RPC? Streaming via WebSocket, SSE, or long-poll?
   - Auth model — OAuth (which provider), API keys, both?
   - Where does it run — hosted SaaS, self-hosted, both?

2. **OpenClaw <-> CopilotKit boundary**
   - Does OpenClaw already expose a CopilotKit-compatible runtime endpoint, or do we stand up our own thin runtime (Node) in front of it?
   - If we stand one up, where does it live (separate repo, sibling package here, deployed alongside OpenClaw)?

3. **CopilotKit React Native packages — exact names**
   - Confirm the current package(s) and minimum SDK version. The plan references the latest RN-capable CopilotKit; pin the actual versions before M1.

4. **Branding / naming**
   - Display name, bundle id (e.g. `dev.openclaw.mobile`), icon, color tokens.

---

## B. Decisions we can make as we go

5. **State management** — Zustand vs Jotai vs just React Query + Context. Default: Zustand for UI, React Query for server.
6. **Diff rendering** — `react-diff-viewer` (web) + custom RN component, or a single Shiki-on-RN-Web pipeline. Default: split renderer, shared tokenizer.
7. **Error/telemetry** — Sentry vs PostHog vs both. Default: Sentry for crashes, PostHog for product analytics.
8. **EAS vs bare** — staying on Expo managed unless a native module forces ejection.
9. **iPad / large-screen layout** — defer to stretch unless requested for v1.
10. **Voice input** — stretch.

---

## C. Assumptions I made (call out anything wrong)

- OpenClaw sessions are long-running and stream events — like Claude Code sessions, not single-shot completions.
- A "session" maps roughly 1:1 to a git branch on a repo, and produces a PR at the end.
- Users authenticate to OpenClaw, and OpenClaw holds the GitHub credentials — the mobile app never sees a GitHub token directly.
- We can run a CopilotKit runtime endpoint that proxies to OpenClaw; the mobile app does not call any LLM provider directly.

If any of those are wrong, the architecture in `plan.md` needs to shift —
flag it and I'll revise before we start M0.
