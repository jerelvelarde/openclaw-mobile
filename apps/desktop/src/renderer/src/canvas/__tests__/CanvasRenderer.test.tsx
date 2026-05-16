// Integration tests for `<CanvasRenderer/>` + `useCanvas`.
//
// We drive a fake `CanvasGateway` (the canvas-shaped slice of
// `useGateway`) so the tests focus on rendering + patching, not WS
// plumbing. The gateway-side WS handling has its own coverage in
// `useGateway.test.tsx`.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasEvent, CanvasPatch, CanvasSurface } from '@openclaw/protocol';
import { CanvasGatewayProvider, type CanvasGateway } from '../CanvasGatewayContext';
import { CanvasRenderer } from '../CanvasRenderer';

interface FakeGateway extends CanvasGateway {
  pushSurface(surface: CanvasSurface): void;
  pushPatch(patch: CanvasPatch): void;
  events: CanvasEvent[];
}

function makeFakeGateway(initial?: CanvasSurface): FakeGateway {
  const cache = new Map<string, CanvasSurface>();
  const surfaceListeners = new Map<string, Set<(s: CanvasSurface) => void>>();
  const patchListeners = new Map<string, Set<(p: CanvasPatch) => void>>();
  const events: CanvasEvent[] = [];
  if (initial) cache.set(initial.id, initial);

  const gw: FakeGateway = {
    peekCanvas(surfaceId) {
      return cache.get(surfaceId) ?? null;
    },
    async getCanvas(surfaceId) {
      const hit = cache.get(surfaceId);
      if (hit) return hit;
      throw new Error(`no surface ${surfaceId}`);
    },
    onCanvasSurface(surfaceId, handler) {
      let set = surfaceListeners.get(surfaceId);
      if (!set) {
        set = new Set();
        surfaceListeners.set(surfaceId, set);
      }
      set.add(handler);
      return (): void => {
        set!.delete(handler);
      };
    },
    onCanvasUpdate(surfaceId, handler) {
      let set = patchListeners.get(surfaceId);
      if (!set) {
        set = new Set();
        patchListeners.set(surfaceId, set);
      }
      set.add(handler);
      return (): void => {
        set!.delete(handler);
      };
    },
    dispatchCanvasEvent(event) {
      events.push(event);
    },
    pushSurface(surface) {
      cache.set(surface.id, surface);
      const set = surfaceListeners.get(surface.id);
      if (set) for (const fn of set) fn(surface);
    },
    pushPatch(patch) {
      const set = patchListeners.get(patch.surfaceId);
      if (set) for (const fn of set) fn(patch);
    },
    events,
  };
  return gw;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('<CanvasRenderer />', () => {
  const baseSurface: CanvasSurface = {
    id: 'surface_demo',
    version: 1,
    root: {
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [
        { type: 'heading', id: 'h', text: 'Title', level: 2 },
        { type: 'text', id: 't', text: 'Body' },
        { type: 'button', id: 'btn', label: 'Press', action: 'press' },
      ],
    },
  };

  it('renders an expected DOM tree from a cached surface', () => {
    const gw = makeFakeGateway(baseSurface);
    const { container } = render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="surface_demo" />
      </CanvasGatewayProvider>,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Title');
    expect(container.querySelector('p')?.textContent).toBe('Body');
    expect(screen.getByRole('button', { name: 'Press' })).toBeDefined();
  });

  it('shows a loading state until the surface arrives', async () => {
    const gw = makeFakeGateway(); // empty cache → getCanvas rejects
    render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="surface_pending" />
      </CanvasGatewayProvider>,
    );
    expect(screen.getByText(/Loading canvas/)).toBeDefined();
    // A push delivers the surface; rerender shows the body.
    await act(async () => {
      gw.pushSurface({
        id: 'surface_pending',
        version: 1,
        root: { type: 'text', id: 'only', text: 'Hi from agent' },
      });
      await flushMicrotasks();
    });
    expect(screen.getByText('Hi from agent')).toBeDefined();
  });

  it('applies an incoming patch and updates the DOM', async () => {
    const gw = makeFakeGateway(baseSurface);
    const { container } = render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="surface_demo" />
      </CanvasGatewayProvider>,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Title');

    await act(async () => {
      gw.pushPatch({
        surfaceId: 'surface_demo',
        ts: Date.now(),
        ops: [{ op: 'setText', id: 'h', text: 'Updated' }],
      });
      await flushMicrotasks();
    });
    expect(container.querySelector('h2')?.textContent).toBe('Updated');
  });

  it('handles add ops on stack containers', async () => {
    const gw = makeFakeGateway(baseSurface);
    render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="surface_demo" />
      </CanvasGatewayProvider>,
    );

    await act(async () => {
      gw.pushPatch({
        surfaceId: 'surface_demo',
        ts: Date.now(),
        ops: [
          {
            op: 'add',
            parentId: 'root',
            node: { type: 'text', id: 'added', text: 'New row' },
          },
        ],
      });
      await flushMicrotasks();
    });
    expect(screen.getByText('New row')).toBeDefined();
  });

  it('dispatches button click events through the gateway with surfaceId injected', () => {
    const gw = makeFakeGateway(baseSurface);
    render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="surface_demo" />
      </CanvasGatewayProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Press' }));
    expect(gw.events).toHaveLength(1);
    expect(gw.events[0]).toEqual({
      surfaceId: 'surface_demo',
      nodeId: 'btn',
      type: 'click',
      payload: { action: 'press' },
    });
  });

  it('renders an error block when getCanvas rejects', async () => {
    const gw = makeFakeGateway();
    // Override getCanvas to reject deterministically.
    gw.getCanvas = vi.fn().mockRejectedValue(new Error('no such surface'));
    render(
      <CanvasGatewayProvider value={gw}>
        <CanvasRenderer surfaceId="missing" />
      </CanvasGatewayProvider>,
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(screen.getByText(/Failed to load canvas/)).toBeDefined();
  });

  it('throws a clear error when used without a provider', () => {
    // Suppress the React error-boundary console noise from the
    // intentional error path.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<CanvasRenderer surfaceId="x" />)).toThrowError(/CanvasGatewayProvider/);
    spy.mockRestore();
  });
});
