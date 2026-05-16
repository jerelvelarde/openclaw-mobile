// Settings tab. Full design lands in P09A; for P03A we expose only the
// re-pair stub button required by `.chalk/plans/P03A-mobile-pairing-ui.md`
// success criteria (clears the persisted token and returns to welcome).

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

export default function SettingsScreen() {
  const { resetPairing } = usePairing();

  return (
    <View style={styles.container} testID="settings-screen">
      <Text style={styles.title}>Settings (P09A)</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void resetPairing();
        }}
        style={styles.repairButton}
        testID="settings-repair"
      >
        <Text style={styles.repairLabel}>Re-pair this device</Text>
        <Text style={styles.repairHint}>
          Clears the stored pairing token and returns to the welcome screen.
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg, gap: spacing.lg },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  repairButton: {
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  repairLabel: { color: colors.danger, fontSize: fontSize.md, fontWeight: '600' },
  repairHint: { color: colors.muted, fontSize: fontSize.xs },
});
