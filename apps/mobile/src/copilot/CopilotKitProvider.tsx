// React context for the mobile CopilotKit runtime client.
//
// Owns:
//   - The runtime URL + bearer token (read from the pairing state).
//   - The currently-selected agent id.
//   - An in-memory action + readable registry (per `registry.ts`).
//
// Consumers:
//   - `app/(tabs)/threads/[id].tsx` calls `useCopilotKit()` to grab the
//     runtime config and registry, then `runAgent()` directly.
//   - Any component can register an action with `useCopilotAction({ name,
//     parameters, handler })` or a readable with
//     `useCopilotReadable({ description, value })`. Both hooks unregister
//     on unmount so the registry stays scoped to whatever is mounted.
//
// We deliberately *don't* wrap the chat surface itself — the plan calls
// for `<CopilotChat>` or an RN equivalent; we ship the RN equivalent in
// `threads/[id].tsx` and the provider only owns the data plumbing.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import {
  actionsToAGUITools,
  createRegistry,
  readablesToAGUIContext,
  type CopilotAction,
  type CopilotActionParam,
  type CopilotReadable,
  type CopilotRegistry,
} from './registry';
import type { RuntimeMode } from './runtimeUrl';
import type { AGUIContextEntry, AGUITool } from './types';

/** Public context shape. */
export interface CopilotKitContextValue {
  /**
   * Absolute base URL for the runtime adapter (no trailing slash).
   *
   * In `mode === 'p05c'` this is the desktop CopilotKit adapter URL
   * (`http://host:18789/copilot/runtime`). In `mode === 'clawg-ui'` this
   * is the daemon BASE URL (`http://host:18789`); the `/v1/clawg-ui`
   * suffix is appended by `runAgent` via `resolveRuntimeRequest`. Q46:
   * the value comes from `state.clawgUiBaseUrl` in clawg-ui mode.
   */
  runtimeUrl: string;
  /** Bearer token (raw, without "Bearer " prefix). */
  token: string;
  /**
   * Wire mode the runtime client should use. Defaults to `'p05c'` so
   * existing callers (and tests) don't have to change. Set to
   * `'clawg-ui'` when the desktop advertised a clawg-ui base URL at
   * pairing time (P11A/Q46).
   */
  mode: RuntimeMode;
  /** Agent id all runs default to until the caller overrides. */
  activeAgent: string;
  /** Update the active agent id (used by `agents.tsx`). */
  setActiveAgent: (agentId: string) => void;
  /** Live snapshot of `RunAgentInput.tools` for the next run. */
  tools: AGUITool[];
  /** Live snapshot of `RunAgentInput.context` for the next run. */
  context: AGUIContextEntry[];
  /** Underlying registry — exposed so the chat surface can find actions. */
  registry: CopilotRegistry;
  /** Bump on every mutation so consumers can re-render. */
  registryVersion: number;
}

const CopilotKitContext = createContext<CopilotKitContextValue | null>(null);

export interface CopilotKitProviderProps {
  children: ReactNode;
  runtimeUrl: string;
  token: string;
  /**
   * Which wire format the runtime client should speak. Defaults to
   * `'p05c'` (today's desktop adapter URL). Pass `'clawg-ui'` along
   * with a clawg-ui daemon BASE URL in `runtimeUrl` to route real-mode
   * chat through the user's openclaw daemon (Q46). The `runAgent` pump
   * uses this to pick the right URL + headers.
   */
  mode?: RuntimeMode;
  /** Initial active agent — defaults to `openclaw.default`. */
  initialAgent?: string;
}

export const DEFAULT_AGENT_ID = 'openclaw.default';

/**
 * Wrap a subtree in the CopilotKit runtime context. Place this around the
 * paired tabs in `app/_layout.tsx`. The provider is cheap to mount — it
 * has no side effects beyond owning React state.
 */
export function CopilotKitProvider({
  children,
  runtimeUrl,
  token,
  mode,
  initialAgent,
}: CopilotKitProviderProps): ReactElement {
  // Registry is stable across renders — `useRef` keeps the same Map
  // instance so action/readable identities don't flip on every re-render.
  const registryRef = useRef<CopilotRegistry>(createRegistry());
  const [version, setVersion] = useState(0);
  const bump = useCallback((): void => setVersion((v) => v + 1), []);

  // We instrument the registry to bump `version` on every mutation, so
  // consumers calling `tools`/`context` re-derive when something changes.
  // The Map operations stay on the underlying registry — we just intercept
  // for the side effect.
  const instrumented = useMemo<CopilotRegistry>(() => {
    const r = registryRef.current;
    return {
      setAction(id, action) {
        r.setAction(id, action);
        bump();
      },
      removeAction(id) {
        r.removeAction(id);
        bump();
      },
      setReadable(id, readable) {
        r.setReadable(id, readable);
        bump();
      },
      removeReadable(id) {
        r.removeReadable(id);
        bump();
      },
      listActions: () => r.listActions(),
      listReadables: () => r.listReadables(),
      findAction: (name) => r.findAction(name),
    };
  }, [bump]);

  const [activeAgent, setActiveAgent] = useState(initialAgent ?? DEFAULT_AGENT_ID);

  const tools = useMemo(
    () => actionsToAGUITools(instrumented.listActions()),
    [instrumented, version],
  );
  const context = useMemo(
    () => readablesToAGUIContext(instrumented.listReadables()),
    [instrumented, version],
  );

  const resolvedMode: RuntimeMode = mode ?? 'p05c';

  const value = useMemo<CopilotKitContextValue>(
    () => ({
      runtimeUrl,
      token,
      mode: resolvedMode,
      activeAgent,
      setActiveAgent,
      tools,
      context,
      registry: instrumented,
      registryVersion: version,
    }),
    [runtimeUrl, token, resolvedMode, activeAgent, tools, context, instrumented, version],
  );

  return <CopilotKitContext.Provider value={value}>{children}</CopilotKitContext.Provider>;
}

