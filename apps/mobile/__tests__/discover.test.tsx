// Discover-screen render test.
//
// Mocks the Bonjour browse helper (so we don't need a native `Zeroconf`
// instance under jest-expo) and asserts:
//
//   - the screen renders the "searching" empty state on first paint,
//   - once the mocked browse emits a host, the row appears with the
//     `pairing-discover-host-<id>` testID the rest of the flow uses.
//
// Renders `<PairingDiscoverScreen>` directly with a `<PairingProvider>`
// wrapper. We pass a fresh `InMemoryMockGateway` to the provider so taps
// don't try to actually hit the network — but this test only asserts the
// browse-driven render path, so we never tap.

// expo-router uses a turbo-style entry that needs to be mocked at the
// module boundary; the smoke test got away without it because HomeScreen
// doesn't import the router. Discover does (via `useRouter`), so we shim
// the hook with a no-op implementation.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

import type { DiscoveredHost } from '../src/openclaw/gateway';

// Mock the Bonjour wrapper. We capture the registered handlers so the
// test can drive `onFound` events deterministically.
const browseHandlers: { onFound?: (h: DiscoveredHost) => void; onLost?: (id: string) => void } = {};
jest.mock('../src/openclaw/transport/bonjour', () => ({
  browse: (opts: { onFound: (h: DiscoveredHost) => void; onLost: (id: string) => void }) => {
    browseHandlers.onFound = opts.onFound;
    browseHandlers.onLost = opts.onLost;
    return () => {
      /* no-op unsubscribe */
    };
  },
}));

// We also need to stub expo-secure-store so PairingProvider's mount-time
// `loadPairingToken` doesn't blow up the test. Same pattern as the store
// test in `src/pairing/__tests__/store.test.ts`.
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import { act, render, screen } from '@testing-library/react-native';

import PairingDiscoverScreen from '../app/(pairing)/discover';
import { PairingProvider } from '../src/pairing/PairingProvider';

describe('PairingDiscoverScreen', () => {
  it('renders the empty-state hint before any host is found', () => {
    render(
      <PairingProvider>
        <PairingDiscoverScreen />
      </PairingProvider>,
    );
    expect(screen.getByTestId('pairing-discover')).toBeTruthy();
    expect(screen.getByTestId('pairing-discover-empty')).toBeTruthy();
  });

  it('renders a discovered host after the mocked browser emits one', async () => {
    jest.useFakeTimers();
    render(
      <PairingProvider>
        <PairingDiscoverScreen />
      </PairingProvider>,
    );

    expect(browseHandlers.onFound).toBeDefined();
    act(() => {
      browseHandlers.onFound!({
        id: 'Jerel-Mac',
        name: 'Jerel-Mac',
        host: '192.168.1.42',
        port: 18789,
        httpBase: 'http://192.168.1.42:18789',
      });
      // Burn the 200ms discovery debounce.
      jest.advanceTimersByTime(250);
    });

    expect(screen.getByTestId('pairing-discover-host-Jerel-Mac')).toBeTruthy();
    expect(screen.getByText('Jerel-Mac')).toBeTruthy();
    expect(screen.getByText('192.168.1.42:18789')).toBeTruthy();

    jest.useRealTimers();
  });
});
