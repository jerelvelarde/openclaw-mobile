// React context that hands the canvas-aware slice of the gateway to
// any `<CanvasRenderer/>` mounted in the tree.
//
// The gateway hook (`useGateway`) owns the WS connection and produces a
// `CanvasGateway` handle. `Chat.tsx` wraps the renderer in
// `<CanvasGatewayProvider value={gateway.canvas}>` so node components
// don't need to thread the gateway through props.
//
// Why a dedicated context instead of `useGateway()` directly: the node
// components live under the renderer package and shouldn't have a
// dependency on the chat-shaped gateway handle. The context narrows
// the surface to exactly the four canvas methods.

import { createContext, useContext, type ReactNode } from 'react';
import type { CanvasEvent, CanvasPatch, CanvasSurface } from '@openclaw/protocol';

/** The narrow slice of the gateway the canvas renderer needs. */
export interface CanvasGateway {
  /** Synchronously return a cached surface, or `null` if absent. */
  peekCanvas(surfaceId: string): CanvasSurface | null;
  /** Request a fresh surface snapshot. Rejects on error/timeout. */
  getCanvas(surfaceId: string): Promise<CanvasSurface>;
  /** Subscribe to whole-surface pushes (e.g. agent resends the tree). */
  onCanvasSurface(surfaceId: string, handler: (surface: CanvasSurface) => void): () => void;
  /** Subscribe to incremental patches for a surface. */
  onCanvasUpdate(surfaceId: string, handler: (patch: CanvasPatch) => void): () => void;
  /** Send a `CanvasEvent` upstream to the agent. */
  dispatchCanvasEvent(event: CanvasEvent): void;
}

const CanvasGatewayContext = createContext<CanvasGateway | null>(null);

export interface CanvasGatewayProviderProps {
  value: CanvasGateway;
  children: ReactNode;
}

export function CanvasGatewayProvider(props: CanvasGatewayProviderProps): JSX.Element {
  return (
    <CanvasGatewayContext.Provider value={props.value}>
      {props.children}
    </CanvasGatewayContext.Provider>
  );
}

/**
 * Read the canvas gateway from context. Throws when called outside a
 * provider — the renderer would silently render a permanent "loading…"
 * state otherwise, and that's worse than a clear error.
 */
export function useCanvasGateway(): CanvasGateway {
  const ctx = useContext(CanvasGatewayContext);
  if (!ctx) {
    throw new Error(
      'useCanvasGateway: no <CanvasGatewayProvider> in the tree — wrap your subtree first.',
    );
  }
  return ctx;
}
