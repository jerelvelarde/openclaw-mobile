// Canvas `button` node. Press → dispatches a `click` event with `{ action }`
// as the payload (echo of `ButtonNode.action`, per the v1 spec).

import { Pressable, StyleSheet, Text } from 'react-native';

import type { ButtonNode } from '@openclaw/protocol';

import { colors, fontSize, radius, spacing } from '../../theme';
import { useCanvasContext } from '../CanvasContext';

/** Visual treatment per variant. Defaults to `primary`. */
const VARIANT_STYLES: Record<NonNullable<ButtonNode['variant']>, { bg: string; fg: string }> = {
  primary: { bg: colors.accent, fg: colors.bg },
  secondary: { bg: colors.surface, fg: colors.text },
  destructive: { bg: colors.danger, fg: colors.bg },
};

export function ButtonNodeView({ node }: { node: ButtonNode }): React.ReactElement {
  const { dispatchEvent } = useCanvasContext();
  const variant = VARIANT_STYLES[node.variant ?? 'primary'];

  const onPress = (): void => {
    // The spec says `payload` is `{ action }` for `click`. Pass through
    // whatever the node declares; agents can echo it back to dispatch.
    dispatchEvent(node.id, 'click', node.action ? { action: node.action } : {});
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={node.label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: variant.bg, opacity: pressed ? 0.7 : 1 },
      ]}
      testID={`canvas-button-${node.id}`}
    >
      <Text style={[styles.label, { color: variant.fg }]}>{node.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
