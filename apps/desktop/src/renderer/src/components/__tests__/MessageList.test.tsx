// Tests for the MessageList renderer.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../hooks/useGateway';
import { MessageList } from '../MessageList';

describe('<MessageList />', () => {
  it('renders an empty-state hint when there are no messages', () => {
    render(<MessageList messages={[]} />);
    expect(screen.getByText(/No messages yet/i)).toBeDefined();
  });

  it('renders user + assistant bubbles in order', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        threadId: 't',
        role: 'user',
        content: 'hi',
        createdAt: 1,
      },
      {
        id: 'm2',
        threadId: 't',
        role: 'assistant',
        content: 'hello there',
        createdAt: 2,
      },
    ];
    const { container } = render(<MessageList messages={messages} />);
    const items = container.querySelectorAll('.oc-message');
    expect(items.length).toBe(2);
    expect(items[0]!.className).toContain('oc-message--user');
    expect(items[1]!.className).toContain('oc-message--assistant');
    expect(items[0]!.textContent).toContain('hi');
    expect(items[1]!.textContent).toContain('hello there');
  });

  it('renders a collapsible tool-call panel below an assistant message', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm1',
        threadId: 't',
        role: 'assistant',
        content: 'done',
        createdAt: 1,
        toolCalls: [
          {
            toolCallId: 'tc1',
            toolName: 'echo.lookup',
            args: { input: 'hi' },
          },
        ],
      },
    ];
    render(<MessageList messages={messages} />);
    // The <details> element should be the tool call, labelled by tool name.
    expect(screen.getByLabelText('tool call: echo.lookup')).toBeDefined();
    // The args panel renders the JSON body.
    expect(screen.getByText(/echo\.lookup/i)).toBeDefined();
  });
});
