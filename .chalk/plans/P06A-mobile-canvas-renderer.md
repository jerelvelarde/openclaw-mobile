# P06A — Mobile Canvas renderer

**App:** mobile (`apps/mobile`)
**Estimated effort:** 1.5 days
**Depends on:** P06.0
**Blocks:** —
**Can run in parallel with:** P06B

## Context

Render Canvas surfaces emitted by agents inline in chat and as standalone
screens. Implements the v1 schema defined in P06.0. Per `plan.md` §5 (Thread
screen has "Canvas" support).

## Goal

When an agent emits a Canvas surface in a thread, it renders as a native
RN tree. Buttons, inputs, and selects are interactive; events POST back
through the gateway. Patches stream in and update the surface in place.

## Outputs

- `apps/mobile/src/canvas/CanvasRenderer.tsx`
- `apps/mobile/src/canvas/nodes/{Heading,Text,Button,TextInput,Select,List,Stack}.tsx`
- `apps/mobile/src/canvas/useCanvas.ts` — subscribes to `onCanvasUpdate`, applies patches.
- Inline integration in `app/(tabs)/threads/[id].tsx`.
- Tests covering: rendering each node type, applying a patch, dispatching an event.

## Steps

1. `CanvasRenderer.tsx` — recursively renders nodes via a switch on `type`.
2. Each node component:
   - Pure presentational where possible.
   - `Button`: tap → dispatches `CanvasEvent { type: "click" }` via gateway.
   - `TextInput`: controlled; `onBlur` dispatches `change` event (debounce 300ms).
   - `Select`: native picker; `onValueChange` dispatches `change`.
3. `useCanvas(surfaceId)`:
   - Fetch initial surface via `getCanvas`.
   - Subscribe to `onCanvasUpdate` and apply patches with `applyPatch` from protocol.
   - Returns `{ surface, dispatchEvent }`.
4. In `threads/[id].tsx`:
   - When a message is `{ type: "canvas", surfaceId }`, render `<CanvasRenderer/>` inline.
   - Add a per-thread "Canvas" tab if the thread has at least one canvas (optional v1).
5. Tests:
   - Snapshot for each node type.
   - Patch applies and re-renders.
   - Event dispatch hits the mocked gateway.

## Success criteria

- [ ] In dev (against P04B stub gateway), trigger a Canvas surface from the agent and see it render.
- [ ] Tapping a `Button` round-trips through the gateway; agent's response patch updates the surface in place.
- [ ] All tests pass.

## Verification

```sh
pnpm --filter @openclaw/mobile typecheck
pnpm --filter @openclaw/mobile test
# Manual against desktop dev + stub:
pnpm --filter @openclaw/desktop dev
pnpm --filter @openclaw/mobile start
```

## Commit

```
Render Canvas surfaces inline in mobile chat

Recursive CanvasRenderer covers v1 node types; useCanvas hook
subscribes to patch updates and dispatches user events back through
the gateway. Inline rendering inside threads/[id]; per-thread Canvas
tab when present.
```

## Notes

- Keep node components dumb. Routing back through the gateway is the renderer hook's job.
- Don't add gestures, animations, or layout tricks in v1.
- Web rendering must work too — RN primitives + a couple of `Platform.select` calls.
- Do **not** extend the Canvas schema in this plan. Bug back to P06.0 if you find gaps.
