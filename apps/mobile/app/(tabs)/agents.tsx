// Agents tab — list reachable agents and switch the active route.
//
// Reads `gateway.listAgents()` once on mount (and on focus, via the
// `useEffect` re-running when `gateway` changes). Tapping a row calls
// `switchAgent` from the CopilotKit actions module — which updates the
// CopilotKit context's `activeAgent` AND the gateway's `setActiveAgent`
// WS topic so the desktop knows the user picked this agent.
//
// Empty list rendering covers two cases:
//   - No gateway is connected yet (still on the mock; pre-pairing).
//   - The desktop returned an empty list (rare; usually means the agent
//     registry hasn't booted on the host).

import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Agent } from '@openclaw/protocol';

import { useSwitchAgentAction } from '../../src/copilot/actions';
import { useOptionalCopilotKit } from '../../src/copilot/CopilotKitProvider';
import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

export default function AgentsScreen() {
  const { gateway, state } = usePairing();
  const copilot = useOptionalCopilotKit();
  const activeAgent = copilot?.activeAgent;
  const switchAgent = useSwitchAgentAction(gateway);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await gateway.listAgents();
      setAgents(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  // Re-fetch when the user lands on this tab and whenever the gateway
  // identity changes (e.g. after a re-pair).
  useEffect(() => {
    if (state.status !== 'paired') return;
    void refresh();
  }, [refresh, state.status]);

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} testID="agents-screen">
      <View style={styles.header}>
        <Text style={styles.title}>Agents</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void refresh()}
          testID="agents-refresh"
        >
          <Text style={styles.refresh}>{loading ? '…' : '↻'}</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={styles.error} testID="agents-error">
          {error}
        </Text>
      ) : null}

      {loading && agents.length === 0 ? (
        <View style={styles.empty}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.emptyHint}>Looking up agents…</Text>
        </View>
      ) : null}

      {!loading && agents.length === 0 && !error ? (
        <Text style={styles.emptyHint} testID="agents-empty">
          No agents reachable yet. The desktop will populate this once a gateway is online.
        </Text>
      ) : null}

      <View style={styles.list}>
        {agents.map((agent) => {
          const isActive = agent.id === activeAgent;
          return (
            <Pressable
              key={agent.id}
              accessibilityRole="button"
              style={[styles.row, isActive && styles.rowActive]}
              onPress={() => void switchAgent(agent.id)}
              testID={`agents-row-${agent.id}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>{agent.name}</Text>
                {agent.description ? (
                  <Text style={styles.rowDescription} numberOfLines={2}>
                    {agent.description}
                  </Text>
                ) : null}
              </View>
              <Text style={[styles.rowState, isActive ? styles.rowStateActive : null]}>
                {isActive ? 'Active' : 'Switch'}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  refresh: { color: colors.accent, fontSize: fontSize.lg },
  error: { color: colors.danger, fontSize: fontSize.sm },
  empty: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  emptyHint: { color: colors.muted, fontSize: fontSize.sm },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  rowActive: { borderColor: colors.accent, borderWidth: 1 },
  rowMain: { flex: 1, gap: spacing.xs },
  rowName: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowDescription: { color: colors.muted, fontSize: fontSize.xs },
  rowState: { color: colors.muted, fontSize: fontSize.sm, fontWeight: '600' },
  rowStateActive: { color: colors.accent },
});
