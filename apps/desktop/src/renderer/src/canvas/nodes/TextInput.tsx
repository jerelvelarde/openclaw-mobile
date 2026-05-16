// TextInput — renders a `TextInputNode` as a `<input type="text">`.
//
// We dispatch a `change` `CanvasEvent` on blur, debounced 300ms after
// the last keystroke (whichever comes first). That mirrors the mobile
// renderer behaviour (P06A) so payloads round-trip identically.
//
// The local `value` state is seeded from `node.value`; we also re-seed
// when `node.value` changes from the outside (e.g. an agent-driven
// `replaceProps`/`setText` patch arrives). The local edit wins between
// re-seeds — we don't fight the user mid-keystroke.

import { useEffect, useRef, useState } from 'react';
import type { CanvasEvent, TextInputNode } from '@openclaw/protocol';

interface TextInputProps {
  node: TextInputNode;
  onEvent: (event: Omit<CanvasEvent, 'surfaceId'>) => void;
  /** Debounce window for `change` events fired by keystrokes. Defaults to 300ms. */
  debounceMs?: number;
}

export function TextInput({ node, onEvent, debounceMs = 300 }: TextInputProps): JSX.Element {
  const [value, setValue] = useState<string>(node.value ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the upstream value so we can re-seed when it changes from
  // outside, but skip re-seeds caused by our own onEvent → caller →
  // patch echoes (those settle on the same value we already hold).
  const upstreamRef = useRef<string>(node.value ?? '');

  useEffect(() => {
    const next = node.value ?? '';
    if (next !== upstreamRef.current) {
      upstreamRef.current = next;
      setValue(next);
    }
  }, [node.value]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const emitChange = (next: string): void => {
    onEvent({
      nodeId: node.id,
      type: 'change',
      payload: { name: node.name, value: next },
    });
  };

  return (
    <input
      type="text"
      className="oc-canvas-input"
      name={node.name}
      placeholder={node.placeholder}
      value={value}
      onChange={(e): void => {
        const next = e.target.value;
        setValue(next);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          emitChange(next);
        }, debounceMs);
      }}
      onBlur={(): void => {
        if (debounceRef.current) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        emitChange(value);
      }}
    />
  );
}
