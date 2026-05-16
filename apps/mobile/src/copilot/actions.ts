// Client-side CopilotKit actions registered on the mobile tree.
//
// Two actions per the P05A plan:
//
//   - `switchAgent({ agentId })` — sets the active agent the next run
//     routes to. Updates both the local CopilotKit context (so the next
//     POST goes to /agent/<id>/run) AND, when a gateway is connected,
//     the desktop's `agents.setActive` (so the gateway knows the user
//     picked this device's default route).
//   - `openThread({ id })` — navigates the user to a thread. Returns a
//     short status string the agent can read (today the round-trip path
//     isn't open — see open question #27 — so the string is best-effort
//     and used only by the action handler's local UI side effect).
//
// Both actions are forward-compatible with the eventual tool-result
// round-trip: when the desktop adapter learns to feed `tool`-role
// messages back into the agent loop, the handlers' return values will
// surface automatically.

import { useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

import { useCopilotAction, useOptionalCopilotKit } from './CopilotKitProvider';
import type { GatewayClient } from '@openclaw/protocol';

/**
 * Register `switchAgent` against the CopilotKit registry. Pass the
 * gateway so the action can persist the user's choice. The hook returns
 * a stable handler for callers that want to invoke `switchAgent`
 * imperatively (e.g. from the `agents.tsx` screen).
 *
 * Safe to call from screens that may render outside the CopilotKit
 * provider — the registration becomes a no-op when no provider is
 * present, and the imperative handler still routes to the gateway.
 */
export function useSwitchAgentAction(
  gateway: GatewayClient | null,
): (agentId: string) => Promise<void> {
  const ctx = useOptionalCopilotKit();
  // Capture both via refs so the returned handler's identity stays
  // stable across `ctx` identity flips (which happen on every internal
  // setState in the CopilotKit provider). Otherwise an `useEffect(..,
  // [switchAgent])` consumer would re-fire on every parent re-render.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;

  const handler = useCallback(async (agentId: string): Promise<void> => {
    // Update the local context first so the next chat run uses the new
    // agent even if the WS round-trip is slow.
    ctxRef.current?.setActiveAgent(agentId);
    const gw = gatewayRef.current;
    if (gw) {
      try {
        await gw.setActiveAgent(agentId);
      } catch (err) {
        // The gateway-side call is best-effort: a failure shouldn't
        // tear down the UI swap. Surface to console + return so the
        // caller can show a toast if it wants.
        // eslint-disable-next-line no-console
        console.warn('[openclaw/copilot] setActiveAgent failed:', err);
      }
    }
  }, []);

  useCopilotAction(
    {
      name: 'switchAgent',
      description:
        'Switch the agent this device routes new messages to. The next chat turn goes to the chosen agent.',
      parameters: [
        {
          name: 'agentId',
          type: 'string',
          description: 'Stable id of the target agent (e.g. "hermes" or "openclaw.default").',
          required: true,
        },
      ],
      handler: async (args) => {
        const agentId = typeof args['agentId'] === 'string' ? args['agentId'] : '';
        if (!agentId) {
          return { ok: false, reason: 'agentId is required' };
        }
        await handler(agentId);
        return { ok: true, agentId };
      },
    },
    [handler],
  );

  return handler;
}

/**
 * Register `openThread`. The handler is also returned so callers can
 * navigate without going through the registry.
 */
export function useOpenThreadAction(): (threadId: string) => void {
  const router = useRouter();
  const handler = useCallback(
    (threadId: string): void => {
      // Expo Router accepts `/(tabs)/threads/[id]` via the URL form.
      router.push(`/(tabs)/threads/${encodeURIComponent(threadId)}`);
    },
    [router],
  );

  useCopilotAction(
    {
      name: 'openThread',
      description: 'Open a chat thread on the device.',
      parameters: [
        {
          name: 'id',
          type: 'string',
          description: 'Thread id, e.g. "thread_stub" or any UUID.',
          required: true,
        },
      ],
      handler: (args) => {
        const id = typeof args['id'] === 'string' ? args['id'] : '';
        if (!id) return { ok: false, reason: 'id is required' };
        handler(id);
        return { ok: true, threadId: id };
      },
    },
    [handler],
  );

  return handler;
}
