// useCanvas — renderer-side hook that owns a single Canvas surface's
// lifecycle in the React tree.
//
// On mount it asks the gateway for the current snapshot of `surfaceId`
// and subscribes to incremental patch updates. Each patch is applied
// via `applyPatch` from `@openclaw/protocol`, which deep-clones the
// surface so React's identity comparison sees a new root and re-renders.
//
// Returns:
//   - `surface`: the latest `CanvasSurface`, or `null` while loading.
//   - `error`: a human-readable message if the initial fetch failed.
//   - `dispatchEvent`: forwards a `CanvasEvent` (sans `surfaceId`) back
//      to the gateway. Node components inject `nodeId` + `type` +
//      `payload`; this hook injects `surfaceId`.
//
// The gateway plumbing lives in `useGateway` (`canvas.get` request,
// `canvas.surface` / `canvas.patch` push handling, `canvas.event` send).
// We pull those bindings out of a small React context populated by
// `<CanvasGatewayProvider>` so node components don't have to reach into
// `useGateway` themselves.

import { useEffect, useState } from 'react';
import { applyPatch, type CanvasEvent, type CanvasSurface } from '@openclaw/protocol';
import { useCanvasGateway } from './CanvasGatewayContext';

/** Public return shape, kept narrow so consumers don't depend on the gateway. */
export interface UseCanvasHandle {
  /** Current surface snapshot. `null` until the first response arrives. */
  surface: CanvasSurface | null;
  /** Last failure message; cleared on the next successful snapshot. */
  error: string | null;
  /** Send a `CanvasEvent` to the gateway. `surfaceId` is injected here. */
  dispatchEvent: (event: Omit<CanvasEvent, 'surfaceId'>) => void;
}

export function useCanvas(surfaceId: string): UseCanvasHandle {
  const gateway = useCanvasGateway();
  const [surface, setSurface] = useState<CanvasSurface | null>(() => gateway.peekCanvas(surfaceId));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Track whether the surface has been delivered (via cache, fetch,
    // or push). The initial-fetch catch handler only sets an error if
    // no surface has landed yet — otherwise a push that arrives during
    // the same tick gets clobbered by a stale rejection.
    let delivered = false;

    // Re-seed from the gateway's cache when surfaceId flips. If the
    // gateway already saw a `canvas.surface` push for this id we can
    // skip the round-trip and render immediately.
    const cached = gateway.peekCanvas(surfaceId);
    if (cached) {
      delivered = true;
      setSurface(cached);
      setError(null);
    } else {
      setSurface(null);
      setError(null);
      gateway
        .getCanvas(surfaceId)
        .then((s) => {
          if (cancelled) return;
          delivered = true;
          setSurface(s);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled || delivered) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    }

    const offSurface = gateway.onCanvasSurface(surfaceId, (next) => {
      if (cancelled) return;
      delivered = true;
      setSurface(next);
      setError(null);
    });

    const offPatch = gateway.onCanvasUpdate(surfaceId, (patch) => {
      if (cancelled) return;
      setSurface((prev) => {
        if (!prev) return prev;
        try {
          return applyPatch(prev, patch);
        } catch (err) {
          // Surface the patch error to the UI but keep the old tree
          // mounted — losing state on a bad patch would be worse than
          // showing stale content.
          setError(err instanceof Error ? err.message : String(err));
          return prev;
        }
      });
    });

    return (): void => {
      cancelled = true;
      offSurface();
      offPatch();
    };
  }, [gateway, surfaceId]);

  const dispatchEvent = (event: Omit<CanvasEvent, 'surfaceId'>): void => {
    gateway.dispatchCanvasEvent({ ...event, surfaceId });
  };

  return { surface, error, dispatchEvent };
}
