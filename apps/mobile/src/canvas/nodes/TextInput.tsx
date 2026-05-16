// Canvas `textInput` node. Single-line input. Emits `change` events as the
// user types — debounced 300ms so we don't flood the gateway on every
// keystroke. Also emits `change` on blur (immediate, in case the debounce
// timer is still pending). v1 doesn't expose `submit` triggers in the
// schema (no submit-on-enter affordance); the agent can paint a sibling
// `button` if it wants form-submit semantics.

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';

import type { TextInputNode } from '@openclaw/protocol';

import { colors, fontSize, radius, spacing } from '../../theme';
import { useCanvasContext } from '../CanvasContext';

/** Debounce window for `change` events on typing. */
const CHANGE_DEBOUNCE_MS = 300;

export function TextInputNodeView({ node }: { node: TextInputNode }): React.ReactElement {
  const { dispatchEvent } = useCanvasContext();
  // Local state mirrors the node's `value` so the cursor doesn't jump every
  // time the parent re-renders. We re-sync when the surface patches the
  // value (a `setText` op fires `node.value` to change).
  const [value, setValue] = useState<string>(node.value ?? '');
  // Keep the last value seen from the prop so we can detect external updates.
  const lastNodeValueRef = useRef<string>(node.value ?? '');
  // The debounce timer; cleared on every keystroke + on unmount.
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External (patch-driven) value changes win over local edits.
  useEffect(() => {
    const next = node.value ?? '';
    if (next !== lastNodeValueRef.current) {
      lastNodeValueRef.current = next;
      setValue(next);
    }
  }, [node.value]);

  // Clear any pending timer on unmount so we don't fire into a stale closure.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, []);

  const fireChange = (latest: string): void => {
    dispatchEvent(node.id, 'change', { name: node.name, value: latest });
  };

  const onChangeText = (next: string): void => {
    setValue(next);
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      fireChange(next);
    }, CHANGE_DEBOUNCE_MS);
  };

  const onBlur = (): void => {
    // Flush any pending debounced event immediately so the agent sees the
    // committed value the instant the user navigates away.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    fireChange(value);
  };

  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      placeholder={node.placeholder}
      placeholderTextColor={colors.muted}
      style={styles.input}
      testID={`canvas-textInput-${node.id}`}
      accessibilityLabel={node.name}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    color: colors.text,
    borderRadius: radius.md,
    fontSize: fontSize.md,
  },
});
