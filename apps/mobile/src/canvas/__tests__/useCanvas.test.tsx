// `useCanvas` integration tests. Mounts the hook (via `<CanvasRenderer
// surfaceId>` in its hook-driven mode) with a fake gateway and asserts:
//
//   - The initial `getCanvas` call resolves and the surface renders.
//   - Patches dispatched via `onCanvasUpdate` apply (re-renders).
//   - Calling the dispatcher posts a `CanvasEvent` through the gateway.
//   - Stale patches (ts < lastApplied) are dropped.
//   - `getCanvas` failures surface the error fallback.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type {
  CanvasEvent,
  CanvasPatch,
  CanvasSurface,
  GatewayClient,
  Unsubscribe,
} from '@openclaw/protocol';

import { CanvasRenderer } from '../CanvasRenderer';

function makeSurface(): CanvasSurface {
  return {
    id: 'surface_1',
    version: 1,
    root: {
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'heading', id: 'h1', text: 'Initial', level: 1 }],
    },
  };
}

interface FakeGateway extends GatewayClient {
  _emitPatch: (patch: CanvasPatch) => void;
  _posted: CanvasEvent[];
  _setSurface: (s: CanvasSurface) => void;
  _failNext: (err: Error) => void;
}

/** Minimal stand-in for `GatewayClient` covering the methods we exercise. */
function makeFakeGateway(initial: CanvasSurface): FakeGateway {
  const handlers = new Set<(p: CanvasPatch) => void>();
  const posted: CanvasEvent[] = [];
  let current = initial;
  let nextError: Error | null = null;

  const gw: Partial<GatewayClient> = {
    async getCanvas(_id: string): Promise<CanvasSurface> {
      if (nextError) {
        const err = nextError;
        nextError = null;
        throw err;
      }
      return current;
    },
    onCanvasUpdate(_surfaceId: string, handler: (p: CanvasPatch) => void): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    postCanvasEvent: jest.fn(async (e: CanvasEvent) => {
      posted.push(e);
    }),
  };
  return Object.assign(gw as GatewayClient, {
    _emitPatch(patch: CanvasPatch) {
      for (const h of handlers) h(patch);
    },
    _posted: posted,
    _setSurface(s: CanvasSurface) {
      current = s;
    },
    _failNext(err: Error) {
      nextError = err;
    },
  });
}

describe('useCanvas (via <CanvasRenderer surfaceId>)', () => {
  it('fetches the initial surface and renders it', async () => {
    const gw = makeFakeGateway(makeSurface());
    const { findByTestId } = render(<CanvasRenderer surfaceId="surface_1" gateway={gw} />);
    expect(await findByTestId('canvas-heading-h1')).toBeTruthy();
  });

  it('applies a CanvasPatch and re-renders the surface', async () => {
    const gw = makeFakeGateway(makeSurface());
    const { findByTestId, queryByTestId } = render(
      <CanvasRenderer surfaceId="surface_1" gateway={gw} />,
    );
    expect(await findByTestId('canvas-heading-h1')).toBeTruthy();

    // Emit a patch that replaces the heading's text and adds a sibling.
    await act(async () => {
      gw._emitPatch({
        surfaceId: 'surface_1',
        ts: 1,
        ops: [
          { op: 'setText', id: 'h1', text: 'Patched' },
          {
            op: 'add',
            parentId: 'root',
            node: { type: 'text', id: 'body', text: 'After patch' },
          },
        ],
      });
      await Promise.resolve();
    });

    const heading = await findByTestId('canvas-heading-h1');
    expect(heading.props.children).toBe('Patched');
    expect(queryByTestId('canvas-text-body')).toBeTruthy();
  });

  it('dispatches a click event through the gateway when a button is pressed', async () => {
    const surface: CanvasSurface = {
      id: 'surface_1',
      version: 1,
      root: {
        type: 'stack',
        id: 'root',
        direction: 'vertical',
        children: [{ type: 'button', id: 'save', label: 'Save', action: 'save_form' }],
      },
    };
    const gw = makeFakeGateway(surface);
    const { findByTestId } = render(<CanvasRenderer surfaceId="surface_1" gateway={gw} />);
    const btn = await findByTestId('canvas-button-save');
    fireEvent.press(btn);
    await waitFor(() => expect(gw._posted).toHaveLength(1));
    expect(gw._posted[0]).toEqual({
      surfaceId: 'surface_1',
      nodeId: 'save',
      type: 'click',
      payload: { action: 'save_form' },
    });
  });

  it('ignores stale patches with ts < lastApplied', async () => {
    const gw = makeFakeGateway(makeSurface());
    const { findByTestId } = render(<CanvasRenderer surfaceId="surface_1" gateway={gw} />);
    await findByTestId('canvas-heading-h1');

    await act(async () => {
      gw._emitPatch({
        surfaceId: 'surface_1',
        ts: 10,
        ops: [{ op: 'setText', id: 'h1', text: 'Latest' }],
      });
      gw._emitPatch({
        surfaceId: 'surface_1',
        ts: 5, // stale — dropped
        ops: [{ op: 'setText', id: 'h1', text: 'Stale' }],
      });
      await Promise.resolve();
    });

    const heading = await findByTestId('canvas-heading-h1');
    expect(heading.props.children).toBe('Latest');
  });

  it('shows the error fallback when getCanvas rejects', async () => {
    const gw = makeFakeGateway(makeSurface());
    gw._failNext(new Error('Surface not found'));
    const { findByTestId } = render(<CanvasRenderer surfaceId="surface_1" gateway={gw} />);
    await waitFor(() => findByTestId('canvas-error-surface_1'));
  });
});
