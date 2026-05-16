// Renderer shell.
//
// P02B was just a "ping" smoke test. P03B turns this into a tiny multi-page
// shell: the bridge probe stays (it doubles as a sanity check that the
// preload pipeline still works) and we add two pages — `approve` (the
// pairing modal) and `devices` (the paired-devices list opened from the
// tray menu). Routing is hash-based to avoid pulling in a router; main
// can navigate by sending `pairing:navigate` events that flip the hash.

import type { Agent } from '@openclaw/protocol';
import { useEffect, useState } from 'react';
import { ApprovePairing } from './pages/ApprovePairing';
import { PairedDevices } from './pages/PairedDevices';

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

type Route = 'home' | 'approve' | 'devices';

function parseHash(hash: string): Route {
  const normalized = hash.replace(/^#\/?/, '');
  if (normalized === 'approve') return 'approve';
  if (normalized === 'devices') return 'devices';
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
        <a href="#/">Home</a> · <a href="#/approve">Pairing</a> · <a href="#/devices">Devices</a>
      </nav>
      {route === 'home' ? (
        <>
          <p>IPC bridge: {ping}</p>
          <p>
            Placeholder agent: <code>{PLACEHOLDER_AGENT.id}</code>
          </p>
        </>
      ) : null}
      {route === 'approve' ? <ApprovePairing /> : null}
      {route === 'devices' ? <PairedDevices /> : null}
    </main>
  );
}
