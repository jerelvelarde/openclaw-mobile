// Hook-level tests for the client actions + readables.
//
// We mount each hook inside `<CopilotKitProvider>` + a `<TestHarness>`
// that exposes the side effects we want to assert (action invocation,
// gateway calls, readables registered). The harness is a single
// component so we don't fight React-Native's renderer scheduling.

// We share a single push/replace mock between the suites; tests can reset
// via `mockRouter.push.mockClear()`.
const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

import { useEffect } from 'react';
import { render, act } from '@testing-library/react-native';
import type { GatewayClient } from '@openclaw/protocol';

import { CopilotKitProvider, useCopilotKit } from '../CopilotKitProvider';
import { useOpenThreadAction, useSwitchAgentAction } from '../actions';
import { actionsToAGUITools, readablesToAGUIContext } from '../registry';
import {
  readDeviceLocale,
  useActiveAgentReadable,
  useLocaleReadable,
  useNetworkReadable,
  useThreadReadable,
} from '../readables';

const RUNTIME_URL = 'http://x:1/copilot/runtime';
const TOKEN = 'tok';

function makeFakeGateway(): GatewayClient & {
  _setActiveAgentCalls: string[];
} {
  const calls: string[] = [];
  const gw: Partial<GatewayClient> = {
    setActiveAgent: jest.fn(async (id: string) => {
      calls.push(id);
    }),
  };
  return Object.assign(gw as GatewayClient, { _setActiveAgentCalls: calls });
}

describe('useSwitchAgentAction', () => {
  it('updates the CopilotKit activeAgent and calls gateway.setActiveAgent', async () => {
    const gw = makeFakeGateway();
    const renderedAgents: string[] = [];
    const fired = { current: false };

    function Harness(): null {
      const switchAgent = useSwitchAgentAction(gw);
      const { activeAgent } = useCopilotKit();
      // Record the activeAgent every render so the assertion below can
      // pick up the update.
      renderedAgents.push(activeAgent);
      // Fire exactly once. `switchAgent`'s identity flips when the
      // CopilotKit context updates `activeAgent`, which would cause a
      // re-fire — so we guard explicitly.
      useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        void switchAgent('hermes');
      }, [switchAgent]);
      return null;
    }

    render(
      <CopilotKitProvider runtimeUrl={RUNTIME_URL} token={TOKEN}>
        <Harness />
      </CopilotKitProvider>,
    );
    // Let queued microtasks run so the gateway call resolves.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(gw._setActiveAgentCalls).toEqual(['hermes']);
    // The provider's activeAgent should have ticked from the default
    // ("openclaw.default") to "hermes".
    expect(renderedAgents[renderedAgents.length - 1]).toBe('hermes');
  });

  it('registers a switchAgent action visible to actionsToAGUITools', () => {
    let snapshot: ReturnType<typeof useCopilotKit> | null = null;
    function Harness(): null {
      const ctx = useCopilotKit();
      useSwitchAgentAction(null);
      snapshot = ctx;
      return null;
    }
    render(
      <CopilotKitProvider runtimeUrl={RUNTIME_URL} token={TOKEN}>
        <Harness />
      </CopilotKitProvider>,
    );
    const tools = actionsToAGUITools(snapshot!.registry.listActions());
    expect(tools.find((t) => t.name === 'switchAgent')).toBeDefined();
  });
});

describe('useOpenThreadAction', () => {
  it('routes through the expo-router push with the thread id', () => {
    mockRouter.push.mockClear();

    function Harness(): null {
      const open = useOpenThreadAction();
      useEffect(() => {
        open('thread_x');
      }, [open]);
      return null;
    }
    render(
      <CopilotKitProvider runtimeUrl={RUNTIME_URL} token={TOKEN}>
        <Harness />
      </CopilotKitProvider>,
    );
    expect(mockRouter.push).toHaveBeenCalledWith('/(tabs)/threads/thread_x');
  });
});

describe('readables composition', () => {
  it('produces a context array with current thread + agent + locale + network', () => {
    let snapshot: ReturnType<typeof useCopilotKit> | null = null;
    function Harness(): null {
      const ctx = useCopilotKit();
      snapshot = ctx;
      useThreadReadable({
        id: 't1',
        title: 'Thread 1',
        agentId: 'openclaw.default',
        updatedAt: 1,
      });
      useActiveAgentReadable({ id: 'openclaw.default', name: 'OpenClaw' });
      useLocaleReadable();
      useNetworkReadable();
      return null;
    }
    render(
      <CopilotKitProvider runtimeUrl={RUNTIME_URL} token={TOKEN}>
        <Harness />
      </CopilotKitProvider>,
    );
    const ctx = readablesToAGUIContext(snapshot!.registry.listReadables());
    const descriptions = ctx.map((e) => e.description);
    expect(descriptions).toEqual(
      expect.arrayContaining([
        'current thread',
        'active agent',
        'device locale and timezone',
        'device network type (wifi/cellular/unknown)',
      ]),
    );
    // The thread readable should JSON-stringify the input.
    const threadEntry = ctx.find((e) => e.description === 'current thread')!;
    const parsed = JSON.parse(threadEntry.value);
    expect(parsed).toMatchObject({ threadId: 't1', agentId: 'openclaw.default' });
  });

  it('readDeviceLocale produces a non-empty locale + timeZone', () => {
    const out = readDeviceLocale();
    expect(typeof out.locale).toBe('string');
    expect(typeof out.timeZone).toBe('string');
    expect(out.locale.length).toBeGreaterThan(0);
  });
});
