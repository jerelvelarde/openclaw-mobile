// Renderer shell.
//
// P02B was a "ping" smoke test. P03B turned this into a hash-routed
// shell with `approve` + `devices` pages. P04B added Settings, and
// P05B layers Chat + Agents on top. Routing stays hash-based so the
// main process can navigate (`webContents.send(IPC.NAVIGATE, '/chat')`)
// by flipping `window.location.hash`. Tray click → `/chat`.

import type { Agent } from '@openclaw/protocol';
import { useEffect, useState } from 'react';
import { Agents } from './pages/Agents';
import { ApprovePairing } from './pages/ApprovePairing';
import { Chat } from './pages/Chat';
import { PairedDevices } from './pages/PairedDevices';
import { Settings } from './pages/Settings';

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

type Route = 'home' | 'chat' | 'agents' | 'approve' | 'devices' | 'settings';

function parseHash(hash: string): Route {
  const normalized = hash.replace(/^#\/?/, '');
  if (normalized === 'chat') return 'chat';
  if (normalized === 'agents') return 'agents';
  if (normalized === 'approve') return 'approve';
  if (normalized === 'devices') return 'devices';
  if (normalized === 'settings') return 'settings';
  return 'home';
}

export function App(): JSX.Element {
  const initialRoute: Route =
    typeof window !== 'undefined' ? parseHash(window.location.hash) : 'home';
  const [route, setRoute] = useState<Route>(initialRoute);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    const bridge = window.api;
    const unsub = bridge?.pairing.onNavigate((target) => {
      window.location.hash = target;
    });
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      unsub?.();
    };
  }, []);

  // `window.api` is exposed by preload/index.ts. In Vitest under jsdom the
  // preload script doesn't run, so we guard the access.
  const ping = typeof window !== 'undefined' && window.api ? window.api.ping() : '(no bridge)';

  return (
    <main>
      <h1>openclaw-desktop</h1>
      <nav aria-label="primary">
        <a href="#/">Home</a> · <a href="#/chat">Chat</a> · <a href="#/agents">Agents</a> ·{' '}
        <a href="#/approve">Pairing</a> · <a href="#/devices">Devices</a> ·{' '}
        <a href="#/settings">Settings</a>
      </nav>
      {route === 'home' ? (
        <>
          <p>IPC bridge: {ping}</p>
          <p>
            Placeholder agent: <code>{PLACEHOLDER_AGENT.id}</code>
          </p>
          <p>
            Click <a href="#/chat">Chat</a> to talk to your agent, or use the tray icon.
          </p>
        </>
      ) : null}
      {route === 'chat' ? <Chat /> : null}
      {route === 'agents' ? <Agents /> : null}
      {route === 'approve' ? <ApprovePairing /> : null}
      {route === 'devices' ? <PairedDevices /> : null}
      {route === 'settings' ? <Settings /> : null}
    </main>
  );
}
