// Settings page (P04B, extended in P11A).
//
// Read-only view of the persisted `settings.json` (`lan_enabled` +
// `gateway_mode`). The toggles are rendered for visual completeness but
// disabled — runtime toggling requires restarting the pairing + WS
// servers on a different bind address, which is out of scope for v1.
// See open question 24.
//
// In P11A the `gateway_mode` enum changed from `"stub" | "real"` to
// `"stub" | "clawg-ui"`; legacy `"real"` values migrate to `"clawg-ui"`
// on read (see `main/settings.ts#coerceGatewayMode`).

import { useEffect, useState } from 'react';
import type { SettingsView } from '../../../preload/ipc-channels';

function describeGatewayMode(mode: SettingsView['gateway_mode']): string {
  switch (mode) {
    case 'clawg-ui':
      // The actual pairing-code surfacing lives in P11B once the
      // identity store is exposed over IPC. For now this is the
      // educational copy.
      return '— real-mode chat routes through the user\'s openclaw daemon via the @contextableai/clawg-ui plugin (POST /v1/clawg-ui). Canvas + voice + agents.setActive surface "unsupportedInRealMode" errors (tracked in P11C).';
    case 'stub':
    default:
      return '— in-process echo stub (default; full chat/canvas/voice surfaces, no external daemon).';
  }
}

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) {
      // jsdom / no-preload smoke path — render defaults so the test
      // assertions still find the expected copy.
      setSettings({ version: 1, lan_enabled: true, gateway_mode: 'stub' });
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
        <li>
          <label>
            <strong>Gateway mode:</strong> <code>{settings.gateway_mode}</code>{' '}
            <span aria-label="gateway mode (read-only)">
              {describeGatewayMode(settings.gateway_mode)}
            </span>
          </label>
        </li>
      </ul>
    </section>
  );
}
