// Stack — flex container that renders its children in `direction` order.
//
// The actual recursive rendering of child nodes is delegated to the
// caller via the `renderChild` prop so we don't introduce a circular
// import between `Stack` and `CanvasRenderer`. `CanvasRenderer` passes
// itself as the child renderer.

import type { CanvasNode, StackNode } from '@openclaw/protocol';

interface StackProps {
  node: StackNode;
  renderChild: (child: CanvasNode) => JSX.Element;
}

export function Stack({ node, renderChild }: StackProps): JSX.Element {
  const direction = node.direction ?? 'vertical';
  return (
    <div className={`oc-canvas-stack oc-canvas-stack--${direction}`} data-direction={direction}>
      {node.children.map((child) => renderChild(child))}
    </div>
  );
}
