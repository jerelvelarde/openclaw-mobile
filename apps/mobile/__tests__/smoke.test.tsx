// Smoke test: confirms that jest-expo + react-native-testing-library can
// render the home placeholder so future per-feature plans inherit a working
// test harness. Per P02A we deliberately don't mount the full Expo Router
// tree — that lands in P03A onwards.
import { render, screen } from '@testing-library/react-native';

import HomeScreen from '../app/(tabs)/index';
import { InMemoryMockGateway } from '../src/openclaw/gateway';

describe('mobile smoke', () => {
  it('renders the home placeholder', () => {
    render(<HomeScreen />);
    expect(screen.getByTestId('home-screen')).toBeTruthy();
    expect(screen.getByText('Home (P05A)')).toBeTruthy();
  });

  it('imports the @openclaw/protocol gateway re-export', () => {
    // Type-level: `InMemoryMockGateway` is the concrete class from the
    // protocol package re-exported through `src/openclaw/gateway.ts`.
    // Runtime: just instantiating it confirms the workspace link resolves.
    const gw = new InMemoryMockGateway();
    expect(typeof gw.requestPairing).toBe('function');
  });
});
