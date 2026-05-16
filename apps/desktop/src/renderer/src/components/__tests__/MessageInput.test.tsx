// Tests for the MessageInput textarea.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageInput } from '../MessageInput';

describe('<MessageInput />', () => {
  it('calls onSubmit on Enter and clears the value', () => {
    const onSubmit = vi.fn();
    render(<MessageInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(textarea.value).toBe('');
  });

  it('inserts a newline on Shift+Enter and does NOT submit', () => {
    const onSubmit = vi.fn();
    render(<MessageInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'line one' } });
    // Don't preventDefault on shift+enter — the browser will add the newline naturally.
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores whitespace-only input', () => {
    const onSubmit = vi.fn();
    render(<MessageInput onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '   \n  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the button when disabled prop is set', () => {
    render(<MessageInput onSubmit={vi.fn()} disabled />);
    const button = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(button.disabled).toBe(true);
    expect(textarea.disabled).toBe(true);
  });
});
