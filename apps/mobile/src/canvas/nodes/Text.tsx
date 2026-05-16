// Canvas `text` node. A simple body run. Long content wraps; renderers MAY
// truncate but v1 does not.

import { StyleSheet, Text } from 'react-native';

import type { TextNode } from '@openclaw/protocol';

import { colors, fontSize } from '../../theme';

export function TextNodeView({ node }: { node: TextNode }): React.ReactElement {
  return (
    <Text style={styles.text} testID={`canvas-text-${node.id}`}>
      {node.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.text,
    fontSize: fontSize.md,
  },
});
