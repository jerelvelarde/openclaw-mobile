# openclaw-mobile — Plan

A mobile companion app for **OpenClaw** in the spirit of **Claude Dispatch**: kick
off coding-agent sessions from your phone, watch them run, chat with them, and
review/merge their output without opening a laptop.

Built with **Expo (React Native + Web)** and **CopilotKit's React Native
runtime**, talking to OpenClaw as the agent backend.

---

## 1. Goals

1. **Dispatch** — start, monitor, and control long-running OpenClaw agent sessions from a phone.
2. **Chat** — quick, conversational interactions powered by CopilotKit (`useCopilotChat`, `useCopilotAction`).
3. **Review** — surface diffs, PRs, and CI status well enough to approve work from mobile.
4. **One codebase, three surfaces** — iOS, Android, Web via Expo Router.

### Non-goals (v1)

- Running OpenClaw locally on the device (treat it as a remote service).
- Full IDE: no syntax-aware editing, no terminal emulator. We render diffs & logs, not edit code.
- Multi-tenant org admin (just personal accounts + their repos).

---

## 2. Assumptions (confirmed)

- **Purpose:** Both dispatch + chat in one app.
- **Platforms:** Expo managed workflow targeting iOS, Android, and Web.
- **Backend:** OpenClaw is an **existing external project** (URL/API TBD — see `open-questions.md`).
  The app treats it as a remote service behind a typed client.

---

## 3. Reference points

- **Claude Dispatch** — the UX pattern we're echoing: a list of agent sessions,
  each with live status, a chat thread, an attached working branch, and the
  ability to send follow-up instructions or approve actions.
- **CopilotKit React Native** — latest CopilotKit packages now ship a
  React-Native–compatible runtime + hooks (`CopilotKit` provider,
  `useCopilotChat`, `useCopilotAction`, `CopilotChat` UI). We use these instead
  of rolling our own chat layer.
- **OpenClaw** — the coding agent we dispatch to. Exact endpoints TBD; we'll
  abstract behind `src/openclaw/client.ts` so the agent surface is swappable.

---

## 4. Tech stack

| Layer            | Choice                                              | Why                                                                 |
| ---------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| App framework    | Expo SDK (latest) + Expo Router                     | iOS + Android + Web from one tree, file-based routing               |
| Language         | TypeScript (strict)                                 | Shared types across UI, copilot actions, and OpenClaw client        |
| AI / chat        | CopilotKit (React Native packages)                  | First-class chat UI, tool/action registration, streaming            |
| Agent backend    | OpenClaw HTTP/WS API (via thin client)              | The actual coding work happens here, not on device                  |
| State            | Zustand (or Jotai) + React Query                    | Local UI state + server cache for sessions, PRs, logs               |
| Realtime         | WebSocket / SSE to OpenClaw + CopilotKit streaming  | Live session logs and chat token streaming                          |
| Auth             | Expo AuthSession + OpenClaw OAuth (or token paste)  | GitHub login flow lives in OpenClaw; mobile holds a session token   |
| Storage          | expo-secure-store (tokens) + AsyncStorage (cache)   | Keep auth material out of plain storage                             |
| Push             | Expo Notifications                                  | "Your agent needs input" / "PR ready to review" pings               |
| Code rendering   | react-native-syntax-highlighter or Shiki-on-RN-Web  | Diff + code blocks in chat and review screens                       |
| Testing          | Jest + React Native Testing Library + Detox (later) | Unit + component now; e2e once flows stabilize                      |
| CI               | GitHub Actions (lint, typecheck, test, EAS build)   | Same workflow on the App Store / Play Store / Vercel for web        |

---

## 5. Information architecture

Expo Router tree:

```
app/
  (auth)/
    sign-in.tsx              # OAuth start / paste-token fallback
  (tabs)/
    index.tsx                # Home: pinned sessions, quick "new dispatch"
    sessions/
      index.tsx              # List of agent sessions (status, branch, repo)
      [id].tsx               # Session detail: tabs for Chat | Logs | Diff | PR
      new.tsx                # Compose: repo + branch + prompt + model
    chat.tsx                 # Standalone CopilotKit chat (not tied to a session)
    settings.tsx             # Account, OpenClaw endpoint, notifications, theme
  _layout.tsx                # CopilotKit provider, theme, query client
```

### Key screens

1. **Home** — recent sessions, "New dispatch" CTA, unread @mentions.
2. **New dispatch** — pick repo → pick branch → write prompt → pick model → submit.
3. **Session detail**
   - **Chat:** CopilotKit-powered thread scoped to the session.
   - **Logs:** streaming agent tool calls + stdout.
   - **Diff:** files changed, before/after, syntax-highlighted.
   - **PR:** CI status, reviewers, merge button (calls OpenClaw → GitHub).
4. **Standalone chat** — general copilot not bound to a session (ask questions, run lightweight actions).
5. **Settings** — endpoint, token, push prefs, theme.

---

## 6. CopilotKit integration sketch

```tsx
// app/_layout.tsx
<CopilotKit runtimeUrl={`${OPENCLAW_BASE}/copilot/runtime`} agent="openclaw">
  <ThemeProvider>
    <QueryClientProvider client={queryClient}>
      <Slot />
    </QueryClientProvider>
  </ThemeProvider>
</CopilotKit>
```

Custom **actions** we register on the client so the copilot can drive the app:

- `dispatchAgent({ repo, branch, prompt, model })`
- `openSession({ id })`
- `approvePullRequest({ sessionId })`
- `requestChanges({ sessionId, comment })`
- `cancelSession({ id })`

Custom **readables** (`useCopilotReadable`) so the assistant sees:

- The current session (id, status, branch, last tool call).
- The diff summary (files + +/- counts) when on the Diff tab.
- The signed-in user and selected repo.

---

## 7. OpenClaw client surface (assumed; refine once API is known)

```ts
// src/openclaw/client.ts
export interface OpenClawClient {
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<SessionDetail>;
  createSession(input: NewSessionInput): Promise<Session>;
  cancelSession(id: string): Promise<void>;
  streamSession(id: string, onEvent: (e: SessionEvent) => void): Unsubscribe;
  postMessage(id: string, text: string): Promise<void>;
  approve(id: string): Promise<void>;
  // ...PR/CI helpers, repo+branch listing, etc.
}
```

All UI talks to this interface — never `fetch` directly — so we can mock it in
tests and adapt to OpenClaw's real shape with a small adapter.

---

## 8. Risks & open issues

Tracked in `open-questions.md`. Highlights:

- We don't yet have the OpenClaw API contract; the client interface above is a
  placeholder shaped by what Dispatch-style UIs need.
- CopilotKit's React Native packages are new — confirm the exact package names
  and required peer deps before scaffolding.
- Streaming logs on iOS over backgrounded WebSockets needs care (consider SSE +
  push notifications as a fallback when the app is suspended).

---

## 9. What "v1 done" looks like

- Sign in, see your sessions, start a new one, watch it run, chat with it,
  view its diff, approve/merge — end-to-end on iOS, Android, and Web from the
  same Expo build.
- Push notification when a session asks a question or finishes.
- No crashes on the golden path; basic tests cover the OpenClaw client and the
  session-detail reducer.

See `milestones.md` for how we sequence this.
