// Canvas `stack` node — the only container in v1. Renders children in a
// vertical or horizontal `View`. The recursive render is delegated to a
// caller-provided `renderChild` prop so this file doesn't need to know about
// the other node types; the renderer barrel wires it up. That makes the
// component trivially unit-testable in isolation.

import { Fragment, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import type { CanvasNode, StackNode } from '@openclaw/protocol';

import { spacing } from '../../theme';

export interface StackNodeViewProps {
  node: StackNode;
  /**
   * Render a single child. The renderer barrel passes its recursive
   * dispatcher here; keeping it as a prop lets the component live without a
   * direct dependency on the node-type union.
   */
  renderChild: (node: CanvasNode) => ReactNode;
}

export function StackNodeView({ node, renderChild }: StackNodeViewProps): React.ReactElement {
  const horizontal = node.direction === 'horizontal';
  return (
    <View
      style={[styles.stack, horizontal ? styles.horizontal : styles.vertical]}
      testID={`canvas-stack-${node.id}`}
    >
      {node.children.map((child) => (
        <Fragment key={child.id}>{renderChild(child)}</Fragment>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: spacing.sm,
  },
  vertical: {
    flexDirection: 'column',
  },
  horizontal: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
});
