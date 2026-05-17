// `<CanvasRenderer>` — recursive switch on `CanvasNode['type']`. Mounts the
// `CanvasProvider` so descendant node components can dispatch events without
// prop-drilling, then walks the surface tree.
//
// Two render modes:
//
//   - `surfaceId` prop only → the renderer drives the gateway round-trip
//     itself via the `useCanvas` hook (initial fetch + patch subscription +
//     event dispatch). This is what most callers want.
//   - `surface` + `onEvent` props → the renderer is fully controlled; the
//     caller (e.g. a test, or a screen that's wrapping multiple surfaces)
//     owns the state and event sink. `useCanvas` is not invoked. This makes
//     individual node components trivially testable.

import { type ReactElement, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CanvasEvent, CanvasNode, CanvasSurface, GatewayClient } from '@openclaw/protocol';

import { useCanvas } from './useCanvas';
import { CanvasProvider, type CanvasContextValue } from './CanvasContext';
import { ButtonNodeView } from './nodes/Button';
import { HeadingNodeView } from './nodes/Heading';
import { ListNodeView } from './nodes/List';
import { SelectNodeView } from './nodes/Select';
import { StackNodeView } from './nodes/Stack';
import { TextNodeView } from './nodes/Text';
import { TextInputNodeView } from './nodes/TextInput';
import { colors, fontSize, spacing } from '../theme';

/** Recursive node-type switch. Pure — does not consume any context itself. */
export function renderCanvasNode(node: CanvasNode): ReactNode {
  switch (node.type) {
    case 'heading':
      return <HeadingNodeView node={node} />;
    case 'text':
      return <TextNodeView node={node} />;
    case 'button':
      return <ButtonNodeView node={node} />;
    case 'textInput':
      return <TextInputNodeView node={node} />;
    case 'select':
      return <SelectNodeView node={node} />;
    case 'list':
      return <ListNodeView node={node} />;
    case 'stack':
      return <StackNodeView node={node} renderChild={renderCanvasNode} />;
  }
}

/** Common props for both render modes. */
interface BaseProps {
  /** Optional placeholder shown while the initial fetch is in flight. */
  loadingFallback?: ReactNode;
  /** Optional error fallback. Renderer falls back to a default if omitted. */
  errorFallback?: (err: Error) => ReactNode;
}

/** Hook-driven mode: the renderer owns the surface + dispatch wiring. */
export interface CanvasRendererSurfaceIdProps extends BaseProps {
  surfaceId: string;
  surface?: undefined;
  onEvent?: undefined;
  /**
   * Optional gateway override. Tests pass a fake here. Production code
   * leaves this out — `useCanvas` reads from `<PairingProvider>`.
   */
  gateway?: GatewayClient;
}

/** Controlled mode: caller owns the surface + dispatch wiring. */
export interface CanvasRendererControlledProps extends BaseProps {
  surface: CanvasSurface;
  onEvent: (event: CanvasEvent) => void;
  surfaceId?: undefined;
}

export type CanvasRendererProps = CanvasRendererSurfaceIdProps | CanvasRendererControlledProps;

/** Walk a surface tree and render it inside a `<CanvasProvider>`. */
function RenderTree({
  surface,
  contextValue,
}: {
  surface: CanvasSurface;
  contextValue: CanvasContextValue;
}): ReactElement {
  return (
    <CanvasProvider value={contextValue}>
      <View style={styles.root} testID={`canvas-surface-${surface.id}`}>
        {renderCanvasNode(surface.root)}
      </View>
    </CanvasProvider>
  );
}

export function CanvasRenderer(props: CanvasRendererProps): ReactElement {
  if (props.surface !== undefined) {
    // Controlled mode.
    const ctx: CanvasContextValue = {
      surfaceId: props.surface.id,
      dispatchEvent: (nodeId, type, payload) => {
        props.onEvent({ surfaceId: props.surface.id, nodeId, type, payload });
      },
    };
    return <RenderTree surface={props.surface} contextValue={ctx} />;
  }
  // Hook-driven mode.
  return <CanvasRendererHookMode {...props} />;
}

function CanvasRendererHookMode({
  surfaceId,
  loadingFallback,
  errorFallback,
  gateway,
}: CanvasRendererSurfaceIdProps): ReactElement {
  const { surface, error, dispatchEvent } = useCanvas(surfaceId, gateway ? { gateway } : {});
  if (error) {
    if (errorFallback) return <>{errorFallback(error)}</>;
    return (
      <View style={styles.error} testID={`canvas-error-${surfaceId}`}>
        <Text style={styles.errorText}>Canvas failed to load: {error.message}</Text>
      </View>
    );
  }
  if (!surface) {
    if (loadingFallback) return <>{loadingFallback}</>;
    return (
      <View style={styles.loading} testID={`canvas-loading-${surfaceId}`}>
        <Text style={styles.loadingText}>Loading canvas…</Text>
      </View>
    );
  }
  const ctx: CanvasContextValue = {
    surfaceId: surface.id,
    dispatchEvent: (nodeId, type, payload) => {
      dispatchEvent({ surfaceId: surface.id, nodeId, type, payload });
    },
  };
  return <RenderTree surface={surface} contextValue={ctx} />;
}

const styles = StyleSheet.create({
  root: {
    padding: spacing.md,
    gap: spacing.sm,
  },
  loading: {
    padding: spacing.md,
  },
  loadingText: {
    color: colors.muted,
    fontSize: fontSize.sm,
  },
  error: {
    padding: spacing.md,
  },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.sm,
  },
});
