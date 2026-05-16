// Client-side CopilotKit readables exposed on the mobile tree.
//
// Per the P05A plan we expose four things the agent should always see:
//
//   - current thread (id + agent + title),
//   - active agent id,
//   - device locale + timezone (derived from `Intl`),
//   - network type (Wi-Fi vs cellular).
//
// Locale + timezone use `Intl.DateTimeFormat().resolvedOptions()` —
// available in Hermes + JSC on RN, no native module needed.
//
// Network type: a real Wi-Fi-vs-cellular signal needs a native module
// (e.g. `expo-network` or `@react-native-community/netinfo`). We don't
// pull one in v1 to avoid an `expo prebuild` churn (see open question
// #25). The readable is a stub that returns "unknown" — agents can
// still read it, and we leave a TODO so a future plan can swap in the
// real probe without changing the registry shape.

import { useMemo } from 'react';
import { Platform } from 'react-native';

import { useCopilotReadable } from './CopilotKitProvider';
import type { Agent, Thread } from '@openclaw/protocol';

/** What we expose to the agent for the active thread. */
export interface ThreadReadable {
  threadId: string;
  agentId: string;
  title: string;
}

/** What we expose for the device locale. */
export interface LocaleReadable {
  locale: string;
  timeZone: string;
  /** OS family — agents sometimes branch on this (e.g. mobile-only tips). */
  platform: typeof Platform.OS;
}

/** What we expose for the network type — TODO when we add expo-network. */
export interface NetworkReadable {
  /** "wifi" | "cellular" | "ethernet" | "vpn" | "unknown" | "offline". */
  type: 'wifi' | 'cellular' | 'ethernet' | 'vpn' | 'unknown' | 'offline';
}

/**
 * Read the device locale + timezone from `Intl`. Pure helper; lives
 * outside the hook so it's testable without React.
 */
export function readDeviceLocale(): LocaleReadable {
  let locale = 'en-US';
  let timeZone = 'UTC';
  try {
    const opts = new Intl.DateTimeFormat().resolvedOptions();
    if (opts.locale) locale = opts.locale;
    if (opts.timeZone) timeZone = opts.timeZone;
  } catch {
    // Hermes pre-Intl builds throw — keep the defaults. Modern Expo SDK
    // 54 ships Hermes with Intl on, so this path is mostly unreachable.
  }
  return { locale, timeZone, platform: Platform.OS };
}

/**
 * Register the active-thread readable.
 *
 * Pass `null` for `thread` when no thread is selected — the readable
 * surfaces an empty record so the agent knows the user is "between
 * threads" rather than seeing stale data.
 */
export function useThreadReadable(thread: Thread | null): void {
  const value: ThreadReadable | null = useMemo(
    () =>
      thread
        ? {
            threadId: thread.id,
            agentId: thread.agentId,
            title: thread.title,
          }
        : null,
    [thread],
  );
  useCopilotReadable({ description: 'current thread', value }, 'current-thread');
}

/** Register the active-agent readable. */
export function useActiveAgentReadable(agent: Agent | { id: string; name?: string } | null): void {
  const value = useMemo(
    () =>
      agent
        ? {
            agentId: agent.id,
            name: 'name' in agent ? agent.name : undefined,
          }
        : null,
    [agent],
  );
  useCopilotReadable({ description: 'active agent', value }, 'active-agent');
}

/** Register the locale + timezone readable. */
export function useLocaleReadable(): void {
  // `Intl.DateTimeFormat().resolvedOptions()` is cheap but not free; we
  // memo for the lifetime of the screen.
  const value = useMemo<LocaleReadable>(readDeviceLocale, []);
  useCopilotReadable({ description: 'device locale and timezone', value }, 'device-locale');
}

/**
 * Register the network-type readable. Stubbed today (returns
 * `{ type: "unknown" }`) until we pull in a network probe — see header.
 */
export function useNetworkReadable(): void {
  // TODO: swap to expo-network's `getNetworkStateAsync()` once we're
  // willing to bump native deps (see open question #25). For v1 a static
  // "unknown" entry is enough — agents that care can fall back to
  // server-side heuristics.
  useCopilotReadable(
    {
      description: 'device network type (wifi/cellular/unknown)',
      value: { type: 'unknown' } satisfies NetworkReadable,
    },
    'network-type',
  );
}

/**
 * Convenience hook that wires all four readables at once. Use this from
 * `threads/[id].tsx` — single import keeps the screen tidy.
 */
export function useStandardReadables(input: {
  thread: Thread | null;
  agent: Agent | { id: string; name?: string } | null;
}): void {
  useThreadReadable(input.thread);
  useActiveAgentReadable(input.agent);
  useLocaleReadable();
  useNetworkReadable();
}
