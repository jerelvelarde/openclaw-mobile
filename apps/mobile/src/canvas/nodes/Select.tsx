// Canvas `select` node. v1 ships a hand-rolled pressable list rather than
// `@react-native-picker/picker` so we don't add a native dep just for one
// node type — and so the renderer stays identical across iOS / Android / web.
// Tapping an option fires a `change` event with `{ name, value }`.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SelectNode } from '@openclaw/protocol';

import { colors, fontSize, radius, spacing } from '../../theme';
import { useCanvasContext } from '../CanvasContext';

export function SelectNodeView({ node }: { node: SelectNode }): React.ReactElement {
  const { dispatchEvent } = useCanvasContext();
  const onSelect = (value: string): void => {
    dispatchEvent(node.id, 'change', { name: node.name, value });
  };
  return (
    <View
      style={styles.group}
      accessibilityRole="radiogroup"
      accessibilityLabel={node.name}
      testID={`canvas-select-${node.id}`}
    >
      {node.options.map((opt) => {
        const selected = opt.value === node.value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onSelect(opt.value)}
            style={({ pressed }) => [
              styles.option,
              selected ? styles.optionSelected : null,
              pressed ? styles.optionPressed : null,
            ]}
            testID={`canvas-select-${node.id}-option-${opt.value}`}
          >
            <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  option: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.surface,
  },
  optionSelected: {
    borderColor: colors.accent,
  },
  optionPressed: {
    opacity: 0.7,
  },
  optionLabel: {
    color: colors.text,
    fontSize: fontSize.md,
  },
  optionLabelSelected: {
    color: colors.accent,
    fontWeight: '600',
  },
});
