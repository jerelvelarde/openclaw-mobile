// Tests for the v1 Canvas schema (P06.0).
//
// Coverage:
//  - Round-trip: every node type serializes and re-parses to a deep-equal
//    surface.
//  - applyPatch: each of the four ops (add, remove, replaceProps, setText)
//    plus error cases (unknown nodes, root removal, non-stack parents,
//    setText on a non-text node, surface-id mismatch).
//  - Schema rejection: invalid surfaces, patches, and events produce Zod
//    errors with informative `issues`.

import { describe, expect, it } from 'vitest';

import {
  applyPatch,
  CANVAS_SCHEMA_VERSION,
  CanvasEventSchema,
  CanvasNodeSchema,
  CanvasPatchSchema,
  CanvasSurfaceSchema,
  type CanvasNode,
  type CanvasPatch,
  type CanvasSurface,
} from '../index';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function rootStack(children: CanvasNode[]): CanvasNode {
  return {
    type: 'stack',
    id: 'root',
    direction: 'vertical',
    children,
  };
}

function makeSurface(children: CanvasNode[] = []): CanvasSurface {
  return {
    id: 'surface_1',
    version: CANVAS_SCHEMA_VERSION,
    root: rootStack(children),
  };
}

describe('Canvas schemas', () => {
  it('round-trips a surface containing every v1 node type', () => {
    const surface: CanvasSurface = makeSurface([
      { type: 'heading', id: 'h1', text: 'Hello', level: 2 },
      { type: 'text', id: 't1', text: 'A paragraph.' },
      { type: 'button', id: 'b1', label: 'Click me', variant: 'primary', action: 'noop' },
      { type: 'textInput', id: 'ti1', name: 'email', placeholder: 'you@example.com' },
      {
        type: 'select',
        id: 'sel1',
        name: 'color',
        options: [
          { label: 'Red', value: 'r' },
          { label: 'Blue', value: 'b' },
        ],
        value: 'r',
      },
      { type: 'list', id: 'l1', items: ['one', 'two', 'three'], ordered: true },
      {
        type: 'stack',
        id: 'inner',
        direction: 'horizontal',
        children: [{ type: 'text', id: 'inner_t', text: 'nested' }],
      },
    ]);

    const encoded = JSON.stringify(surface);
    const decoded = CanvasSurfaceSchema.parse(JSON.parse(encoded));
    expect(decoded).toEqual(surface);
  });

  it('round-trips a patch with every op kind', () => {
    const patch: CanvasPatch = {
      surfaceId: 'surface_1',
      ts: 42,
      ops: [
        {
          op: 'add',
          parentId: 'root',
          node: { type: 'text', id: 'n1', text: 'new' },
        },
        { op: 'remove', id: 'n1' },
        { op: 'replaceProps', id: 'n2', props: { variant: 'secondary' } },
        { op: 'setText', id: 'n3', text: 'updated' },
      ],
    };
    const encoded = JSON.stringify(patch);
    const decoded = CanvasPatchSchema.parse(JSON.parse(encoded));
    expect(decoded).toEqual(patch);
  });

  it('round-trips each CanvasEvent type', () => {
    const events = [
      { surfaceId: 's1', nodeId: 'b1', type: 'click' as const, payload: { action: 'noop' } },
      {
        surfaceId: 's1',
        nodeId: 'ti1',
        type: 'change' as const,
        payload: { name: 'email', value: 'a@b' },
      },
      {
        surfaceId: 's1',
        nodeId: 'root',
        type: 'submit' as const,
        payload: { values: { email: 'a@b', color: 'r' } },
      },
    ];
    for (const e of events) {
      const decoded = CanvasEventSchema.parse(JSON.parse(JSON.stringify(e)));
      expect(decoded).toEqual(e);
    }
  });
});

