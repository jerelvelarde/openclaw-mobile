// Canvas v1 schema — Zod schemas + `applyPatch` helper.
//
// `applyPatch(surface, patch)` is a **pure function**: it deep-clones the
// surface before mutating, so callers may keep the input around without
// fear of structural sharing surprises. Patch ops are applied in order;
// any failing op throws, leaving the original `surface` argument untouched.
//
// The schemas here mirror the types in `./types.ts` exactly. Where Zod's
// `z.infer<>` produces a structurally identical type, we still export the
// inferred alias under the same name so callers can pick whichever import
// style they like — both resolve to the same shape.

import { z } from 'zod';

import {
  CANVAS_SCHEMA_VERSION,
  type CanvasEvent,
  type CanvasNode,
  type CanvasPatch,
  type CanvasPatchOp,
  type CanvasSurface,
  type StackNode,
} from './types';

// ── Node schemas ────────────────────────────────────────────────────────────

const NodeIdSchema = z.string().min(1);

const HeadingNodeSchema = z.object({
  type: z.literal('heading'),
  id: NodeIdSchema,
  text: z.string(),
  level: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
    .optional(),
});

const TextNodeSchema = z.object({
  type: z.literal('text'),
  id: NodeIdSchema,
  text: z.string(),
});

const ButtonNodeSchema = z.object({
  type: z.literal('button'),
  id: NodeIdSchema,
  label: z.string().min(1),
  variant: z.enum(['primary', 'secondary', 'destructive']).optional(),
  action: z.string().optional(),
});

const TextInputNodeSchema = z.object({
  type: z.literal('textInput'),
  id: NodeIdSchema,
  name: z.string().min(1),
  value: z.string().optional(),
  placeholder: z.string().optional(),
});

const SelectOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

const SelectNodeSchema = z.object({
  type: z.literal('select'),
  id: NodeIdSchema,
  name: z.string().min(1),
  options: z.array(SelectOptionSchema),
  value: z.string().optional(),
});

const ListNodeSchema = z.object({
  type: z.literal('list'),
  id: NodeIdSchema,
  items: z.array(z.string()),
  ordered: z.boolean().optional(),
});

/**
 * Recursive Stack + node schemas. Zod 4 wants discriminated-union members to
 * be concrete `ZodObject`s (not wrapped in `lazy`), so we tie the recursion
 * inside `StackNodeSchema` via `z.array(z.lazy(...))` instead. The exported
 * `CanvasNodeSchema` is then a normal discriminated union.
 */
const StackNodeSchema: z.ZodType<StackNode> = z.object({
  type: z.literal('stack'),
  id: NodeIdSchema,
  direction: z.enum(['vertical', 'horizontal']).optional(),
  children: z.array(z.lazy((): z.ZodType<CanvasNode> => CanvasNodeSchema)),
});

export const CanvasNodeSchema: z.ZodType<CanvasNode> = z.discriminatedUnion('type', [
  HeadingNodeSchema,
  TextNodeSchema,
  ButtonNodeSchema,
  TextInputNodeSchema,
  SelectNodeSchema,
  ListNodeSchema,
  StackNodeSchema as z.ZodObject<{
    type: z.ZodLiteral<'stack'>;
    id: z.ZodString;
    direction: z.ZodOptional<z.ZodEnum<{ vertical: 'vertical'; horizontal: 'horizontal' }>>;
    children: z.ZodArray<z.ZodType<CanvasNode>>;
  }>,
]);

// ── Surface schema ──────────────────────────────────────────────────────────

export const CanvasSurfaceSchema: z.ZodType<CanvasSurface> = z.object({
  id: z.string().min(1),
  version: z.literal(CANVAS_SCHEMA_VERSION),
  root: CanvasNodeSchema,
});

// ── Patch schemas ───────────────────────────────────────────────────────────

const AddNodeOpSchema = z.object({
  op: z.literal('add'),
  parentId: NodeIdSchema,
  index: z.number().int().nonnegative().optional(),
  node: CanvasNodeSchema,
});

const RemoveNodeOpSchema = z.object({
  op: z.literal('remove'),
  id: NodeIdSchema,
});

const ReplacePropsOpSchema = z.object({
  op: z.literal('replaceProps'),
  id: NodeIdSchema,
  props: z.record(z.string(), z.unknown()),
});

const SetTextOpSchema = z.object({
  op: z.literal('setText'),
  id: NodeIdSchema,
  text: z.string(),
});

export const CanvasPatchOpSchema: z.ZodType<CanvasPatchOp> = z.discriminatedUnion('op', [
  AddNodeOpSchema,
  RemoveNodeOpSchema,
  ReplacePropsOpSchema,
  SetTextOpSchema,
]);

