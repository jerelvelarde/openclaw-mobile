// `useCanvas(surfaceId)` — owns the gateway round-trip for one Canvas
// surface. Calls `gateway.getCanvas(surfaceId)` once on mount, subscribes to
// `gateway.onCanvasUpdate(surfaceId, …)`, applies each patch with
// `applyPatch` from `@openclaw/protocol`, and exposes `dispatchEvent` so node
// components can POST events back through the gateway.
//
// The gateway can be passed in (`opts.gateway`) for tests; if omitted it's
// pulled from `usePairing()`. That mirrors the rest of the mobile app: a
// hook can stand alone in tests without a `<PairingProvider>` wrapper.

import { useEffect, useRef, useState } from 'react';

import type { CanvasEvent, CanvasPatch, CanvasSurface, GatewayClient } from '@openclaw/protocol';
import { applyPatch } from '@openclaw/protocol';

import { useOptionalPairing } from '../pairing/PairingProvider';

export interface UseCanvasOptions {
  /** Override the gateway used for the round-trip. Tests pass a fake here. */
  gateway?: GatewayClient;
}

export interface UseCanvasResult {
  /** The most-recent surface snapshot, or `null` until the first fetch resolves. */
  surface: CanvasSurface | null;
  /** Most recent error from `getCanvas` or `applyPatch`. */
  error: Error | null;
  /** Fire a `CanvasEvent` back through the gateway. */
  dispatchEvent: (event: CanvasEvent) => void;
}

/**
 * Drive one Canvas surface against the gateway. Returns the live surface
 * snapshot, the latest error, and an event dispatcher.
 */
export function useCanvas(surfaceId: string, opts: UseCanvasOptions = {}): UseCanvasResult {
  // Resolve gateway either from opts (tests) or from the pairing context
  // (production). The pairing hook is `useOptionalPairing` so we don't
  // throw when the hook is mounted outside a `<PairingProvider>` — that
  // path is fine when the caller passed `opts.gateway` and just isn't
  // wrapped in the provider during testing.
  const pairing = useOptionalPairing();
  const resolved = opts.gateway ?? pairing?.gateway;
  if (!resolved) {
    throw new Error('useCanvas requires either opts.gateway or a <PairingProvider> ancestor');
  }
  const gateway: GatewayClient = resolved;

  const [surface, setSurface] = useState<CanvasSurface | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Track the surface in a ref so the patch handler doesn't capture a stale
  // closure. Subscribers register once on mount; without the ref each patch
  // would see the empty initial surface.
  const surfaceRef = useRef<CanvasSurface | null>(null);
  surfaceRef.current = surface;
  // Keep the last patch `ts` so we can drop out-of-order replays.
  const lastTsRef = useRef<number>(-1);

  useEffect(() => {
    let cancelled = false;

    void gateway
      .getCanvas(surfaceId)
      .then((s) => {
        if (cancelled) return;
        setSurface(s);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    const unsub = gateway.onCanvasUpdate(surfaceId, (patch: CanvasPatch) => {
      if (cancelled) return;
      if (patch.surfaceId !== surfaceId) return;
      if (patch.ts < lastTsRef.current) return;
      lastTsRef.current = patch.ts;
      const current = surfaceRef.current;
      if (!current) {
        // Patches that arrive before the initial fetch resolves are dropped;
        // the snapshot will catch up. This is a rare race in practice
        // because `getCanvas` resolves before the agent has time to patch.
        return;
      }
      try {
        const next = applyPatch(current, patch);
        surfaceRef.current = next;
        setSurface(next);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return () => {
      cancelled = true;
      try {
        unsub();
      } catch {
        /* ignore */
      }
    };
    // The gateway identity is stable across renders (a ref inside
    // `PairingProvider`), so we only re-run on surface id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId]);

  const dispatchEvent = (event: CanvasEvent): void => {
    // Fire-and-forget per `GatewayClient`'s contract. Transport errors surface
    // via the connection-level `error` event the gateway already publishes;
    // we still log here so a bad node-component handler doesn't fail silent.
    void gateway.postCanvasEvent(event).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[openclaw/canvas] postCanvasEvent failed:', err);
    });
  };

  return { surface, error, dispatchEvent };
}
