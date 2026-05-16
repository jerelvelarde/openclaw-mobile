// Shape-assertion tests for every v1 Canvas node type. We render each node
// via the same recursive `<CanvasRenderer>` consumers use in production —
// using its "controlled" mode so the test owns the surface + event sink.
//
// The assertions are deliberately structural (testID + accessible label /
// text content) rather than visual snapshots so the suite stays robust to
// styling tweaks that don't change the rendered semantics.

import { fireEvent, render } from '@testing-library/react-native';
import type { CanvasEvent, CanvasSurface } from '@openclaw/protocol';

import { CanvasRenderer } from '../CanvasRenderer';

function surfaceWith(root: CanvasSurface['root']): CanvasSurface {
  return { id: 'surface_1', version: 1, root };
}

function noopEvent(_e: CanvasEvent): void {
  /* discard */
}

describe('Canvas node renderers', () => {
  it('renders a heading node with the expected text', () => {
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'heading', id: 'h', text: 'Hello world', level: 2 }],
    });
    const { getByTestId } = render(<CanvasRenderer surface={surface} onEvent={noopEvent} />);
    expect(getByTestId('canvas-heading-h').props.children).toBe('Hello world');
  });

  it('renders a text node with the expected text', () => {
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'text', id: 't', text: 'A run of text' }],
    });
    const { getByTestId } = render(<CanvasRenderer surface={surface} onEvent={noopEvent} />);
    expect(getByTestId('canvas-text-t').props.children).toBe('A run of text');
  });

  it('renders a button and fires a click event with the action payload', () => {
    const events: CanvasEvent[] = [];
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [
        { type: 'button', id: 'b', label: 'Save', variant: 'primary', action: 'save_form' },
      ],
    });
    const { getByTestId } = render(
      <CanvasRenderer surface={surface} onEvent={(e) => events.push(e)} />,
    );
    const btn = getByTestId('canvas-button-b');
    fireEvent.press(btn);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      surfaceId: 'surface_1',
      nodeId: 'b',
      type: 'click',
      payload: { action: 'save_form' },
    });
  });

  it('renders a button without an action — payload is empty', () => {
    const events: CanvasEvent[] = [];
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'button', id: 'b', label: 'Cancel' }],
    });
    const { getByTestId } = render(
      <CanvasRenderer surface={surface} onEvent={(e) => events.push(e)} />,
    );
    fireEvent.press(getByTestId('canvas-button-b'));
    expect(events[0]?.payload).toEqual({});
  });

  it('renders a text input and fires a change event on blur', () => {
    const events: CanvasEvent[] = [];
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [
        {
          type: 'textInput',
          id: 'i',
          name: 'email',
          value: '',
          placeholder: 'you@example.com',
        },
      ],
    });
    const { getByTestId } = render(
      <CanvasRenderer surface={surface} onEvent={(e) => events.push(e)} />,
    );
    const input = getByTestId('canvas-textInput-i');
    fireEvent.changeText(input, 'a@b.com');
    // Blur immediately to flush the debounced event.
    fireEvent(input, 'blur');
    expect(events).toContainEqual({
      surfaceId: 'surface_1',
      nodeId: 'i',
      type: 'change',
      payload: { name: 'email', value: 'a@b.com' },
    });
  });

  it('renders a select and fires a change event when an option is picked', () => {
    const events: CanvasEvent[] = [];
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [
        {
          type: 'select',
          id: 's',
          name: 'color',
          value: 'r',
          options: [
            { label: 'Red', value: 'r' },
            { label: 'Blue', value: 'b' },
          ],
        },
      ],
    });
    const { getByTestId } = render(
      <CanvasRenderer surface={surface} onEvent={(e) => events.push(e)} />,
    );
    fireEvent.press(getByTestId('canvas-select-s-option-b'));
    expect(events).toEqual([
      {
        surfaceId: 'surface_1',
        nodeId: 's',
        type: 'change',
        payload: { name: 'color', value: 'b' },
      },
    ]);
  });

  it('renders a bulleted list with each item visible', () => {
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'list', id: 'l', items: ['Walk dog', 'Pay rent'] }],
    });
    const { getByTestId } = render(<CanvasRenderer surface={surface} onEvent={noopEvent} />);
    expect(getByTestId('canvas-list-l-item-0')).toBeTruthy();
    expect(getByTestId('canvas-list-l-item-1')).toBeTruthy();
  });

  it('renders a numbered list when ordered=true', () => {
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [{ type: 'list', id: 'l', items: ['One', 'Two'], ordered: true }],
    });
    const { getAllByText } = render(<CanvasRenderer surface={surface} onEvent={noopEvent} />);
    expect(getAllByText('1.')).toHaveLength(1);
    expect(getAllByText('2.')).toHaveLength(1);
  });

  it('renders nested stacks recursively', () => {
    const surface = surfaceWith({
      type: 'stack',
      id: 'root',
      direction: 'vertical',
      children: [
        {
          type: 'stack',
          id: 'inner',
          direction: 'horizontal',
          children: [
            { type: 'text', id: 'a', text: 'A' },
            { type: 'text', id: 'b', text: 'B' },
          ],
        },
      ],
    });
    const { getByTestId } = render(<CanvasRenderer surface={surface} onEvent={noopEvent} />);
    expect(getByTestId('canvas-stack-root')).toBeTruthy();
    expect(getByTestId('canvas-stack-inner')).toBeTruthy();
    expect(getByTestId('canvas-text-a')).toBeTruthy();
    expect(getByTestId('canvas-text-b')).toBeTruthy();
  });
});
