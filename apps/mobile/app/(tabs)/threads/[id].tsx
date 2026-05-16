// Thread detail — CopilotKit chat surface.
//
// Renders a minimal RN chat UI that talks directly to the desktop's
// CopilotKit runtime adapter (see `apps/desktop/src/main/copilot/runtime.ts`).
// Each user submit fires `useChatRun.send`, which POSTs a `RunAgentInput`
// and pumps the AG-UI SSE stream into bubbles + a tool-call inspector.
//
// Why a custom RN surface (and not `<CopilotChat>` from
// `@copilotkit/react-native`): see the rationale in
// `src/copilot/runAgent.ts`'s header.
//
// Layout:
//   ┌──────────────────────────────────────────────────────────────┐
//   │ Header: thread title + ActiveAgentPill                        │
//   ├──────────────────────────────────────────────────────────────┤
//   │ FlatList of bubbles. Assistant bubbles also render a          │
//   │ collapsible "tool calls" section below the text when any      │
//   │ tool calls fired during the turn.                             │
//   ├──────────────────────────────────────────────────────────────┤
//   │ Composer: TextInput + Send button                             │
//   └──────────────────────────────────────────────────────────────┘
//
// Streaming-message rendering is driven by `useChatRun.streaming`
// (rendered as a transient bubble below the closed history).

import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useOpenThreadAction, useSwitchAgentAction } from '../../../src/copilot/actions';
import { useOptionalCopilotKit } from '../../../src/copilot/CopilotKitProvider';
import { useStandardReadables } from '../../../src/copilot/readables';
import { useChatRun, type ChatTurn } from '../../../src/copilot/useChatRun';
import { usePairing } from '../../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../../src/theme';

export default function ThreadDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const threadId = params.id ?? 'thread_default';
  const { gateway } = usePairing();
  const copilot = useOptionalCopilotKit();
  // If we land here without a CopilotKit provider, render a degraded
  // message — the user's session is missing a runtime URL and needs to
  // re-pair. Hooks below are no-ops when ctx is null.
  if (!copilot) {
    return (
      <View style={styles.degraded} testID="thread-screen-degraded">
        <Text style={styles.title}>Thread unavailable</Text>
        <Text style={styles.empty}>
          This device is missing a runtime URL. Re-pair from Settings to restore chat.
        </Text>
      </View>
    );
  }
  return (
    <ThreadDetailInner threadId={threadId} gateway={gateway} activeAgent={copilot.activeAgent} />
  );
}

function ThreadDetailInner({
  threadId,
  gateway,
  activeAgent,
}: {
  threadId: string;
  gateway: ReturnType<typeof usePairing>['gateway'];
  activeAgent: string;
}) {
  // Register the readables so the agent has device + thread context.
  useStandardReadables({
    thread: {
      id: threadId,
      title: `Thread ${threadId}`,
      agentId: activeAgent,
      updatedAt: Date.now(),
    },
    agent: { id: activeAgent },
  });
  // Register actions so the agent can call them. Handlers are forward-
  // compat — see `actions.ts` header.
  useSwitchAgentAction(gateway);
  useOpenThreadAction();

  const { messages, streaming, isRunning, error, send } = useChatRun(threadId);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="thread-screen"
    >
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          Thread {threadId}
        </Text>
        <ActiveAgentPill agentId={activeAgent} />
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={messages}
        keyExtractor={(turn) => turn.id}
        renderItem={({ item }) => <Bubble turn={item} />}
        ListFooterComponent={
          <>
            {streaming ? <Bubble turn={streaming} streaming /> : null}
            {error ? (
              <Text style={styles.error} testID="thread-error">
                {error}
              </Text>
            ) : null}
          </>
        }
        ListEmptyComponent={
          streaming ? null : (
            <Text style={styles.empty} testID="thread-empty">
              Say hi to {activeAgent} — type below to start.
            </Text>
          )
        }
      />

      <Composer
        disabled={isRunning}
        onSubmit={(text) => {
          void send(text);
        }}
      />
    </KeyboardAvoidingView>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────

function ActiveAgentPill({ agentId }: { agentId: string }): React.ReactElement {
  return (
    <View
      style={styles.pill}
      accessibilityLabel={`Active agent: ${agentId}`}
      testID="active-agent-pill"
    >
      <Text style={styles.pillLabel}>{agentId}</Text>
    </View>
  );
}

function Bubble({ turn, streaming }: { turn: ChatTurn; streaming?: boolean }): React.ReactElement {
  const isUser = turn.role === 'user';
  return (
    <View
      style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}
      testID={`thread-bubble-${turn.id}`}
    >
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
          streaming ? styles.bubbleStreaming : null,
        ]}
      >
        <Text style={isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant}>
          {turn.text || (streaming ? '…' : '')}
        </Text>
        {turn.toolCalls.length > 0 ? <ToolCallInspector turn={turn} /> : null}
      </View>
    </View>
  );
}

