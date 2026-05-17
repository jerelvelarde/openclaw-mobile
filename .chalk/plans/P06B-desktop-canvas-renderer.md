# P06B — Desktop Canvas renderer

**App:** desktop (`apps/desktop`)
**Estimated effort:** 1.5 days
**Depends on:** P06.0
**Blocks:** —
**Can run in parallel with:** P06A

## Context

Mirror of P06A on the desktop side — render Canvas surfaces emitted by
agents inline in chat. Same schema, same event protocol.

## Goal

Canvas surfaces from agents render in the desktop chat UI; user input
round-trips through the same gateway protocol mobile uses.

## Outputs

- `apps/desktop/src/renderer/canvas/CanvasRenderer.tsx`
- `apps/desktop/src/renderer/canvas/nodes/*.tsx` (HTML, not RN)
- `apps/desktop/src/renderer/canvas/useCanvas.ts`
- Integration in `Chat.tsx`.
- Tests.

## Steps

1. `CanvasRenderer.tsx` — same recursive switch on `type`, but with HTML nodes (`<h1>`, `<button>`, `<input>`, `<select>`).
2. Node components mirror P06A's behavior but for the DOM.
3. `useCanvas.ts` mirrors the mobile hook; same `applyPatch` import from protocol.
4. In `Chat.tsx`: render `<CanvasRenderer/>` inline when a message references a surface.
5. Tests with React Testing Library + jsdom.

## Success criteria

- [ ] Canvas surface from stub agent renders in desktop chat.
- [ ] Button + input events round-trip identically to mobile.
- [ ] Tests pass.

## Verification

```sh
pnpm --filter @openclaw/desktop typecheck
pnpm --filter @openclaw/desktop test
```

## Commit

```
Render Canvas surfaces inline in desktop chat

Mirror of mobile renderer using HTML primitives. Shares schema +
applyPatch with mobile via @openclaw/protocol; mounted inline in
Chat.tsx when a message references a surface.
```

## Notes

- Style with the same minimal CSS approach as P05B.
- Do **not** introduce a separate desktop-only Canvas schema. Both renderers consume the same types.
- Behaviour parity with mobile matters more than visual polish here. If you spot a divergence between mobile and desktop event payloads, file an issue and fix in protocol, not in the renderer.
