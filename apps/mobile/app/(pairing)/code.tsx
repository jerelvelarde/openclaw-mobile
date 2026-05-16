// Pairing — code screen.
//
// Big 6-digit code + a "waiting for approval" spinner. The user is supposed
// to approve the request in the desktop companion (`.chalk/desktop-app.md`
// §3). For P03A there is no real desktop app yet — a dev-only "Simulate
// approval" button calls `mock._approvePairing(code)` so the flow can be
// exercised end-to-end.
//
// Once the gateway signals approval, `PairingProvider` flips the reducer to
// `paired` and persists the token; an effect here navigates to `(tabs)`.

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { InMemoryMockGateway } from '../../src/openclaw/gateway';
import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

export default function PairingCodeScreen() {
  const router = useRouter();
  const { state, code, error, gateway } = usePairing();

  // When the reducer hits `paired`, navigate into the tabs. The replace()
  // (vs. push()) drops the entire pairing stack so back-button + history
  // don't accidentally land the user back on the code screen.
  useEffect(() => {
    if (state.status === 'paired') {
      router.replace('/(tabs)');
    }
  }, [state.status, router]);

  const simulateApproval = () => {
    if (!code) return;
    // Only the in-memory mock has `_approvePairing`. Any real `GatewayClient`
    // from P04A onwards must NOT expose this — desktop drives approval.
    if (!(gateway instanceof InMemoryMockGateway)) return;
    try {
      gateway._approvePairing(code);
    } catch {
      // The provider's `awaitPaired` consumer surfaces failures via the
      // reducer; nothing further to do here.
    }
  };

  return (
    <View style={styles.container} testID="pairing-code">
      <View style={styles.header}>
        <Text style={styles.title}>Pairing code</Text>
        <Text style={styles.paragraph}>
          Approve this code in the OpenClaw desktop app on your Mac.
        </Text>
      </View>

      <View style={styles.codeBox}>
        <Text style={styles.code} testID="pairing-code-display">
          {code ?? '------'}
        </Text>
        <View style={styles.spinnerRow}>
          {state.status === 'awaiting_approval' ? (
            <ActivityIndicator color={colors.accent} />
          ) : null}
          <Text style={styles.spinnerLabel}>
            {state.status === 'paired' ? 'Approved — opening…' : 'Waiting for approval…'}
          </Text>
        </View>
      </View>

      {error ? (
        <Text style={styles.error} testID="pairing-code-error">
          {error}
        </Text>
      ) : null}

      {gateway instanceof InMemoryMockGateway ? (
        <Pressable
          accessibilityRole="button"
          onPress={simulateApproval}
          style={styles.devButton}
          testID="pairing-code-simulate-approval"
        >
          <Text style={styles.devButtonLabel}>Simulate approval (dev only)</Text>
          <Text style={styles.devButtonHint}>
            Stands in for the desktop &quot;Approve&quot; click until P03B lands.
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.xl,
  },
  header: { gap: spacing.sm, marginTop: spacing.lg },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  paragraph: { color: colors.muted, fontSize: fontSize.md, lineHeight: 22 },
  codeBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'center',
  },
  code: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
  },
  spinnerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spinnerLabel: { color: colors.muted, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  devButton: {
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  devButtonLabel: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
  devButtonHint: { color: colors.muted, fontSize: fontSize.xs },
});