function ToolCallInspector({ turn }: { turn: ChatTurn }): React.ReactElement {
  const [expanded, setExpanded] = useState(true);
  const count = turn.toolCalls.length;
  return (
    <View style={styles.inspector} testID={`tool-call-inspector-${turn.id}`}>
      <Pressable
        accessibilityRole="button"
        style={styles.inspectorToggle}
        onPress={() => setExpanded((v) => !v)}
        testID={`tool-call-toggle-${turn.id}`}
      >
        <Text style={styles.inspectorToggleLabel}>
          {expanded ? '▾' : '▸'} {count} tool call{count === 1 ? '' : 's'}
        </Text>
      </Pressable>
      {expanded
        ? turn.toolCalls.map((call) => (
            <View key={call.id} style={styles.toolCall} testID={`tool-call-${call.id}`}>
              <Text style={styles.toolCallName}>
                {call.name}
                {call.closed ? '' : ' …'}
              </Text>
              {call.args ? (
                <Text style={styles.toolCallArgs} numberOfLines={6} ellipsizeMode="tail">
                  {prettyJson(call.args)}
                </Text>
              ) : null}
            </View>
          ))
        : null}
    </View>
  );
}

function Composer({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
}): React.ReactElement {
  const [value, setValue] = useState('');
  const handleSubmit = (): void => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    onSubmit(text);
  };
  return (
    <View style={styles.composer}>
      <TextInput
        value={value}
        onChangeText={setValue}
        style={styles.composerInput}
        placeholder="Type a message…"
        placeholderTextColor={colors.muted}
        editable={!disabled}
        multiline
        onSubmitEditing={handleSubmit}
        blurOnSubmit
        testID="composer-input"
      />
      <Pressable
        accessibilityRole="button"
        style={[styles.composerSend, disabled ? styles.composerSendDisabled : null]}
        disabled={disabled}
        onPress={handleSubmit}
        testID="composer-send"
      >
        <Text style={styles.composerSendLabel}>{disabled ? '…' : 'Send'}</Text>
      </Pressable>
    </View>
  );
}

/** Try to JSON-pretty-print `raw`; fall back to the literal string. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// Memoized component to avoid re-mounting on every keystroke.
const styles = StyleSheet.create({
  degraded: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.md,
    justifyContent: 'center',
  },
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    borderBottomColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', flex: 1 },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  pillLabel: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '600' },
  list: { flex: 1 },
  listContent: { padding: spacing.md, gap: spacing.sm },
  empty: { color: colors.muted, fontSize: fontSize.sm, padding: spacing.md, textAlign: 'center' },
  error: { color: colors.danger, fontSize: fontSize.sm, padding: spacing.md },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowUser: { justifyContent: 'flex-end' },
  bubbleRowAssistant: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '80%',
    padding: spacing.md,
    borderRadius: radius.md,
    gap: spacing.xs,
  },
  bubbleUser: { backgroundColor: colors.accent },
  bubbleAssistant: { backgroundColor: colors.surface },
  bubbleStreaming: { opacity: 0.85 },
  bubbleTextUser: { color: colors.bg, fontSize: fontSize.md },
  bubbleTextAssistant: { color: colors.text, fontSize: fontSize.md },
  inspector: { marginTop: spacing.sm, gap: spacing.xs },
  inspectorToggle: { paddingVertical: spacing.xs },
  inspectorToggleLabel: { color: colors.muted, fontSize: fontSize.xs, fontWeight: '600' },
  toolCall: {
    backgroundColor: colors.bg,
    borderColor: colors.muted,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  toolCallName: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  toolCallArgs: {
    color: colors.muted,
    fontSize: fontSize.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    gap: spacing.sm,
    borderTopColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    padding: spacing.sm,
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    fontSize: fontSize.md,
  },
  composerSend: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerSendDisabled: { opacity: 0.5 },
  composerSendLabel: { color: colors.bg, fontSize: fontSize.md, fontWeight: '600' },
});
