// Placeholder renderer UI for the OpenClaw desktop shell.
//
// P02B scope: render a heading + the result of `window.api.ping()` to prove
// the preload bridge is wired. The `Agent` type import from
// `@openclaw/protocol` is the workspace-link smoke test required by the
// plan; we don't render real agents yet (that's P05B+).

import type { Agent } from '@openclaw/protocol';

/**
 * Placeholder agent shown in the shell so the `Agent` type from
 * `@openclaw/protocol` is exercised (not just imported). Real agents come
 * from the gateway in later plans.
 */
const PLACEHOLDER_AGENT: Agent = {
  id: 'openclaw.placeholder',
  name: 'Placeholder agent',
  description: 'Replaced once the gateway lands (P03B+).',
};

export function App(): JSX.Element {
  // `window.api` is exposed by preload/index.ts. In Vitest under jsdom the
  // preload script doesn't run, so we guard the access.
  const ping = typeof window !== 'undefined' && window.api ? window.api.ping() : '(no bridge)';

  return (
    <main>
      <h1>openclaw-desktop</h1>
      <p>IPC bridge: {ping}</p>
      <p>
        Placeholder agent: <code>{PLACEHOLDER_AGENT.id}</code>
      </p>
    </main>
  );
}
