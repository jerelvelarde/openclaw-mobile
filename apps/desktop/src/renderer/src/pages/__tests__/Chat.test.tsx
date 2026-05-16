// Smoke test for the Chat page.
//
// Without a real WebSocket the gateway hook resolves to status:'closed'
// (since `window.api` is missing in jsdom). We assert the page still
// mounts and renders the header + empty-state hint.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Chat } from '../Chat';

describe('<Chat />', () => {
  it('renders the chat surface with no-bridge fallback', () => {
    render(<Chat />);
    expect(screen.getByLabelText('chat')).toBeDefined();
    expect(screen.getByLabelText('active agent')).toBeDefined();
    expect(screen.getByText(/No messages yet/i)).toBeDefined();
  });
});