/** Read the active CopilotKit context. Throws outside a provider. */
export function useCopilotKit(): CopilotKitContextValue {
  const ctx = useContext(CopilotKitContext);
  if (!ctx) throw new Error('useCopilotKit() must be used inside <CopilotKitProvider>');
  return ctx;
}

/** Optional flavor for screens that want to no-op outside a provider. */
export function useOptionalCopilotKit(): CopilotKitContextValue | null {
  return useContext(CopilotKitContext);
}

// ── Hooks ────────────────────────────────────────────────────────────────

/**
 * Register a client action with the runtime. Mirrors v1 CopilotKit's
 * `useCopilotAction` API. The handler is stored in the registry and
 * (eventually) invoked when the agent emits a matching tool call —
 * today the desktop adapter forwards tool calls one-way (see open
 * question #27), so handlers are forward-compat.
 *
 * `deps` controls when the registration updates (default: mounts once,
 * never re-registers). When `name`/`parameters` change you'll usually
 * want a stable registration id keyed on `name`.
 */
export function useCopilotAction<Args extends Record<string, unknown> = Record<string, unknown>>(
  action: CopilotAction<Args>,
  deps: ReadonlyArray<unknown> = [],
): void {
  const ctx = useOptionalCopilotKit();
  // Stable id keyed by action name so the same name always overwrites
  // rather than appending a duplicate.
  const id = `action:${action.name}`;
  // Keep the latest action in a ref so the registry always sees the
  // freshest handler without re-registering on every render.
  const latest = useRef(action);
  latest.current = action;
  // Capture the registry in a ref so the effect doesn't depend on the
  // entire context value (which flips identity on every internal
  // setState — including the one that fires inside `setAction`). The
  // registry itself is stable across renders.
  const registryRef = useRef(ctx?.registry ?? null);
  registryRef.current = ctx?.registry ?? null;

  useEffect(() => {
    const registry = registryRef.current;
    if (!registry) return;
    // We register a thin wrapper so the registry's `findAction` reads the
    // ref — captured handlers won't get stale after a re-render.
    const wrapper: CopilotAction<Record<string, unknown>> = {
      name: action.name,
      description: action.description,
      parameters: action.parameters as CopilotActionParam[],
      handler: (args) => latest.current.handler(args as Args),
    };
    registry.setAction(id, wrapper);
    return () => registry.removeAction(id);
    // We intentionally re-register only when `id`/`deps` change. The
    // `ctx` identity churns on every internal setState (notably the
    // `bump()` triggered by `setAction` itself), so depending on it
    // here would cause an unregister/register storm.
  }, [id, ...deps]);
}

/**
 * Register a readable with the runtime. Mirrors v1 CopilotKit's
 * `useCopilotReadable` API. The value is serialized into
 * `RunAgentInput.context` on every run.
 */
export function useCopilotReadable(
  readable: CopilotReadable,
  /** Override the auto-generated registration id (defaults to `description`). */
  id?: string,
): void {
  const ctx = useOptionalCopilotKit();
  const registrationId = `readable:${id ?? readable.description}`;
  // Serialize value into the dependency list so identity changes refresh
  // the registration. Falling back to a String() coercion keeps the dep
  // stable even when the value isn't JSON-safe.
  const valueKey = useMemo(() => {
    try {
      return JSON.stringify(readable.value);
    } catch {
      return String(readable.value);
    }
  }, [readable.value]);
  // See `useCopilotAction` — capture the registry in a ref to avoid the
  // setVersion → ctx-flip → re-register loop.
  const registryRef = useRef(ctx?.registry ?? null);
  registryRef.current = ctx?.registry ?? null;
  const latestReadable = useRef(readable);
  latestReadable.current = readable;
  useEffect(() => {
    const registry = registryRef.current;
    if (!registry) return;
    registry.setReadable(registrationId, latestReadable.current);
    return () => registry.removeReadable(registrationId);
    // We re-register only when the value or description changes.
  }, [registrationId, readable.description, valueKey]);
}
