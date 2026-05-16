// Per-node renderer tests.
//
// Each test mounts the smallest possible tree (the node component
// directly, or a `CanvasRenderer` over a single-node surface) and
// asserts on the DOM output. We deliberately don't go through the
// gateway here — those tests live in `useCanvas.test.tsx`.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasEvent } from '@openclaw/protocol';
import { Button } from '../nodes/Button';
import { Heading } from '../nodes/Heading';
import { List } from '../nodes/List';
import { Select } from '../nodes/Select';
import { Stack } from '../nodes/Stack';
import { Text } from '../nodes/Text';
import { TextInput } from '../nodes/TextInput';

describe('canvas nodes', () => {
  describe('<Heading />', () => {
    it('renders an h1 by default', () => {
      const { container } = render(<Heading node={{ type: 'heading', id: 'h', text: 'Hello' }} />);
      const h1 = container.querySelector('h1');
      expect(h1?.textContent).toBe('Hello');
    });

    it('renders the correct heading level when supplied', () => {
      const { container } = render(
        <Heading node={{ type: 'heading', id: 'h', text: 'L3', level: 3 }} />,
      );
      expect(container.querySelector('h3')?.textContent).toBe('L3');
    });
  });

  describe('<Text />', () => {
    it('renders text inside a <p>', () => {
      const { container } = render(<Text node={{ type: 'text', id: 't', text: 'body' }} />);
      expect(container.querySelector('p')?.textContent).toBe('body');
    });
  });

  describe('<Button />', () => {
    it('renders the label as a button', () => {
      const onEvent = vi.fn();
      render(
        <Button
          node={{ type: 'button', id: 'b', label: 'Save', action: 'save_form' }}
          onEvent={onEvent}
        />,
      );
      expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    });

    it('dispatches a click CanvasEvent with the echoed action', () => {
      const onEvent = vi.fn();
      render(
        <Button
          node={{ type: 'button', id: 'b', label: 'Save', action: 'save_form' }}
          onEvent={onEvent}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(onEvent).toHaveBeenCalledTimes(1);
      const call = onEvent.mock.calls[0]![0] as Omit<CanvasEvent, 'surfaceId'>;
      expect(call.type).toBe('click');
      expect(call.nodeId).toBe('b');
      expect(call.payload).toEqual({ action: 'save_form' });
    });

    it('omits action from the payload when the node has none', () => {
      const onEvent = vi.fn();
      render(<Button node={{ type: 'button', id: 'b', label: 'Go' }} onEvent={onEvent} />);
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      const call = onEvent.mock.calls[0]![0] as Omit<CanvasEvent, 'surfaceId'>;
      expect(call.payload).toEqual({});
    });
  });

  describe('<TextInput />', () => {
    it('renders an input with the current value', () => {
      const onEvent = vi.fn();
      render(
        <TextInput
          node={{ type: 'textInput', id: 'i', name: 'email', value: 'a@b.com' }}
          onEvent={onEvent}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLInputElement;
      expect(input.value).toBe('a@b.com');
    });

    it('fires a debounced change after keystrokes', () => {
      vi.useFakeTimers();
      try {
        const onEvent = vi.fn();
        render(
          <TextInput
            node={{ type: 'textInput', id: 'i', name: 'email', value: '' }}
            onEvent={onEvent}
            debounceMs={100}
          />,
        );
        const input = screen.getByRole('textbox') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'hi' } });
        // Not yet — debounce hasn't elapsed.
        expect(onEvent).not.toHaveBeenCalled();
        vi.advanceTimersByTime(150);
        expect(onEvent).toHaveBeenCalledTimes(1);
        const call = onEvent.mock.calls[0]![0] as Omit<CanvasEvent, 'surfaceId'>;
        expect(call.type).toBe('change');
        expect(call.payload).toEqual({ name: 'email', value: 'hi' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes pending change on blur and emits with the current value', () => {
      const onEvent = vi.fn();
      render(
        <TextInput
          node={{ type: 'textInput', id: 'i', name: 'email', value: '' }}
          onEvent={onEvent}
          debounceMs={500}
        />,
      );
      const input = screen.getByRole('textbox') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'x@y.z' } });
      fireEvent.blur(input);
      expect(onEvent).toHaveBeenCalledTimes(1);
      const call = onEvent.mock.calls[0]![0] as Omit<CanvasEvent, 'surfaceId'>;
      expect(call.payload).toEqual({ name: 'email', value: 'x@y.z' });
    });
  });

  describe('<Select />', () => {
    it('renders the options and current value', () => {
      const onEvent = vi.fn();
      const { container } = render(
        <Select
          node={{
            type: 'select',
            id: 's',
            name: 'color',
            options: [
              { label: 'Red', value: 'r' },
              { label: 'Blue', value: 'b' },
            ],
            value: 'b',
          }}
          onEvent={onEvent}
        />,
      );
      const sel = container.querySelector('select')!;
      expect(sel.value).toBe('b');
      expect(sel.querySelectorAll('option').length).toBe(2);
    });

    it('emits a change event when selection flips', () => {
      const onEvent = vi.fn();
      const { container } = render(
        <Select
          node={{
            type: 'select',
            id: 's',
            name: 'color',
            options: [
              { label: 'Red', value: 'r' },
              { label: 'Blue', value: 'b' },
            ],
            value: 'r',
          }}
          onEvent={onEvent}
        />,
      );
      const sel = container.querySelector('select')!;
      fireEvent.change(sel, { target: { value: 'b' } });
      expect(onEvent).toHaveBeenCalledTimes(1);
      const call = onEvent.mock.calls[0]![0] as Omit<CanvasEvent, 'surfaceId'>;
      expect(call.payload).toEqual({ name: 'color', value: 'b' });
    });
  });

  describe('<List />', () => {
    it('renders an unordered list by default', () => {
      const { container } = render(
        <List node={{ type: 'list', id: 'l', items: ['a', 'b', 'c'] }} />,
      );
      expect(container.querySelector('ul')).toBeTruthy();
      expect(container.querySelectorAll('li').length).toBe(3);
    });

    it('renders an ordered list when `ordered`', () => {
      const { container } = render(
        <List node={{ type: 'list', id: 'l', items: ['a', 'b'], ordered: true }} />,
      );
      expect(container.querySelector('ol')).toBeTruthy();
    });
  });

  describe('<Stack />', () => {
    it('renders children via the provided renderer', () => {
      const { container } = render(
        <Stack
          node={{
            type: 'stack',
            id: 's',
            direction: 'vertical',
            children: [
              { type: 'text', id: 't1', text: 'one' },
              { type: 'text', id: 't2', text: 'two' },
            ],
          }}
          renderChild={(child) => <span key={child.id}>{(child as { text: string }).text}</span>}
        />,
      );
      expect(container.querySelector('[data-direction="vertical"]')).toBeTruthy();
      expect(container.textContent).toContain('one');
      expect(container.textContent).toContain('two');
    });

    it('uses the horizontal flex direction when configured', () => {
      const { container } = render(
        <Stack
          node={{
            type: 'stack',
            id: 's',
            direction: 'horizontal',
            children: [],
          }}
          renderChild={() => <span />}
        />,
      );
      expect(container.querySelector('[data-direction="horizontal"]')).toBeTruthy();
    });
  });
});
