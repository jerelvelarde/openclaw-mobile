// Tests for the ToolCallView collapsible inspector.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ToolCallView } from '../ToolCallView';

describe('<ToolCallView />', () => {
  it('renders the tool name and JSON args when forced open', () => {
    render(
      <ToolCallView
        defaultOpen
        toolCall={{
          toolCallId: 'tc-1',
          toolName: 'lookup.url',
          args: { url: 'https://example.com', verb: 'GET' },
        }}
      />,
    );
    expect(screen.getByText('lookup.url')).toBeDefined();
    expect(screen.getByText(/example\.com/)).toBeDefined();
  });

  it('renders a result panel when result is present', () => {
    render(
      <ToolCallView
        defaultOpen
        toolCall={{
          toolCallId: 'tc-1',
          toolName: 'lookup.url',
          args: {},
          result: { status: 200, body: 'ok' },
        }}
      />,
    );
    expect(screen.getByText(/result/)).toBeDefined();
    expect(screen.getByText(/status/)).toBeDefined();
  });
});
