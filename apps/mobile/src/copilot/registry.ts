// Action + readable registry the `CopilotKitProvider` owns.
//
// Pure data structures + a small in-memory registry. The React hooks
// (`useCopilotAction`, `useCopilotReadable`) wrap this registry; the
// chat runner reads from it when assembling `RunAgentInput.tools` /
// `RunAgentInput.context`.
//
// Why a custom shape (and not `useFrontendTool` from the CopilotKit RN
// package): the plan calls for v1-style `useCopilotAction` semantics —
// a named handler the agent can invoke — but the CopilotKit RN v2 API
// renames it to `useFrontendTool` and removes the runtime registry we
// need to drive `RunAgentInput.tools`. Since we're not pulling the RN
// package (see `runAgent.ts` rationale), we mint our own.
//
// Tool-result round-trip is open question #27 — for v1, registered
// actions are forwarded to the runtime as `tools` so the agent can call
// them, and the tool-call inspector shows the invocation. The reverse
// path (running the handler and feeding the result back into the next
// run's `messages`) is parked behind a TODO.

import type { AGUIContextEntry, AGUITool } from './types';

/**
 * One parameter on a client action. Shape matches what we serialize into
 * `AGUITool.parameters` (a JSON-schema fragment with `properties`).
 */
export interface CopilotActionParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  required?: boolean;
}

/** A registered client action, mirroring v1's `useCopilotAction` shape. */
export interface CopilotAction<Args = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: CopilotActionParam[];
  /**
   * Handler invoked when the agent (eventually) returns a tool call for
   * this action. Today the desktop adapter doesn't round-trip results
   * (open question #27) — registering a handler is forward-compat.
   * Returning a value will be fed back via `tool`-role messages once the
   * round-trip lands.
   */
  handler: (args: Args) => unknown | Promise<unknown>;
}

/** A registered readable, mirroring v1's `useCopilotReadable` shape. */
export interface CopilotReadable {
  description: string;
  /** Anything `JSON.stringify`-able; we render to a string at send time. */
  value: unknown;
}

/** Registry surface — what the provider hands to the rest of the tree. */
export interface CopilotRegistry {
  setAction(id: string, action: CopilotAction<Record<string, unknown>>): void;
  removeAction(id: string): void;
  setReadable(id: string, readable: CopilotReadable): void;
  removeReadable(id: string): void;
  /** Snapshot of registered actions, in insertion order. */
  listActions(): CopilotAction<Record<string, unknown>>[];
  /** Snapshot of registered readables, in insertion order. */
  listReadables(): CopilotReadable[];
  /** Find an action by `name` (used when the agent invokes a tool call). */
  findAction(name: string): CopilotAction<Record<string, unknown>> | undefined;
}

/**
 * Build a registry. We keep a single ordered Map per slot so re-renders
 * that re-register the same `id` overwrite cleanly without churning
 * snapshot order.
 */
export function createRegistry(): CopilotRegistry {
  const actions = new Map<string, CopilotAction<Record<string, unknown>>>();
  const readables = new Map<string, CopilotReadable>();
  return {
    setAction(id, action) {
      actions.set(id, action);
    },
    removeAction(id) {
      actions.delete(id);
    },
    setReadable(id, readable) {
      readables.set(id, readable);
    },
    removeReadable(id) {
      readables.delete(id);
    },
    listActions() {
      return [...actions.values()];
    },
    listReadables() {
      return [...readables.values()];
    },
    findAction(name) {
      for (const a of actions.values()) {
        if (a.name === name) return a;
      }
      return undefined;
    },
  };
}

/**
 * Serialize a registry's actions into the AG-UI `tools` array the runtime
 * expects on `RunAgentInput.tools`. We convert each `parameters` list into
 * a JSON-Schema `object` with `properties` so the agent can plan calls.
 */
export function actionsToAGUITools(actions: CopilotAction<Record<string, unknown>>[]): AGUITool[] {
  return actions.map((a) => ({
    name: a.name,
    description: a.description,
    parameters: paramsToJsonSchema(a.parameters),
  }));
}

/** Convert our compact param list to a JSON-schema `object` fragment. */
export function paramsToJsonSchema(params: CopilotActionParam[]): {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
} {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const p of params) {
    properties[p.name] = p.description
      ? { type: p.type, description: p.description }
      : { type: p.type };
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required };
}

/**
 * Serialize a registry's readables into the `context` array the runtime
 * expects on `RunAgentInput.context`. Values are stringified so the
 * agent sees them as plain text (avoids ambiguous serialization rules
 * for arbitrary JSON).
 */
export function readablesToAGUIContext(readables: CopilotReadable[]): AGUIContextEntry[] {
  return readables.map((r) => ({
    description: r.description,
    value: stringifyValue(r.value),
  }));
}

/**
 * Stringify any readable value. Strings pass through unchanged; everything
 * else goes through `JSON.stringify` with a 2-space indent so the agent
 * sees structured data legibly.
 */
export function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
