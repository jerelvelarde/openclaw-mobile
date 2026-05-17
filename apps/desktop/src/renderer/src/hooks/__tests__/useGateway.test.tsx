// Tests for the renderer's useGateway hook.
//
// We mount the hook inside a tiny test component and drive a fake
// WebSocket through its event listeners. The wire format is the same
// envelope shape the WS server emits in production (see
// `apps/desktop/src/main/transport/wsServer.ts`'s `encode(frame)`
// callsite).

import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Agent } from '@openclaw/protocol';
import { useGateway, type GatewayHandle } from '../useGateway';

type Listener = (event: unknown) => void;

/**
 * Minimal `WebSocket`-shaped stub the hook can pass to its event
 * subscriptions. Only implements `addEventListener` + `send` + `close`
 * — that's all the hook touches.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;

  readyState: number = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Listener[]> = {};

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(event: string, cb: Listener): void {
    (this.listeners[event] ??= []).push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire('close', { code: 1000 });
  }

  // Test helpers ---------------------------------------------------------
  fire(event: string, payload: unknown): void {
    const list = this.listeners[event] ?? [];
    for (const cb of list) cb(payload);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire('open', {});
  }

  emit(frame: unknown): void {
    this.fire('message', { data: JSON.stringify(frame) });
  }
}

function makeFakeWebSocketClass(): typeof WebSocket {
  // Cast through unknown — FakeWebSocket only covers the API the hook
  // touches, not the full DOM type.
  return FakeWebSocket as unknown as typeof WebSocket;
}

function Harness({ onHandle }: { onHandle: (h: GatewayHandle) => void }): JSX.Element {
  const handle = useGateway({
    WebSocketCtor: makeFakeWebSocketClass(),
    getSelfToken: async () => ({ token: 'fake-token', ws_url: 'ws://127.0.0.1:18789/ws' }),
    computeBackoffMs: () => 5,
  });
  // Push the latest handle out to the test on every render.
  onHandle(handle);
  return (
    <div>
      <span data-testid="status">{handle.status}</span>
      <span data-testid="agent-count">{handle.agents.length}</span>
      <span data-testid="message-count">{handle.messages.length}</span>
    </div>
  );
}

async function flushMicrotasks(): Promise<void> {
  // Two waits — the hook chains a then() after the IPC await, so a
  // single microtask flush isn't enough.
  await Promise.resolve();
  await Promise.resolve();
}

describe('useGateway', () => {
  it('connects, receives agents, and exposes them in state', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toContain('token=fake-token');

    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });
    expect(captured!.status).toBe('open');

    // After open we should have asked for the agents list.
    expect(ws.sent).toHaveLength(1);
    const outbound = JSON.parse(ws.sent[0]!);
    expect(outbound.type).toBe('agents.list');

    const agents: Agent[] = [
      { id: 'openclaw.default', name: 'OpenClaw' },
      { id: 'hermes', name: 'Hermes' },
    ];
    await act(async () => {
      ws.emit({
        id: outbound.id,
        topic: 'agents',
        type: 'agents.list.response',
        payload: { agents },
        ts: Date.now(),
      });
      await flushMicrotasks();
    });
    expect(captured!.agents).toEqual(agents);
    expect(captured!.activeAgent).toBe('openclaw.default');
  });

  it('appends streamed assistant tokens into a single message', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });

    // Post a user message.
    await act(async () => {
      captured!.postMessage('hi');
      await flushMicrotasks();
    });
    expect(captured!.messages).toHaveLength(1);
    expect(captured!.messages[0]!.role).toBe('user');
    expect(captured!.messages[0]!.content).toBe('hi');

    // The hook sent agents.list (1) + threads.post (2).
    expect(ws.sent).toHaveLength(2);
    const post = JSON.parse(ws.sent[1]!);
    expect(post.type).toBe('threads.post');
    expect(post.payload.content).toBe('hi');

    // Simulate the stub gateway: ack the user message, open assistant,
    // stream tokens, fire a tool call, then done.
    const userMessage = {
      id: 'msg_user_1',
      threadId: 'thread_default',
      role: 'user' as const,
      content: 'hi',
      createdAt: Date.now(),
    };
    const assistantMessage = {
      id: 'msg_assistant_1',
      threadId: 'thread_default',
      role: 'assistant' as const,
      content: '',
      createdAt: Date.now(),
    };
    await act(async () => {
      ws.emit({
        id: 'srv-1',
        topic: 'threads',
        type: 'threads.event',
        payload: { type: 'message', message: userMessage },
        ts: Date.now(),
      });
      ws.emit({
        id: 'srv-2',
        topic: 'threads',
        type: 'threads.event',
        payload: { type: 'message', message: assistantMessage },
        ts: Date.now(),
      });
      ws.emit({
        id: 'srv-3',
        topic: 'threads',
        type: 'threads.event',
        payload: {
          type: 'token',
          messageId: 'msg_assistant_1',
          delta: 'Hello',
        },
        ts: Date.now(),
      });
      ws.emit({
        id: 'srv-4',
        topic: 'threads',
        type: 'threads.event',
        payload: {
          type: 'token',
          messageId: 'msg_assistant_1',
          delta: ' world',
        },
        ts: Date.now(),
      });
      ws.emit({
        id: 'srv-5',
        topic: 'threads',
        type: 'threads.event',
        payload: {
          type: 'tool_call',
          messageId: 'msg_assistant_1',
          toolName: 'echo.lookup',
          args: { input: 'hi' },
        },
        ts: Date.now(),
      });
      ws.emit({
        id: 'srv-6',
        topic: 'threads',
        type: 'threads.event',
        payload: { type: 'done', messageId: 'msg_assistant_1' },
        ts: Date.now(),
      });
      await flushMicrotasks();
    });

    // We end up with: optimistic user, gateway user echo, assistant.
    const assistant = captured!.messages.find((m) => m.id === 'msg_assistant_1');
    expect(assistant?.content).toBe('Hello world');
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.toolCalls?.[0]?.toolName).toBe('echo.lookup');
    expect(assistant?.toolCalls?.[0]?.args).toEqual({ input: 'hi' });
  });

  it('falls back to closed when there is no self-token', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    function NoTokenHarness(): JSX.Element {
      const h = useGateway({
        WebSocketCtor: makeFakeWebSocketClass(),
        getSelfToken: async () => null,
      });
      captured = h;
      return <span data-testid="status">{h.status}</span>;
    }
    render(<NoTokenHarness />);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(captured!.status).toBe('closed');
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('caches canvas.surface pushes and exposes them via canvas.peekCanvas', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });

    const surface = {
      id: 'surface_demo',
      version: 1 as const,
      root: { type: 'text' as const, id: 't', text: 'Hello' },
    };
    await act(async () => {
      ws.emit({
        id: 'srv-canvas-1',
        topic: 'canvas.demo.surface',
        type: 'canvas.surface',
        payload: surface,
        ts: Date.now(),
      });
      await flushMicrotasks();
    });
    expect(captured!.canvas.peekCanvas('surface_demo')).toEqual(surface);
    // A canvas placeholder message lands in the conversation.
    const canvasMessage = captured!.messages.find((m) => m.surfaceId === 'surface_demo');
    expect(canvasMessage).toBeDefined();
  });

  it('routes canvas.patch frames to onCanvasUpdate subscribers', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });

    const received: unknown[] = [];
    const off = captured!.canvas.onCanvasUpdate('surface_demo', (p) => received.push(p));

    const patch = {
      surfaceId: 'surface_demo',
      ts: 42,
      ops: [{ op: 'setText', id: 't', text: 'Updated' }],
    };
    await act(async () => {
      ws.emit({
        id: 'srv-patch-1',
        topic: 'canvas.demo.patch',
        type: 'canvas.patch',
        payload: patch,
        ts: Date.now(),
      });
      await flushMicrotasks();
    });
    expect(received).toEqual([patch]);
    off();
  });

  it('dispatchCanvasEvent sends a canvas.event frame', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });

    // First send is agents.list — clear and assert on next send.
    ws.sent.length = 0;
    captured!.canvas.dispatchCanvasEvent({
      surfaceId: 'surface_demo',
      nodeId: 'btn',
      type: 'click',
      payload: { action: 'save' },
    });
    expect(ws.sent).toHaveLength(1);
    const outbound = JSON.parse(ws.sent[0]!);
    expect(outbound.type).toBe('canvas.event');
    expect(outbound.topic).toBe('canvas.surface_demo.event');
    expect(outbound.payload).toEqual({
      surfaceId: 'surface_demo',
      nodeId: 'btn',
      type: 'click',
      payload: { action: 'save' },
    });
  });

  it('getCanvas resolves with a previously-cached surface synchronously', async () => {
    FakeWebSocket.instances = [];
    let captured: GatewayHandle | null = null;
    render(<Harness onHandle={(h) => (captured = h)} />);
    await act(async () => {
      await flushMicrotasks();
    });
    const ws = FakeWebSocket.instances[0]!;
    await act(async () => {
      ws.open();
      await flushMicrotasks();
    });

    const surface = {
      id: 'surface_demo',
      version: 1 as const,
      root: { type: 'text' as const, id: 't', text: 'Hi' },
    };
    await act(async () => {
      ws.emit({
        id: 'srv-canvas-1',
        topic: 'canvas.demo.surface',
        type: 'canvas.surface',
        payload: surface,
        ts: Date.now(),
      });
      await flushMicrotasks();
    });
    const got = await captured!.canvas.getCanvas('surface_demo');
    expect(got).toEqual(surface);
  });
});
