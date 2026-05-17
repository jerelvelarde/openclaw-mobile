// Canvas `heading` node. Pure presentational — no state, no events. Renders
// to an RN `<Text>` with a size derived from `level` (1–6). Web parity is
// free: RN-web maps `<Text>` to a `<div>` so all six levels render visually.

import { StyleSheet, Text } from 'react-native';

import type { HeadingNode } from '@openclaw/protocol';

import { colors, fontSize, spacing } from '../../theme';

/** Font size per heading level. Falls back to `fontSize.lg` for any out-of-range value. */
const LEVEL_SIZE: Record<NonNullable<HeadingNode['level']>, number> = {
  1: fontSize.xl,
  2: fontSize.lg,
  3: fontSize.md,
  4: fontSize.md,
  5: fontSize.sm,
  6: fontSize.sm,
};

export function HeadingNodeView({ node }: { node: HeadingNode }): React.ReactElement {
  const size = LEVEL_SIZE[node.level ?? 1];
  return (
    <Text
      accessibilityRole="header"
      style={[styles.heading, { fontSize: size }]}
      testID={`canvas-heading-${node.id}`}
    >
      {node.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  heading: {
    color: colors.text,
    fontWeight: '700',
    paddingVertical: spacing.xs,
  },
});
