// Select — renders a `SelectNode` as a native `<select>` over its options.
//
// Emits a `change` `CanvasEvent` synchronously on selection.

import type { CanvasEvent, SelectNode } from '@openclaw/protocol';

interface SelectProps {
  node: SelectNode;
  onEvent: (event: Omit<CanvasEvent, 'surfaceId'>) => void;
}

export function Select({ node, onEvent }: SelectProps): JSX.Element {
  return (
    <select
      className="oc-canvas-select"
      name={node.name}
      value={node.value ?? ''}
      onChange={(e): void => {
        const next = e.target.value;
        onEvent({
          nodeId: node.id,
          type: 'change',
          payload: { name: node.name, value: next },
        });
      }}
    >
      {node.options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
