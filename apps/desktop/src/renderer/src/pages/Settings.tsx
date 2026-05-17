// Settings page (P04B + P11B).
//
// Read-only view of the persisted `settings.json`, plus an interactive
// banner for the clawg-ui pairing flow (P11B). The banner only renders
// when `gateway_mode === "clawg-ui"` and there's a pending pairing
// request — the rest of the time the page is a static description of
// the toggles.

import { useEffect, useState } from 'react';
import type { ClawgUiPairingState } from '@openclaw/protocol';
import type { SettingsView } from '../../../preload/ipc-channels';

export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [clawgUiState, setClawgUiState] = useState<ClawgUiPairingState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);

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

  useEffect(() => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge?.clawgUi) return;
    void bridge.clawgUi.getState().then(setClawgUiState);
    const unsub = bridge.clawgUi.onStateChange((next) => {
      setClawgUiState(next);
    });
    return unsub;
  }, []);

  const approve = async (pairingCode: string): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge?.clawgUi) return;
    setBusy(true);
    setDiagnostic(null);
    try {
      const result = await bridge.clawgUi.approve(pairingCode);
      if (!result.ok) {
        setDiagnostic(
          result.error ??
            `openclaw exited with code ${result.exitCode ?? 'null'}: ${result.stderr || result.stdout || 'unknown error'}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const deny = async (): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge?.clawgUi) return;
    setBusy(true);
    try {
      await bridge.clawgUi.deny('user clicked Deny in Settings banner');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge?.clawgUi) return;
    await bridge.clawgUi.dismiss();
  };

  if (settings === null) {
    return (
      <section aria-busy="true">
        <h2>Settings</h2>
        <p>Loading…</p>
      </section>
    );
  }

  const showClawgUiBanner = settings.gateway_mode === 'clawg-ui' && clawgUiState.status !== 'idle';

  return (
    <section>
      <h2>Settings</h2>
      {showClawgUiBanner ? (
        <div
          role="region"
          aria-label="clawg-ui pairing request"
          data-testid="clawg-ui-pairing-banner"
          style={{
            border: '1px solid currentColor',
            borderRadius: 4,
            padding: '0.75em 1em',
            marginBottom: '1em',
          }}
        >
          <strong>OpenClaw gateway requested pairing</strong>
          {clawgUiState.status === 'pending' ? (
            <>
              <p>
                A new device wants to pair with your gateway. Approve to run
                <code>
                  {' '}
                  openclaw pairing approve clawg-ui <strong>{clawgUiState.pairingCode}</strong>{' '}
                </code>
                on this Mac.
              </p>
              <p>
                <code
                  aria-label="clawg-ui pairing code"
                  style={{ fontSize: '1.4em', letterSpacing: '0.2em' }}
                  data-testid="clawg-ui-pairing-code"
                >
                  {clawgUiState.pairingCode}
                </code>
              </p>
              <div role="group" aria-label="clawg-ui-pairing-decision">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void approve(clawgUiState.pairingCode)}
                  data-testid="clawg-ui-approve"
                >
                  Approve
                </button>{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void deny()}
                  data-testid="clawg-ui-deny"
                >
                  Deny
                </button>
              </div>
            </>
          ) : null}
          {clawgUiState.status === 'approved' ? (
            <p>
              Approved. The next chat run from your phone will succeed.{' '}
              <button type="button" onClick={() => void dismiss()}>
                Dismiss
              </button>
            </p>
          ) : null}
          {clawgUiState.status === 'denied' ? (
            <p>
              Dismissed. The pairing code will time out on its own (clawg-ui has no reject command).
              {clawgUiState.reason ? <> Reason: {clawgUiState.reason}.</> : null}{' '}
              <button type="button" onClick={() => void dismiss()}>
                Hide
              </button>
            </p>
          ) : null}
          {clawgUiState.status === 'error' ? (
            <p data-testid="clawg-ui-error">
              Could not approve: {clawgUiState.message}{' '}
              <button type="button" onClick={() => void dismiss()}>
                Hide
              </button>
            </p>
          ) : null}
          {diagnostic ? <p style={{ opacity: 0.7 }}>Diagnostic: {diagnostic}</p> : null}
        </div>
      ) : null}
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
              {settings.gateway_mode === 'clawg-ui'
                ? '— bridging to the clawg-ui plugin on your openclaw gateway (canvas + voice not yet supported in this mode)'
                : '— in-process echo stub (default; full chat/canvas/voice surfaces)'}
            </span>
          </label>
        </li>
      </ul>
    </section>
  );
}
