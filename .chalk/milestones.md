# Milestones

Phased delivery so each step ships something demoable. Sizes are rough
estimates assuming one engineer.

---

## M0 — Repo skeleton (½ day)

- `npx create-expo-app` with TypeScript template, Expo Router.
- ESLint + Prettier + tsconfig strict.
- GitHub Actions: install, typecheck, lint, test on PR.
- `src/openclaw/client.ts` interface + in-memory mock.
- Theme + design tokens stub.

**Demo:** empty tab app boots on iOS sim, Android emu, and web.

---

## M1 — CopilotKit chat surface (1 day)

- Install CopilotKit React Native packages.
- Wrap app in `<CopilotKit>` provider pointing at a stub runtime URL.
- Standalone `chat.tsx` route renders `CopilotChat` end-to-end against the mock.
- Register one trivial action (`echo`) and one readable (current route).

**Demo:** can chat with the copilot from the phone; tool call round-trips.

---

## M2 — OpenClaw auth + sessions list (1–2 days)

- Auth: OpenClaw OAuth via `expo-auth-session`, fallback to paste-token.
- Tokens stored in `expo-secure-store`.
- React Query hooks: `useSessions`, `useSession(id)`.
- Home + `sessions/index.tsx` render real data from OpenClaw.
- Pull-to-refresh and empty/loading/error states.

**Demo:** sign in, see your real OpenClaw sessions on the phone.

---

## M3 — New dispatch flow (1 day)

- `sessions/new.tsx`: repo picker, branch picker, prompt textarea, model picker, submit.
- Optimistic insert into the sessions list.
- Copilot action `dispatchAgent` mirrors this flow so the chat can launch sessions.

**Demo:** start a real OpenClaw session from the phone, either by tapping or asking the copilot.

---

## M4 — Session detail: chat + logs (2 days)

- Tabbed session detail screen.
- **Chat tab:** CopilotKit chat scoped to that session id (passed in context).
- **Logs tab:** subscribe to `streamSession`, render tool calls + stdout with autoscroll + pause-on-touch.
- Background-safe: SSE/WebSocket reconnect with backoff; show "disconnected" banner when stale.

**Demo:** watch a running agent live and talk to it from the session screen.

---

## M5 — Diff & PR review (2 days)

- **Diff tab:** files-changed list → per-file before/after, syntax-highlighted, with collapse.
- **PR tab:** title, description, CI checks, reviewers, comments preview, **Approve** / **Request changes** / **Merge** buttons that hit OpenClaw.
- Copilot actions wired: `approvePullRequest`, `requestChanges`.

**Demo:** review and merge an OpenClaw-produced PR from your phone.

---

## M6 — Push notifications (1 day)

- Expo Notifications setup; register device token with OpenClaw.
- Triggers: session needs input, session finished, PR ready for review, CI failed.
- Deep-link from notification into the relevant session tab.

**Demo:** phone buzzes when an agent finishes; tapping opens the diff.

---

## M7 — Polish & v1 cut (1–2 days)

- Dark mode, accessibility pass (Dynamic Type, screen reader labels).
- Empty/error illustrations.
- Crash + analytics (Sentry + a privacy-minded event logger).
- EAS build profiles: dev, preview (TestFlight + internal track), production.
- Web deploy (Vercel or similar).

**Demo:** TestFlight link, Play internal track, web URL — all from one branch.

---

## Stretch (post-v1)

- Voice input → copilot (Expo Speech / on-device STT).
- Offline queue for actions taken while disconnected.
- Multi-account switching.
- Org/team dashboards.
- iPad/large-screen split view (sessions list ↔ detail).
