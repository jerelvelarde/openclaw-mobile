// Barrel for the Canvas v1 schema. Re-exported from `@openclaw/protocol`
// via `src/index.ts`; downstream apps import from the package root, not
// from this file.

export {
  CANVAS_SCHEMA_VERSION,
  type AddNodeOp,
  type ButtonNode,
  type CanvasEvent,
  type CanvasEventType,
  type CanvasNode,
  type CanvasNodeBase,
  type CanvasNodeType,
  type CanvasPatch,
  type CanvasPatchOp,
  type HeadingNode,
  type ListNode,
  type RemoveNodeOp,
  type ReplacePropsOp,
  type SelectNode,
  type SelectOption,
  type SetTextOp,
  type StackNode,
  type CanvasSurface,
  type TextInputNode,
  type TextNode,
} from './types';

export {
  CanvasEventSchema,
  CanvasEventTypeSchema,
  CanvasNodeSchema,
  CanvasPatchOpSchema,
  CanvasPatchSchema,
  CanvasSurfaceSchema,
  applyPatch,
} from './schemas';
