// Settings page (P04B).
//
// Read-only view of the persisted `settings.json` (currently just
// `lan_enabled`). The toggle is rendered for visual completeness but
// disabled — runtime toggling requires restarting the pairing + WS
// servers on a different bind address, which is out of scope for v1.
// See open question 24.

import { useEffect, useState } from 'react';
import type { SettingsView } from '../../../preload/ipc-channels';

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) {
      // jsdom / no-preload smoke path — render defaults so the test
      // assertions still find the expected copy.
      setSettings({ version: 1, lan_enabled: true });
      return;
    }
    void bridge.settings.get().then(setSettings);
  }, []);

  if (settings === null) {
    return (
      <section aria-busy="true">
        <h2>Settings</h2>
        <p>Loading…</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Settings</h2>
      <p>
        Toggling LAN exposure or other settings at runtime is not supported in v1. Edit
        <code> userData/settings.json </code> and restart the app to change them.
      </p>
      <ul>
        <li>
          <label>
            <input
              type="checkbox"
              checked={settings.lan_enabled}
              disabled
              aria-label="LAN exposure (read-only)"
            />{' '}
            <strong>LAN exposure</strong> — when enabled, the pairing + WS server binds to
            <code> 0.0.0.0:18789</code> and advertises via Bonjour. Disabled keeps it loopback-only.
          </label>
        </li>
      </ul>
    </section>
  );
}
