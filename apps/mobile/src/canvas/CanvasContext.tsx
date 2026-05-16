// React context that lets Canvas node components dispatch `CanvasEvent`s
// without prop-drilling. `useCanvas` owns the dispatcher and provides it via
// `<CanvasProvider>`; each node component calls `useCanvasContext()` from
// inside the renderer subtree to fire `click` / `change` / `submit`.
//
// Why a context (not a callback prop): the tree is dynamic — patches mint new
// nodes that need the same dispatcher. Threading the callback through every
// `Stack` would make node components less reusable and more verbose.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

import type { CanvasEvent, CanvasEventType } from '@openclaw/protocol';

/** Shape of the dispatcher exposed to node components. */
export interface CanvasContextValue {
  /** The surface id is needed in every dispatched event. */
  surfaceId: string;
  /**
   * Fire a `CanvasEvent` back through the gateway. Node components call this
   * from `onPress` / `onBlur` / `onValueChange` handlers. The dispatcher is
   * fire-and-forget; transport errors surface via the gateway's `error` event.
   */
  dispatchEvent: (nodeId: string, type: CanvasEventType, payload: CanvasEvent['payload']) => void;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

export function CanvasProvider({
  value,
  children,
}: {
  value: CanvasContextValue;
  children: ReactNode;
}): ReactElement {
  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

/**
 * Read the canvas dispatcher from inside the renderer subtree. Throws if
 * used outside `<CanvasProvider>` so a misconfigured renderer fails loudly
 * during development.
 */
export function useCanvasContext(): CanvasContextValue {
  const ctx = useContext(CanvasContext);
  if (!ctx) {
    throw new Error('useCanvasContext() must be used inside <CanvasProvider>');
  }
  return ctx;
}
