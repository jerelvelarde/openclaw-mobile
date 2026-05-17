// Render test for the (pairing)/awaiting-gateway intermediate screen (P11B).
//
// Verifies:
//   - The screen shows the pairing code when the provider is in `pending`.
//   - Clicking the dismiss button calls `dismiss()` and routes back to
//     the pairing welcome screen.

const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
}));

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import AwaitingGatewayScreen from '../app/(pairing)/awaiting-gateway';
import {
  ClawgUiPairingProvider,
  useClawgUiPairing,
  type ClawgUiPairingContextValue,
} from '../src/clawgUi/ClawgUiPairingProvider';

describe('AwaitingGatewayScreen', () => {
  beforeEach(() => {
    mockReplace.mockClear();
  });

  it('renders the placeholder when idle', () => {
    render(
      <ClawgUiPairingProvider>
        <AwaitingGatewayScreen />
      </ClawgUiPairingProvider>,
    );
    expect(screen.getByTestId('clawg-ui-awaiting-gateway')).toBeTruthy();
    // Code box renders the dash placeholder before a pending state.
    expect(screen.getByTestId('clawg-ui-pairing-code').props.children).toBe('—');
  });

  it('shows the pairing code when the provider is pending', async () => {
    let captured: ClawgUiPairingContextValue | null = null;
    function Capture(): null {
      captured = useClawgUiPairing();
      return null;
    }
    render(
      <ClawgUiPairingProvider>
        <Capture />
        <AwaitingGatewayScreen />
      </ClawgUiPairingProvider>,
    );

    await captured!.notifyPending({ pairingCode: 'ABCD1234', token: 't' });
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
  });

  it('routes home on dismiss', async () => {
    render(
      <ClawgUiPairingProvider>
        <AwaitingGatewayScreen />
      </ClawgUiPairingProvider>,
    );
    await act(async () => {
      fireEvent.press(screen.getByTestId('clawg-ui-awaiting-dismiss'));
    });
    expect(mockReplace).toHaveBeenCalledWith('/(pairing)/welcome');
  });
});
