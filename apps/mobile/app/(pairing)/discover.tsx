// Pairing — discover screen.
//
// For P03A this hardcodes a single "Mock Mac mini" entry that proxies to the
// in-memory mock gateway. Real Bonjour browse (and the "paste URL" input
// becoming functional) lands in P04A — `react-native-zeroconf` requires a
// custom dev client which is outside P03A's scope. The disabled paste-URL
// field stays here so the IA matches `.chalk/plan.md` §5.

import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

const MOCK_HOST = {
  id: 'mock-mac-mini',
  name: 'Mock Mac mini',
  hint: 'In-memory mock gateway (P03A) — real Bonjour browse lands in P04A',
};

export default function PairingDiscoverScreen() {
  const router = useRouter();
  const { state, selectHost, error } = usePairing();

  // Once the gateway issues a code, advance to the code screen. Doing this in
  // an effect (vs. inline after `selectHost`) keeps the navigation reactive
  // to state changes — if a re-render happens mid-flight, we still navigate.
  useEffect(() => {
    if (state.status === 'awaiting_approval') {
      router.push('/(pairing)/code');
    }
  }, [state.status, router]);

  const onSelect = async () => {
    // `Device.modelName` would be ideal here but `expo-device` isn't in the
    // mobile package's deps yet (P02A only pulled in the routing essentials).
    // For P03A a friendly placeholder is enough — the mock doesn't read it,
    // and the real desktop UI's "Pair iPhone (Name)" copy is wired up when
    // we add `expo-device` alongside the real WS client in P04A.
    await selectHost(MOCK_HOST.id, 'OpenClaw mobile');
  };

  const isBusy = state.status === 'requesting' || state.status === 'awaiting_approval';

  return (
    <View style={styles.container} testID="pairing-discover">
      <View style={styles.header}>
        <Text style={styles.title}>Pick your Mac</Text>
        <Text style={styles.paragraph}>
          We&apos;ll show you a 6-digit code, then ask you to approve it in the desktop app.
        </Text>
      </View>

      <Pressable
        accessibilityRole="button"
        style={[styles.hostRow, isBusy && styles.hostRowBusy]}
        disabled={isBusy}
        onPress={onSelect}
        testID="pairing-discover-host"
      >
        <View>
          <Text style={styles.hostName}>{MOCK_HOST.name}</Text>
          <Text style={styles.hostHint}>{MOCK_HOST.hint}</Text>
        </View>
        <Text style={styles.hostAction}>{isBusy ? 'Requesting…' : 'Pair'}</Text>
      </Pressable>

      {error ? (
        <Text style={styles.error} testID="pairing-discover-error">
          {error}
        </Text>
      ) : null}

      <View style={styles.pasteBlock}>
        <Text style={styles.pasteLabel}>Or paste a gateway URL</Text>
        <TextInput
          editable={false}
          placeholder="ws://… (available in P04A)"
          placeholderTextColor={colors.muted}
          style={styles.pasteInput}
          testID="pairing-discover-paste"
        />
        <Text style={styles.pasteHint}>
          Manual URL entry is wired up alongside the real WS client (P04A).
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  header: { gap: spacing.sm, marginTop: spacing.lg },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  paragraph: { color: colors.muted, fontSize: fontSize.md, lineHeight: 22 },
  hostRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  hostRowBusy: { opacity: 0.6 },
  hostName: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  hostHint: { color: colors.muted, fontSize: fontSize.xs, marginTop: spacing.xs },
  hostAction: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
  error: { color: colors.danger, fontSize: fontSize.sm },
  pasteBlock: { gap: spacing.sm, marginTop: spacing.lg },
  pasteLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  pasteInput: {
    borderColor: colors.muted,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
    opacity: 0.6,
  },
  pasteHint: { color: colors.muted, fontSize: fontSize.xs },
});
