// Threads list — minimal index that links to the chat surface.
//
// P05A: the gateway-side `threads.list` topic isn't fleshed out yet
// (open question #28), so we render a single "Default thread" entry the
// user can tap to enter the chat surface. Once the desktop returns real
// thread metadata, this screen swaps to that list with a one-line
// change in `GatewayClient.listThreads()`.

import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Thread } from '@openclaw/protocol';

import { usePairing } from '../../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../../src/theme';

/** Default thread shown when the gateway hasn't published any yet. */
const DEFAULT_THREAD: Thread = {
  id: 'thread_default',
  title: 'Default thread',
  agentId: 'openclaw.default',
  updatedAt: Date.now(),
};

export default function ThreadsListScreen() {
  const router = useRouter();
  const { gateway, state } = usePairing();
  const [threads, setThreads] = useState<Thread[]>([DEFAULT_THREAD]);

  // Refresh on focus so a freshly-created thread shows up when the user
  // navigates back from the chat surface.
  useFocusEffect(
    useCallback(() => {
      if (state.status !== 'paired') return;
      let cancelled = false;
      void (async () => {
        try {
          const fetched = await gateway.listThreads();
          if (cancelled) return;
          // Always render at least the default thread so the user has an
          // entry point even when the gateway is empty.
          setThreads(fetched.length > 0 ? fetched : [DEFAULT_THREAD]);
        } catch {
          // Soft-fail — list call may not be implemented yet.
          if (!cancelled) setThreads([DEFAULT_THREAD]);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [gateway, state.status]),
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} testID="threads-list">
      <Text style={styles.title}>Threads</Text>
      <View style={styles.list}>
        {threads.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            style={styles.row}
            onPress={() => router.push(`/(tabs)/threads/${encodeURIComponent(t.id)}`)}
            testID={`thread-row-${t.id}`}
          >
            <Text style={styles.rowTitle}>{t.title}</Text>
            <Text style={styles.rowHint}>{t.agentId}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.md, gap: spacing.md },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  list: { gap: spacing.sm },
  row: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  rowTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  rowHint: { color: colors.muted, fontSize: fontSize.xs },
});
