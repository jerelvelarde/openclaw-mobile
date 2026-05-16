// Pairing — welcome screen. First-run entry per `.chalk/plan.md` §5: explain
// what's about to happen and route the user to the discover screen. Design
// polish lands in P09 — keep styling minimal for P03A.

import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, spacing } from '../../src/theme';

export default function PairingWelcomeScreen() {
  const router = useRouter();

  return (
    <View style={styles.container} testID="pairing-welcome">
      <View style={styles.header}>
        <Text style={styles.title}>Pair with your Mac</Text>
        <Text style={styles.paragraph}>
          OpenClaw runs as a daemon on your always-on Mac. To use it from this device, we&apos;ll
          pair with the desktop companion next: pick your Mac, then approve the 6-digit code that
          appears in the menu-bar app.
        </Text>
        <Text style={styles.paragraph}>
          Make sure the desktop app is running before continuing.
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        style={styles.button}
        testID="pairing-welcome-continue"
        onPress={() => router.push('/(pairing)/discover')}
      >
        <Text style={styles.buttonLabel}>Continue</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    justifyContent: 'space-between',
  },
  header: { gap: spacing.md, marginTop: spacing.xl },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  paragraph: { color: colors.muted, fontSize: fontSize.md, lineHeight: 22 },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  buttonLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
});
