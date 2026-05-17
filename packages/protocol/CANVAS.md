# Canvas v1

`Canvas` is OpenClaw's lightweight UI-fragment format. An agent emits a
`CanvasSurface`; the mobile (P06A) and desktop (P06B) renderers display it
inline in chat or full-screen. The schema is deliberately minimal — six node
types, four patch ops, one event shape — so an agent can hand-emit valid
content and renderers stay implementable in an evening. We will widen the
schema only once a real agent has shipped Canvas content end-to-end.

All shapes are exported from `@openclaw/protocol`. Use the Zod schemas
(`CanvasSurfaceSchema`, `CanvasPatchSchema`, `CanvasEventSchema`) at the WS
boundary; use the plain TS interfaces inside renderers.

## Surface

A surface is `{ id, version, root }`. `version` is always `1` for the v1
schema; `root` is one `CanvasNode`. Most surfaces will use a `stack` root
to hold a list of children.

```json
{
  "id": "surface_abc",
  "version": 1,
  "root": {
    "type": "stack",
    "id": "root",
    "direction": "vertical",
    "children": []
  }
}
```

## Node types

Every node has `type` and `id`. `id` must be unique within the surface and
stable across patches — renderers key on it.

### `heading`

```json
{ "type": "heading", "id": "h1", "text": "Today's Tasks", "level": 2 }
```

`level` is `1`–`6` (default `1`).

### `text`

```json
{ "type": "text", "id": "intro", "text": "Three items are due today." }
```

### `button`

```json
{
  "type": "button",
  "id": "save",
  "label": "Save",
  "variant": "primary",
  "action": "save_form"
}
```

`variant` is `"primary"` | `"secondary"` | `"destructive"`. `action` is
echoed in the `click` event payload — use it to dispatch on the agent side.

### `textInput`

```json
{
  "type": "textInput",
  "id": "email_input",
  "name": "email",
  "value": "",
  "placeholder": "you@example.com"
}
```

Emits `change` events while typing (with the field `name` and the latest
`value`) and `submit` events when the user commits.

### `select`

```json
{
  "type": "select",
  "id": "color_select",
  "name": "color",
  "options": [
    { "label": "Red", "value": "r" },
    { "label": "Blue", "value": "b" }
  ],
  "value": "r"
}
```

### `list`

```json
{ "type": "list", "id": "todos", "items": ["Walk dog", "Pay rent"], "ordered": false }
```

`ordered` defaults to `false` (bulleted list).

### `stack`

```json
{
  "type": "stack",
  "id": "form",
  "direction": "vertical",
  "children": [{ "type": "heading", "id": "form_title", "text": "Sign in" }]
}
```

`direction` is `"vertical"` (default) | `"horizontal"`. `stack` is the only
node that has children — patches that try to `add` under a non-stack parent
error.

## Patches

A patch is `{ surfaceId, ts, ops }`. `ts` is monotonic per surface;
receivers MAY drop ops where `ts < lastApplied`. `ops` is a list of one or
more of:

- `add` — `{ op: "add", parentId, index?, node }` — insert `node` under
  `parentId` at `index` (default: append).
- `remove` — `{ op: "remove", id }` — delete the named node (cannot remove
  the root).
- `replaceProps` — `{ op: "replaceProps", id, props }` — shallow-merge
  `props` into the node. `id`, `type`, and `children` are protected and
  silently ignored.
- `setText` — `{ op: "setText", id, text }` — set the text-bearing field
  on the node (`text` on heading/text, `label` on button, `value` on
  textInput/select). Errors on list/stack.

```json
{
  "surfaceId": "surface_abc",
  "ts": 17030000000,
  "ops": [
    {
      "op": "add",
      "parentId": "root",
      "node": { "type": "text", "id": "msg", "text": "Hello!" }
    }
  ]
}
```

`applyPatch(surface, patch)` is a pure function exported from
`@openclaw/protocol`. It deep-clones the surface and returns a new one; the
input is never mutated. Any failing op throws, leaving the input untouched.

## Events

When the user interacts with a node, the renderer sends a `CanvasEvent`
back to the agent: `{ surfaceId, nodeId, type, payload }`. `type` is one
of `"click"`, `"change"`, or `"submit"`. `payload` is op-specific:

- `click` → `{ "action": "save_form" }` (echo of `ButtonNode.action`).
- `change` → `{ "name": "email", "value": "a@b.com" }`.
- `submit` → `{ "values": { "email": "a@b.com", "color": "r" } }` —
  every named input under the submitted subtree.

```json
{
  "surfaceId": "surface_abc",
  "nodeId": "save",
  "type": "click",
  "payload": { "action": "save_form" }
}
```

## Notes for agent authors

- Pick short, stable `id`s. Renderers use them for diffing.
- Prefer patches over full surface re-sends. Patches keep the user's
  focus/scroll state intact across updates.
- Don't nest surfaces — there is only one surface per Canvas message.
- The wire envelope (`{ id, topic, type, payload, ts }`) wraps the
  surface or patch on `canvas.*` topics.
