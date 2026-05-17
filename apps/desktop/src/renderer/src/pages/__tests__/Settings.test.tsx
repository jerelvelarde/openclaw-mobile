// Tests for the Settings page (P04B + P11B).
//
// We stub `window.api` so the clawg-ui pairing banner code paths are
// exercised against a fake bridge. The default `gateway_mode = 'stub'`
// path uses the no-bridge fallback (already covered by App.test.tsx).

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawgUiPairingState } from '@openclaw/protocol';
import { Settings } from '../Settings';

interface FakeBridge {
  settings: { get: ReturnType<typeof vi.fn> };
  clawgUi: {
    getState: ReturnType<typeof vi.fn>;
    onStateChange: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    deny: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
}

let bridgeListeners: Array<(s: ClawgUiPairingState) => void>;

function installBridge(opts: {
  gatewayMode?: 'stub' | 'clawg-ui';
  initialState?: ClawgUiPairingState;
}): FakeBridge {
  bridgeListeners = [];
  const bridge: FakeBridge = {
    settings: {
      get: vi.fn(async () => ({
        version: 1,
        lan_enabled: true,
        gateway_mode: opts.gatewayMode ?? 'clawg-ui',
      })),
    },
    clawgUi: {
      getState: vi.fn(async () => opts.initialState ?? { status: 'idle' }),
      onStateChange: vi.fn((handler: (s: ClawgUiPairingState) => void) => {
        bridgeListeners.push(handler);
        return () => {
          bridgeListeners = bridgeListeners.filter((h) => h !== handler);
        };
      }),
      approve: vi.fn(async () => ({
        ok: true,
        stdout: 'approved',
        stderr: '',
        exitCode: 0,
        binaryPath: '/usr/local/bin/openclaw',
      })),
      deny: vi.fn(async () => true),
      dismiss: vi.fn(async () => true),
    },
  };
  // jsdom's `window` is the actual DOM window; assign the api property
  // onto it directly rather than re-creating the window object.
  (window as unknown as { api: FakeBridge }).api = bridge;
  return bridge;
}

describe('<Settings /> — clawg-ui pairing banner (P11B)', () => {
  beforeEach(() => {
    bridgeListeners = [];
  });

  afterEach(() => {
    // Reset jsdom's window.api so unrelated tests don't see the stub.
    delete (window as unknown as { api?: unknown }).api;
  });

  it('does not render the banner when in stub mode', async () => {
    installBridge({ gatewayMode: 'stub', initialState: { status: 'pending', pairingCode: 'X' } });
    render(<Settings />);
    await waitFor(() => expect(screen.getByText(/Toggling LAN exposure/i)).toBeDefined());
    expect(screen.queryByTestId('clawg-ui-pairing-banner')).toBeNull();
  });

  it('renders the pairing banner with the code when clawg-ui mode + pending', async () => {
    installBridge({
      gatewayMode: 'clawg-ui',
      initialState: { status: 'pending', pairingCode: 'ABCD1234' },
    });
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('clawg-ui-pairing-banner')).toBeDefined();
      expect(screen.getByTestId('clawg-ui-pairing-code').textContent).toBe('ABCD1234');
    });
    expect(screen.getByTestId('clawg-ui-approve')).toBeDefined();
    expect(screen.getByTestId('clawg-ui-deny')).toBeDefined();
  });

  it('clicking Approve invokes the bridge approve handler', async () => {
    const bridge = installBridge({
      gatewayMode: 'clawg-ui',
      initialState: { status: 'pending', pairingCode: 'ABCD1234' },
    });
    render(<Settings />);
    await waitFor(() => screen.getByTestId('clawg-ui-approve'));
    fireEvent.click(screen.getByTestId('clawg-ui-approve'));
    await waitFor(() => expect(bridge.clawgUi.approve).toHaveBeenCalledWith('ABCD1234'));
  });

  it('clicking Deny invokes the bridge deny handler', async () => {
    const bridge = installBridge({
      gatewayMode: 'clawg-ui',
      initialState: { status: 'pending', pairingCode: 'ABCD1234' },
    });
    render(<Settings />);
    await waitFor(() => screen.getByTestId('clawg-ui-deny'));
    fireEvent.click(screen.getByTestId('clawg-ui-deny'));
    await waitFor(() => expect(bridge.clawgUi.deny).toHaveBeenCalled());
  });

  it('shows the error message when the state machine transitions to error', async () => {
    installBridge({
      gatewayMode: 'clawg-ui',
      initialState: { status: 'pending', pairingCode: 'ABCD1234' },
    });
    render(<Settings />);
    await waitFor(() => screen.getByTestId('clawg-ui-pairing-banner'));
    // Push an error state via the subscription callback.
    expect(bridgeListeners.length).toBeGreaterThan(0);
    bridgeListeners[0]!({ status: 'error', message: 'openclaw binary missing' });
    await waitFor(() => {
      expect(screen.getByTestId('clawg-ui-error').textContent).toContain('openclaw binary missing');
    });
  });
});
