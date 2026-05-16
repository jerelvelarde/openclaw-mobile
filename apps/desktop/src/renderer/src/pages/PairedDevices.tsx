// Paired-devices list page.
//
// Opened from the tray menu's "Paired devices…" entry (per P03B step
// 10). Shows every device that's been approved, sorted newest-first,
// with a Revoke button that calls back into main to drop the row from
// `devices.json`.

import { useCallback, useEffect, useState } from 'react';
import type { PairedDeviceView } from '../../../preload/ipc-channels';

export function PairedDevices(): JSX.Element {
  const [devices, setDevices] = useState<PairedDeviceView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) {
      setDevices([]);
      return;
    }
    setDevices(await bridge.pairing.listDevices());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const revoke = async (deviceId: string): Promise<void> => {
    const bridge = typeof window !== 'undefined' ? window.api : undefined;
    if (!bridge) return;
    setBusy(deviceId);
    try {
      await bridge.pairing.revokeDevice(deviceId);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (devices === null) {
    return (
      <section aria-busy="true">
        <h2>Paired devices</h2>
        <p>Loading…</p>
      </section>
    );
  }

  if (devices.length === 0) {
    return (
      <section>
        <h2>Paired devices</h2>
        <p>No devices paired yet. Pair a phone from the OpenClaw mobile app to see it here.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Paired devices</h2>
      <ul>
        {devices.map((device) => (
          <li key={device.device_id}>
            <strong>{device.device_name}</strong> · paired{' '}
            <time dateTime={new Date(device.paired_at).toISOString()}>
              {new Date(device.paired_at).toLocaleString()}
            </time>{' '}
            <button
              type="button"
              disabled={busy === device.device_id}
              onClick={() => void revoke(device.device_id)}
            >
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
