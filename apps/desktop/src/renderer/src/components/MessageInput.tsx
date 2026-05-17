// Controlled textarea for the chat input.
//
// Per P05B step 4:
//   - Enter sends.
//   - Shift+Enter inserts a newline.
//   - Empty / whitespace-only input is ignored.

import { useCallback, useState } from 'react';
import type { KeyboardEvent } from 'react';

interface MessageInputProps {
  onSubmit: (content: string) => void;
  /** Disable the textarea (e.g. while disconnected). */
  disabled?: boolean;
  /** Override the placeholder. */
  placeholder?: string;
}

export function MessageInput({ onSubmit, disabled, placeholder }: MessageInputProps): JSX.Element {
  const [value, setValue] = useState<string>('');

  const submit = useCallback((): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setValue('');
  }, [onSubmit, value]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  return (
    <form
      className="oc-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        className="oc-input-textarea"
        aria-label="Type your message"
        placeholder={placeholder ?? 'Type a message — Enter to send, Shift-Enter for newline'}
        rows={2}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={disabled || value.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