export const CanvasPatchSchema: z.ZodType<CanvasPatch> = z.object({
  surfaceId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  ops: z.array(CanvasPatchOpSchema),
});

// ── Event schema ────────────────────────────────────────────────────────────

export const CanvasEventTypeSchema = z.enum(['click', 'change', 'submit']);

export const CanvasEventSchema: z.ZodType<CanvasEvent> = z.object({
  surfaceId: z.string().min(1),
  nodeId: NodeIdSchema,
  type: CanvasEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});

// ── applyPatch ─────────────────────────────────────────────────────────────

/** Reserved node fields that `replaceProps` is never allowed to overwrite. */
const PROTECTED_FIELDS = new Set(['id', 'type', 'children']);

/** Text-bearing field per node type. `null` means the node has no text. */
function textField(type: CanvasNode['type']): string | null {
  switch (type) {
    case 'heading':
    case 'text':
      return 'text';
    case 'button':
      return 'label';
    case 'textInput':
    case 'select':
      return 'value';
    case 'list':
    case 'stack':
      return null;
  }
}

function cloneNode(node: CanvasNode): CanvasNode {
  // Cheap deep clone — surfaces are small + JSON-shaped by construction.
  return JSON.parse(JSON.stringify(node)) as CanvasNode;
}

function findNodeWithParent(
  root: CanvasNode,
  id: string,
): { node: CanvasNode; parent: StackNode | null; index: number } | null {
  if (root.id === id) return { node: root, parent: null, index: -1 };
  if (root.type === 'stack') {
    for (let i = 0; i < root.children.length; i += 1) {
      const child = root.children[i]!;
      if (child.id === id) return { node: child, parent: root, index: i };
      const nested = findNodeWithParent(child, id);
      if (nested) return nested;
    }
  }
  return null;
}

function findNode(root: CanvasNode, id: string): CanvasNode | null {
  const hit = findNodeWithParent(root, id);
  return hit ? hit.node : null;
}

/**
 * Apply a `CanvasPatch` to a `CanvasSurface`, returning a new surface.
 * Pure — never mutates `surface`. Throws if `patch.surfaceId` doesn't match
 * `surface.id`, if any op references an unknown node, or if the patch tries
 * to violate an invariant (e.g. removing root, adding a non-stack parent,
 * `setText` on a non-text node).
 */
export function applyPatch(surface: CanvasSurface, patch: CanvasPatch): CanvasSurface {
  if (surface.id !== patch.surfaceId) {
    throw new Error(
      `applyPatch: surface id mismatch (surface=${surface.id}, patch=${patch.surfaceId})`,
    );
  }

  const nextRoot = cloneNode(surface.root);

  for (const op of patch.ops) {
    switch (op.op) {
      case 'add': {
        const parent = findNode(nextRoot, op.parentId);
        if (!parent) throw new Error(`applyPatch: unknown parent ${op.parentId}`);
        if (parent.type !== 'stack') {
          throw new Error(`applyPatch: cannot add child to non-stack node ${op.parentId}`);
        }
        if (findNode(nextRoot, op.node.id)) {
          throw new Error(`applyPatch: node ${op.node.id} already exists`);
        }
        const insertAt =
          op.index === undefined
            ? parent.children.length
            : Math.min(Math.max(op.index, 0), parent.children.length);
        parent.children.splice(insertAt, 0, cloneNode(op.node));
        break;
      }
      case 'remove': {
        if (nextRoot.id === op.id) {
          throw new Error(`applyPatch: cannot remove root node ${op.id}`);
        }
        const hit = findNodeWithParent(nextRoot, op.id);
        if (!hit || !hit.parent) {
          throw new Error(`applyPatch: unknown node ${op.id}`);
        }
        hit.parent.children.splice(hit.index, 1);
        break;
      }
      case 'replaceProps': {
        const node = findNode(nextRoot, op.id);
        if (!node) throw new Error(`applyPatch: unknown node ${op.id}`);
        // `node` is a member of the CanvasNode union; we widen to a record so
        // we can write each key without TS narrowing complaints. The Zod
        // schemas validate the *whole* surface, not per-op result, so callers
        // who want stricter prop validation should re-parse afterwards.
        const target = node as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(op.props)) {
          if (PROTECTED_FIELDS.has(k)) continue;
          target[k] = v;
        }
        break;
      }
      case 'setText': {
        const node = findNode(nextRoot, op.id);
        if (!node) throw new Error(`applyPatch: unknown node ${op.id}`);
        const field = textField(node.type);
        if (!field) {
          throw new Error(`applyPatch: node ${op.id} (type=${node.type}) has no text field`);
        }
        (node as unknown as Record<string, unknown>)[field] = op.text;
        break;
      }
    }
  }

  return {
    id: surface.id,
    version: surface.version,
    root: nextRoot,
  };
}
