// Canvas `list` node. Read-only bullet/numbered list of strings. We render
// the marker inline because RN doesn't have CSS `list-style-type`; that
// keeps the visual identical on native + web.

import { StyleSheet, Text, View } from 'react-native';

import type { ListNode } from '@openclaw/protocol';

import { colors, fontSize, spacing } from '../../theme';

export function ListNodeView({ node }: { node: ListNode }): React.ReactElement {
  const ordered = node.ordered === true;
  return (
    <View style={styles.list} testID={`canvas-list-${node.id}`}>
      {node.items.map((item, index) => {
        const marker = ordered ? `${index + 1}.` : '•';
        return (
          <View
            key={`${node.id}-item-${index}`}
            style={styles.row}
            testID={`canvas-list-${node.id}-item-${index}`}
          >
            <Text style={styles.marker}>{marker}</Text>
            <Text style={styles.item}>{item}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    flexDirection: 'column',
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.xs,
  },
  marker: {
    color: colors.muted,
    fontSize: fontSize.md,
    minWidth: 20,
  },
  item: {
    color: colors.text,
    fontSize: fontSize.md,
    flex: 1,
  },
});
