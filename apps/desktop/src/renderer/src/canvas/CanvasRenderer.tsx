// CanvasRenderer — recursive renderer for a `CanvasSurface`.
//
// Mirrors the mobile renderer (P06A) but emits HTML primitives instead
// of React Native ones. The shape of the API is identical so an agent
// only needs to learn one mental model:
//
//  - Mount with `<CanvasRenderer surfaceId={…} />`.
//  - The hook (`useCanvas`) fetches the initial surface, subscribes to
//    `canvas.patch` updates, and feeds the latest tree back here.
//  - Each node type has its own component under `./nodes/*`. The
//    `Stack` component delegates child rendering back to this file via
//    `renderNode` to break the circular import.
//
// We render a `<section aria-busy>` while the surface is loading and a
// small error block if the gateway returns a failure.

import type { CanvasNode } from '@openclaw/protocol';
import { useCanvas } from './useCanvas';
import { Button } from './nodes/Button';
import { Heading } from './nodes/Heading';
import { List } from './nodes/List';
import { Select } from './nodes/Select';
import { Stack } from './nodes/Stack';
import { Text } from './nodes/Text';
import { TextInput } from './nodes/TextInput';

export interface CanvasRendererProps {
  /** Id of the surface to mount. */
  surfaceId: string;
}

export function CanvasRenderer({ surfaceId }: CanvasRendererProps): JSX.Element {
  const { surface, error, dispatchEvent } = useCanvas(surfaceId);

  if (error) {
    return (
      <section
        className="oc-canvas oc-canvas--error"
        aria-label={`canvas surface ${surfaceId}`}
        role="status"
      >
        Failed to load canvas: {error}
      </section>
    );
  }

  if (!surface) {
    return (
      <section
        className="oc-canvas oc-canvas--loading"
        aria-label={`canvas surface ${surfaceId}`}
        aria-busy="true"
      >
        Loading canvas…
      </section>
    );
  }

  // `dispatchEvent` provided by the hook already injects `surfaceId`, so
  // node components only see the `{ nodeId, type, payload }` shape.
  const renderNode = (node: CanvasNode): JSX.Element => {
    switch (node.type) {
      case 'heading':
        return <Heading key={node.id} node={node} />;
      case 'text':
        return <Text key={node.id} node={node} />;
      case 'button':
        return <Button key={node.id} node={node} onEvent={dispatchEvent} />;
      case 'textInput':
        return <TextInput key={node.id} node={node} onEvent={dispatchEvent} />;
      case 'select':
        return <Select key={node.id} node={node} onEvent={dispatchEvent} />;
      case 'list':
        return <List key={node.id} node={node} />;
      case 'stack':
        return <Stack key={node.id} node={node} renderChild={renderNode} />;
      default: {
        // Exhaustive check: TS narrows `node` to `never` here. If a new
        // node type lands without a case, the build fails loudly.
        const _exhaustive: never = node;
        return <span data-unhandled={String(_exhaustive)} />;
      }
    }
  };

  return (
    <section
      className="oc-canvas"
      aria-label={`canvas surface ${surface.id}`}
      data-surface-id={surface.id}
    >
      {renderNode(surface.root)}
    </section>
  );
}
