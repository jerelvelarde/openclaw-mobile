// Canvas v1 schema — TS types.
//
// A `CanvasSurface` is an agent-emittable UI fragment that mobile + desktop
// renderers (P06A, P06B) display inline in chat or full-screen. The schema is
// intentionally small (six node types, four patch ops, one event shape) so
// agent authors can hand-emit valid surfaces and so renderers stay
// implementable in an evening. We will widen the schema only once a real
// agent has shipped Canvas content end-to-end.
//
// Field names are short on purpose — surfaces flow over a chat channel where
// every byte of agent output costs latency and tokens. Every type here has a
// Zod schema in `./schemas.ts`; the runtime validators are the source of
// truth at the WS boundary, the plain interfaces here exist so consumers can
// opt out of pulling Zod into their type graph.
//
// See `packages/protocol/CANVAS.md` for a JSON-shaped reference + examples.

/** Current schema version. Bump on any breaking change. */
export const CANVAS_SCHEMA_VERSION = 1;

/** Roles a node may play in the user-input lifecycle. */
export type CanvasEventType = 'click' | 'change' | 'submit';

// ── Nodes ───────────────────────────────────────────────────────────────────

/** Base fields every node carries. `id` is renderer-stable across patches. */
export interface CanvasNodeBase {
  /** Renderer-stable id, unique within the surface. */
  id: string;
}

/** A heading. `level` matches HTML h1–h6 (default 1). */
export interface HeadingNode extends CanvasNodeBase {
  type: 'heading';
  text: string;
  /** 1–6, default 1. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
}

/** A run of plain text. Renderers MAY wrap long content. */
export interface TextNode extends CanvasNodeBase {
  type: 'text';
  text: string;
}

/** A press-to-act control. Emits a `click` `CanvasEvent`. */
export interface ButtonNode extends CanvasNodeBase {
  type: 'button';
  /** Visible label. */
  label: string;
  /** Visual treatment hint; renderer-defined. */
  variant?: 'primary' | 'secondary' | 'destructive';
  /** Free-form data echoed in the event payload. */
  action?: string;
}

/** A single-line text input. Emits `change` while typing, `submit` on commit. */
export interface TextInputNode extends CanvasNodeBase {
  type: 'textInput';
  /** Field name returned in event payloads. */
  name: string;
  /** Initial value. */
  value?: string;
  /** Placeholder text shown when empty. */
  placeholder?: string;
}

/** Picker over a fixed option set. Emits `change` on selection. */
export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectNode extends CanvasNodeBase {
  type: 'select';
  name: string;
  options: SelectOption[];
  /** Currently selected option value, if any. */
  value?: string;
}

/** A bullet/numbered list of strings. Read-only. */
export interface ListNode extends CanvasNodeBase {
  type: 'list';
  items: string[];
  /** Default `unordered`. */
  ordered?: boolean;
}

/** A container. Children render in declaration order. */
export interface StackNode extends CanvasNodeBase {
  type: 'stack';
  /** Default `vertical`. */
  direction?: 'vertical' | 'horizontal';
  children: CanvasNode[];
}

/** The full v1 node union. */
export type CanvasNode =
  | HeadingNode
  | TextNode
  | ButtonNode
  | TextInputNode
  | SelectNode
  | ListNode
  | StackNode;

/** Node `type` discriminator strings, exported for renderer switches. */
export type CanvasNodeType = CanvasNode['type'];

// ── Surface ─────────────────────────────────────────────────────────────────

/**
 * A complete Canvas surface emitted by an agent. The renderer mounts `root`
 * and re-renders on every patch. `version` is the schema version (not a per-
 * surface revision counter; see `CanvasPatch.ts` for ordering).
 */
export interface CanvasSurface {
  /** Globally unique surface id. */
  id: string;
  /** Schema version. Always `1` for the v1 schema. */
  version: number;
  /** Root node of the surface tree. */
  root: CanvasNode;
}

// ── Patches ─────────────────────────────────────────────────────────────────

/** Add a new node as a child of `parentId` at `index` (0 = prepend). */
export interface AddNodeOp {
  op: 'add';
  parentId: string;
  /** If omitted, appended to the end of the parent's children. */
  index?: number;
  node: CanvasNode;
}

/** Remove the node identified by `id` from its parent. */
export interface RemoveNodeOp {
  op: 'remove';
  id: string;
}

/**
 * Shallow-merge the given partial props into the node. `id` and `type` are
 * never overwritten; `children` is ignored (use `add` / `remove` instead).
 */
export interface ReplacePropsOp {
  op: 'replaceProps';
  id: string;
  props: Record<string, unknown>;
}

/**
 * Set the text-bearing field on a node (`text` on heading/text, `label` on
 * button, `value` on textInput/select). Errors at apply-time if the node
 * does not own a text field.
 */
export interface SetTextOp {
  op: 'setText';
  id: string;
  text: string;
}

export type CanvasPatchOp = AddNodeOp | RemoveNodeOp | ReplacePropsOp | SetTextOp;

/** A batch of ops applied atomically to a single surface. */
export interface CanvasPatch {
  surfaceId: string;
  /** Monotonic per surface; receivers MAY drop ops with `ts < lastApplied`. */
  ts: number;
  ops: CanvasPatchOp[];
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * User input on a Canvas node, sent from renderer back to the agent.
 * `payload` is op-specific:
 *  - `click`: `{ action?: string }` (echo of `ButtonNode.action`).
 *  - `change`: `{ name: string; value: string }`.
 *  - `submit`: `{ values: Record<string, string> }`.
 */
export interface CanvasEvent {
  surfaceId: string;
  nodeId: string;
  type: CanvasEventType;
  payload: Record<string, unknown>;
}
