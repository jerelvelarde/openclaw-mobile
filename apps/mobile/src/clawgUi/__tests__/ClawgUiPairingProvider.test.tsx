// Render test for `ClawgUiPairingProvider` + the `useClawgUiPairing` hook (P11B).
//
// Asserts the state-machine transitions surface through the hook and
// that the bearer token is persisted via the injected storage stub
// when a `pairing_pending` 403 lands.

import { Text, View } from 'react-native';
import { render, act } from '@testing-library/react-native';

import {
  ClawgUiPairingProvider,
  useClawgUiPairing,
  type ClawgUiPairingContextValue,
} from '../ClawgUiPairingProvider';

function Probe({
  onMount,
}: {
  onMount: (ctx: ClawgUiPairingContextValue) => void;
}): React.ReactElement {
  const ctx = useClawgUiPairing();
  onMount(ctx);
  return (
    <View>
      <Text testID="state">{JSON.stringify(ctx.state)}</Text>
    </View>
  );
}

describe('ClawgUiPairingProvider', () => {
  it('starts in idle', () => {
    const captured: ClawgUiPairingContextValue[] = [];
    render(
      <ClawgUiPairingProvider>
        <Probe onMount={(c) => captured.push(c)} />
      </ClawgUiPairingProvider>,
    );
    expect(captured[0]!.state).toEqual({ status: 'idle' });
  });

  it('transitions to pending and persists the token', async () => {
    const saved: string[] = [];
    const captured: ClawgUiPairingContextValue[] = [];
    render(
      <ClawgUiPairingProvider
        storage={{
          saveToken: async (t) => {
            saved.push(t);
          },
          clearToken: async () => {
            saved.length = 0;
          },
        }}
      >
        <Probe onMount={(c) => captured.push(c)} />
      </ClawgUiPairingProvider>,
    );

    await act(async () => {
      await captured[0]!.notifyPending({ pairingCode: 'ABCD1234', token: 'jwt.fake.token' });
    });

    const latest = captured[captured.length - 1]!;
    expect(latest.state).toEqual({ status: 'pending', pairingCode: 'ABCD1234' });
    expect(saved).toEqual(['jwt.fake.token']);
  });

  it('flips to approved on notifyApproved', async () => {
    const captured: ClawgUiPairingContextValue[] = [];
    render(
      <ClawgUiPairingProvider
        storage={{
          saveToken: async () => {},
          clearToken: async () => {},
        }}
      >
        <Probe onMount={(c) => captured.push(c)} />
      </ClawgUiPairingProvider>,
    );
    await act(async () => {
      await captured[0]!.notifyPending({ pairingCode: 'ABCD1234', token: 't' });
    });
    act(() => {
      captured[captured.length - 1]!.notifyApproved();
    });
    expect(captured[captured.length - 1]!.state).toEqual({ status: 'approved' });
  });

  it('surfaces a storage write failure as an error state', async () => {
    const captured: ClawgUiPairingContextValue[] = [];
    render(
      <ClawgUiPairingProvider
        storage={{
          saveToken: async () => {
            throw new Error('disk full');
          },
          clearToken: async () => {},
        }}
      >
        <Probe onMount={(c) => captured.push(c)} />
      </ClawgUiPairingProvider>,
    );
    await act(async () => {
      await captured[0]!.notifyPending({ pairingCode: 'ABCD1234', token: 't' });
    });
    const latest = captured[captured.length - 1]!;
    expect(latest.state.status).toBe('error');
    if (latest.state.status === 'error') {
      expect(latest.state.message).toContain('disk full');
    }
  });

  it('rejects a malformed pairingCode at the schema boundary', async () => {
    const captured: ClawgUiPairingContextValue[] = [];
    render(
      <ClawgUiPairingProvider
        storage={{
          saveToken: async () => {},
          clearToken: async () => {},
        }}
      >
        <Probe onMount={(c) => captured.push(c)} />
      </ClawgUiPairingProvider>,
    );
    await expect(
      captured[0]!.notifyPending({ pairingCode: 'has space', token: 't' }),
    ).rejects.toThrow();
  });

  it('returns an inert no-op context when no provider is mounted', () => {
    const captured: ClawgUiPairingContextValue[] = [];
    render(<Probe onMount={(c) => captured.push(c)} />);
    expect(captured[0]!.state).toEqual({ status: 'idle' });
    // notifyApproved should be safely callable on the inert context.
    expect(() => captured[0]!.notifyApproved()).not.toThrow();
  });
});
