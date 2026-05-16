// List — renders a `ListNode` as either a `<ul>` (default) or `<ol>`.
//
// `items` is currently a `string[]` per the v1 schema. If we widen the
// schema to allow nested nodes inside list items, this is the only
// component that needs to grow.

import type { ListNode } from '@openclaw/protocol';

interface ListProps {
  node: ListNode;
}

export function List({ node }: ListProps): JSX.Element {
  const ordered = node.ordered ?? false;
  const items = node.items.map((item, idx) => (
    // Use `idx` as the key — list items are positional strings, not
    // identity-bearing entities. If we widen `items` to nodes, we'll
    // key on `item.id` instead.
    <li key={idx} className="oc-canvas-list-item">
      {item}
    </li>
  ));
  return ordered ? (
    <ol className="oc-canvas-list oc-canvas-list--ordered">{items}</ol>
  ) : (
    <ul className="oc-canvas-list oc-canvas-list--unordered">{items}</ul>
  );
}
