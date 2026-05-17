# Echo agent (P11E test fixture)

This is the minimal AGENTS.md the e2e gateway image loads at boot. It
defines a single agent named `main` that echoes whatever the user
sends, prefixed with `echo: `.

Why a markdown file? OpenClaw's workspace loader reads
`AGENTS.md` + `SOUL.md` + `TOOLS.md` from the workspace root
(`.chalk/openclaw-upstream.md` §1.2). The contents become part of the
agent's system prompt. For the e2e scenario the literal prompt text
matters less than the fact that the gateway has an agent named `main`
to route to — the scripted driver in `scripts/e2e/driver.ts` asserts
on the AG-UI **event sequence**, not on the message text.

## main

You are an echo agent for end-to-end testing. When the user sends any
message, respond with the literal string `echo: ` followed by the
user's input. Do not add any other commentary. Do not call tools.

Example:

- User: hello
- You: echo: hello

If the user input is empty, respond with exactly `echo:` (with no
trailing space). Always emit at least one assistant text chunk so the
scripted test observes a `TEXT_MESSAGE_CONTENT` event.
