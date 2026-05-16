// Button — renders a `ButtonNode` as a native `<button>`.
//
// Emits a `click` `CanvasEvent` on press with `{ action }` payload
// (omitting `action` if the node didn't carry one — that matches the
// protocol contract: it's an optional echo of `ButtonNode.action`).

import type { ButtonNode, CanvasEvent } from '@openclaw/protocol';

interface ButtonProps {
  node: ButtonNode;
  /** Dispatch a Canvas event back through the gateway. */
  onEvent: (event: Omit<CanvasEvent, 'surfaceId'>) => void;
}

export function Button({ node, onEvent }: ButtonProps): JSX.Element {
  const variant = node.variant ?? 'secondary';
  return (
    <button
      type="button"
      className={`oc-canvas-button oc-canvas-button--${variant}`}
      data-action={node.action}
      onClick={(): void => {
        const payload: Record<string, unknown> = {};
        if (node.action !== undefined) payload.action = node.action;
        onEvent({ nodeId: node.id, type: 'click', payload });
      }}
    >
      {node.label}
    </button>
  );
}
