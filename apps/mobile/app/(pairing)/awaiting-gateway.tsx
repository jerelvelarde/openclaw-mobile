// Pairing — waiting-for-gateway intermediate screen (P11B).
//
// Shown after the mobile app POSTs to the clawg-ui endpoint and receives
// the initial `403 pairing_pending`. Mirrors the shape of `(pairing)/code.tsx`
// so the user sees a consistent "big code + spinner" affordance, but
// keyed to clawg-ui's pairing code (alphanumeric, 4-16 chars) rather
// than our P03B 6-digit code.
//
// Lives in the `(pairing)` route group so the existing layout chrome
// (header-less stack) wraps it without ceremony. The screen is reached
// imperatively from P11A's transport client — there's no welcome →
// awaiting-gateway navigation; the screen is only meaningful once the
// app has actually seen a pairing_pending response.

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useClawgUiPairing } from '../../src/clawgUi/ClawgUiPairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

export default function AwaitingGatewayScreen() {
  const router = useRouter();
  const { state, dismiss } = useClawgUiPairing();

  // Once the desktop's wrap of `openclaw pairing approve` lands and
  // the transport's next retry succeeds, the provider flips to
  // `approved` and we drop into the tabs. The dismiss button is the
  // only escape hatch if the user wants to back out before approval.
  useEffect(() => {
    if (state.status === 'approved') {
      router.replace('/(tabs)');
    }
  }, [state.status, router]);

  const handleDismiss = (): void => {
    void dismiss();
    router.replace('/(pairing)/welcome');
  };

  return (
    <View style={styles.container} testID="clawg-ui-awaiting-gateway">
      <View style={styles.header}>
        <Text style={styles.title}>Waiting for gateway approval…</Text>
        <Text style={styles.paragraph}>
          Approve this device on the OpenClaw desktop app on your Mac (the same Mac that hosts your
          gateway).
        </Text>
      </View>

      <View style={styles.codeBox}>
        <Text style={styles.codeLabel}>Pairing code</Text>
        <Text style={styles.code} testID="clawg-ui-pairing-code">
          {state.status === 'pending' ? state.pairingCode : '—'}
        </Text>
        <View style={styles.spinnerRow}>
          {state.status === 'pending' ? <ActivityIndicator color={colors.accent} /> : null}
          <Text style={styles.spinnerLabel}>
            {state.status === 'approved'
              ? 'Approved — opening…'
              : state.status === 'error'
                ? 'Could not pair'
                : state.status === 'denied'
                  ? 'Dismissed'
                  : 'Waiting for your desktop to approve…'}
          </Text>
        </View>
      </View>

      {state.status === 'error' ? (
        <Text style={styles.error} testID="clawg-ui-error">
          {state.message}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        onPress={handleDismiss}
        style={styles.dismissButton}
        testID="clawg-ui-awaiting-dismiss"
      >
        <Text style={styles.dismissButtonLabel}>Cancel</Text>
      </Pressable>
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
  codeLabel: { color: colors.muted, fontSize: fontSize.sm, textTransform: 'uppercase' },
  code: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
  spinnerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  spinnerLabel: { color: colors.muted, fontSize: fontSize.sm },
  error: { color: colors.danger, fontSize: fontSize.sm },
  dismissButton: {
    borderColor: colors.muted,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  dismissButtonLabel: { color: colors.muted, fontSize: fontSize.md, fontWeight: '600' },
});