describe('Canvas schema rejections', () => {
  it('rejects a surface with the wrong version', () => {
    const result = CanvasSurfaceSchema.safeParse({
      id: 'surface_1',
      version: 99,
      root: { type: 'text', id: 't', text: '' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('version'))).toBe(true);
    }
  });

  it('rejects a node with an unknown type', () => {
    const result = CanvasNodeSchema.safeParse({ type: 'banana', id: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toMatch(/type/);
    }
  });

  it('rejects a button missing its label', () => {
    const result = CanvasNodeSchema.safeParse({ type: 'button', id: 'b1' });
    expect(result.success).toBe(false);
  });

  it('rejects a patch with an unknown op', () => {
    const result = CanvasPatchSchema.safeParse({
      surfaceId: 's1',
      ts: 0,
      ops: [{ op: 'mutate', id: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an event with an unknown type', () => {
    const result = CanvasEventSchema.safeParse({
      surfaceId: 's1',
      nodeId: 'n',
      type: 'hover',
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects a node with an empty id', () => {
    const result = CanvasNodeSchema.safeParse({ type: 'text', id: '', text: '' });
    expect(result.success).toBe(false);
  });
});

describe('applyPatch', () => {
  it('add: appends a child to a stack when no index is given', () => {
    const surface = makeSurface([{ type: 'text', id: 'a', text: 'A' }]);
    const patch: CanvasPatch = {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        {
          op: 'add',
          parentId: 'root',
          node: { type: 'text', id: 'b', text: 'B' },
        },
      ],
    };
    const next = applyPatch(surface, patch);
    expect(next.root.type).toBe('stack');
    if (next.root.type !== 'stack') throw new Error('unreachable');
    expect(next.root.children.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('add: inserts at the given index', () => {
    const surface = makeSurface([
      { type: 'text', id: 'a', text: 'A' },
      { type: 'text', id: 'c', text: 'C' },
    ]);
    const patch: CanvasPatch = {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        {
          op: 'add',
          parentId: 'root',
          index: 1,
          node: { type: 'text', id: 'b', text: 'B' },
        },
      ],
    };
    const next = applyPatch(surface, patch);
    if (next.root.type !== 'stack') throw new Error('unreachable');
    expect(next.root.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('add: rejects an unknown parent', () => {
    const surface = makeSurface();
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [
          {
            op: 'add',
            parentId: 'ghost',
            node: { type: 'text', id: 'x', text: '' },
          },
        ],
      }),
    ).toThrow(/unknown parent/);
  });

  it('add: rejects a non-stack parent', () => {
    const surface = makeSurface([{ type: 'text', id: 'a', text: 'A' }]);
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [
          {
            op: 'add',
            parentId: 'a',
            node: { type: 'text', id: 'b', text: 'B' },
          },
        ],
      }),
    ).toThrow(/non-stack/);
  });

  it('add: rejects a duplicate node id', () => {
    const surface = makeSurface([{ type: 'text', id: 'a', text: 'A' }]);
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [
          {
            op: 'add',
            parentId: 'root',
            node: { type: 'text', id: 'a', text: 'dup' },
          },
        ],
      }),
    ).toThrow(/already exists/);
  });

  it('remove: deletes a node from its parent', () => {
    const surface = makeSurface([
      { type: 'text', id: 'a', text: 'A' },
      { type: 'text', id: 'b', text: 'B' },
    ]);
    const next = applyPatch(surface, {
      surfaceId: surface.id,
      ts: 1,
      ops: [{ op: 'remove', id: 'a' }],
    });
    if (next.root.type !== 'stack') throw new Error('unreachable');
    expect(next.root.children.map((c) => c.id)).toEqual(['b']);
  });

  it('remove: refuses to remove the root', () => {
    const surface = makeSurface();
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [{ op: 'remove', id: 'root' }],
      }),
    ).toThrow(/root/);
  });

  it('remove: errors on an unknown node', () => {
    const surface = makeSurface();
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [{ op: 'remove', id: 'ghost' }],
      }),
    ).toThrow(/unknown node/);
  });

  it('replaceProps: shallow-merges props but skips id/type/children', () => {
    const surface = makeSurface([{ type: 'button', id: 'b1', label: 'Old', variant: 'primary' }]);
    const next = applyPatch(surface, {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        {
          op: 'replaceProps',
          id: 'b1',
          props: { label: 'New', variant: 'destructive', id: 'IGNORED', type: 'text' },
        },
      ],
    });
    if (next.root.type !== 'stack') throw new Error('unreachable');
    const btn = next.root.children[0]!;
    if (btn.type !== 'button') throw new Error('expected button after patch');
    expect(btn.label).toBe('New');
    expect(btn.variant).toBe('destructive');
    expect(btn.id).toBe('b1');
  });

  it('setText: updates the right field per node type', () => {
    const surface = makeSurface([
      { type: 'heading', id: 'h', text: 'hi', level: 1 },
      { type: 'text', id: 't', text: 'old' },
      { type: 'button', id: 'b', label: 'old' },
      { type: 'textInput', id: 'ti', name: 'q', value: 'old' },
    ]);
    const next = applyPatch(surface, {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        { op: 'setText', id: 'h', text: 'hello' },
        { op: 'setText', id: 't', text: 'new' },
        { op: 'setText', id: 'b', text: 'press' },
        { op: 'setText', id: 'ti', text: 'typed' },
      ],
    });
    if (next.root.type !== 'stack') throw new Error('unreachable');
    const [h, t, b, ti] = next.root.children;
    if (h?.type !== 'heading') throw new Error('h type');
    if (t?.type !== 'text') throw new Error('t type');
    if (b?.type !== 'button') throw new Error('b type');
    if (ti?.type !== 'textInput') throw new Error('ti type');
    expect(h.text).toBe('hello');
    expect(t.text).toBe('new');
    expect(b.label).toBe('press');
    expect(ti.value).toBe('typed');
  });

  it('setText: errors on a node with no text field (list)', () => {
    const surface = makeSurface([{ type: 'list', id: 'L', items: ['a'] }]);
    expect(() =>
      applyPatch(surface, {
        surfaceId: surface.id,
        ts: 1,
        ops: [{ op: 'setText', id: 'L', text: 'nope' }],
      }),
    ).toThrow(/no text field/);
  });

  it('errors when patch.surfaceId does not match surface.id', () => {
    const surface = makeSurface();
    expect(() => applyPatch(surface, { surfaceId: 'other', ts: 1, ops: [] })).toThrow(/mismatch/);
  });

  it('is pure — never mutates the input surface', () => {
    const surface = makeSurface([{ type: 'text', id: 'a', text: 'A' }]);
    const snapshot = clone(surface);
    applyPatch(surface, {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        {
          op: 'add',
          parentId: 'root',
          node: { type: 'text', id: 'b', text: 'B' },
        },
        { op: 'setText', id: 'a', text: 'changed' },
      ],
    });
    expect(surface).toEqual(snapshot);
  });

  it('applies ops in order so a node added then removed nets zero', () => {
    const surface = makeSurface();
    const next = applyPatch(surface, {
      surfaceId: surface.id,
      ts: 1,
      ops: [
        {
          op: 'add',
          parentId: 'root',
          node: { type: 'text', id: 'tmp', text: 'tmp' },
        },
        { op: 'remove', id: 'tmp' },
      ],
    });
    if (next.root.type !== 'stack') throw new Error('unreachable');
    expect(next.root.children).toEqual([]);
  });
});
