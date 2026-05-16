// `InMemoryMockGateway` — a `GatewayClient` implementation backed by a plain
// in-process state machine. Used by both apps for dev iteration when the
// real OpenClaw gateway is not running and by tests in both repos.
//
// Constraints (see `.chalk/plans/P01A-protocol-package.md` "Notes"):
// - No network code. Nothing here imports `ws`, `fetch`, or `bonjour`.
// - Behavior is deterministic enough to test: `_approvePairing` is exposed
//   as a test-only hook; the streamed response uses a configurable delay so
//   tests can pass `delayMs: 0`.
// - The mock ships with two fake agents: `openclaw.default` and `hermes`.

import type {
  Agent,
  CanvasPatch,
  CanvasSurface,
  Message,
  MessageInput,
  PairingApproved,
  PairingRequest,
  Thread,
  ThreadEvent,
  Token,
  VoiceOpts,
  VoiceSession,
} from './types';
import type {
  GatewayClient,
  GatewayEvent,
  GatewayEventPayload,
  PairingHandshake,
  Unsubscribe,
} from './client';

/** Tunable knobs for the mock — exposed so tests can run without real timers. */
export interface InMemoryMockGatewayOptions {
  /** Milliseconds between user post and streamed reply. Default: 200. */
  replyDelayMs?: number;
  /**
   * Pairing token TTL, in ms. Default: 1 hour. Long enough that tests don't
   * accidentally see expiry; short enough to remind reviewers tokens expire.
   */
  tokenTtlMs?: number;
}

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'openclaw.default',
    name: 'OpenClaw',
    description: 'Default OpenClaw skill agent.',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    description: 'Hermes Agent (Nous Research) via OpenClaw routing.',
  },
];

let nextId = 0;
function uid(prefix: string): string {
  nextId += 1;
  return `${prefix}_${nextId}_${Math.random().toString(36).slice(2, 8)}`;
}

function sixDigitCode(): string {
  // Deterministic-enough for the mock; we just need a 6-digit string.
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
}

interface PendingPairing {
  code: string;
  expiresAt: number;
  resolve: (value: { token: Token; approved: PairingApproved }) => void;
  reject: (err: Error) => void;
}

export class InMemoryMockGateway implements GatewayClient {
  private readonly replyDelayMs: number;
  private readonly tokenTtlMs: number;

  private agents: Agent[] = [...DEFAULT_AGENTS];
  private activeAgentId: string = DEFAULT_AGENTS[0]!.id;
  private threads: Thread[] = [];
  private messagesByThread = new Map<string, Message[]>();
  private threadListeners = new Map<string, Set<(e: ThreadEvent) => void>>();
  private canvasListeners = new Map<string, Set<(p: CanvasPatch) => void>>();
  private canvasById = new Map<string, CanvasSurface>();
  private eventListeners: {
    [E in GatewayEvent]: Set<(payload: GatewayEventPayload[E]) => void>;
  } = {
    connected: new Set(),
    disconnected: new Set(),
    error: new Set(),
    token_expired: new Set(),
  };

  private pending: PendingPairing | null = null;
  private connected = false;
  private currentToken: Token | null = null;

  constructor(options: InMemoryMockGatewayOptions = {}) {
    this.replyDelayMs = options.replyDelayMs ?? 200;
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60 * 1000;

    // Seed one thread per agent so listThreads() returns something on day one.
    const now = Date.now();
    for (const agent of this.agents) {
      const thread: Thread = {
        id: uid('thread'),
        title: `Conversation with ${agent.name}`,
        agentId: agent.id,
        updatedAt: now,
      };
      this.threads.push(thread);
      this.messagesByThread.set(thread.id, []);
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  async requestPairing(_input: PairingRequest): Promise<PairingHandshake> {
    if (this.pending) {
      // Cancel any previous outstanding request before starting a new one.
      this.pending.reject(new Error('Superseded by new pairing request'));
      this.pending = null;
    }
    const code = sixDigitCode();
    const expiresAt = Date.now() + 5 * 60 * 1000;
    // The actual `resolve/reject` slots get filled by `awaitPaired` below.
    this.pending = {
      code,
      expiresAt,
      resolve: () => {
        /* replaced */
      },
      reject: () => {
        /* replaced */
      },
    };
    return { code, expiresAt };
  }

  awaitPaired(): Promise<{ token: Token; approved: PairingApproved }> {
    if (!this.pending) {
      return Promise.reject(new Error('awaitPaired() called before requestPairing()'));
    }
    return new Promise((resolve, reject) => {
      // Pending is guaranteed non-null by the guard above; re-pin into a local
      // for the closure so TypeScript narrows correctly.
      const p = this.pending!;
      p.resolve = resolve;
      p.reject = reject;
    });
  }

  /**
   * Test-only: simulate the user clicking "Approve" in the desktop UI.
   *
   * Provide the same 6-digit code returned by `requestPairing`. Returns the
   * issued `PairingApproved` envelope so callers can inspect it directly
   * without round-tripping through `awaitPaired`.
   */
  _approvePairing(code: string): PairingApproved {
    if (!this.pending) {
      throw new Error('No pending pairing request');
    }
    if (this.pending.code !== code) {
      throw new Error(`Pairing code mismatch: expected ${this.pending.code}`);
    }
    const token: Token = {
      value: uid('tok'),
      expiresAt: Date.now() + this.tokenTtlMs,
    };
    const approved: PairingApproved = {
      code,
      token,
      runtimeUrl: 'http://127.0.0.1:18789/copilot/runtime',
    };
    const p = this.pending;
    this.pending = null;
    p.resolve({ token, approved });
    return approved;
  }

  // ── Connection ────────────────────────────────────────────────────────────

  async connect(token: string): Promise<void> {
    if (!token) {
      throw new Error('connect() requires a non-empty token');
    }
    this.currentToken = { value: token, expiresAt: Date.now() + this.tokenTtlMs };
    this.connected = true;
    this.emit('connected', { gatewayId: 'mock-gateway' });
  }

  on<E extends GatewayEvent>(
    event: E,
    handler: (payload: GatewayEventPayload[E]) => void,
  ): Unsubscribe {
    const set = this.eventListeners[event] as Set<(payload: GatewayEventPayload[E]) => void>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private emit<E extends GatewayEvent>(event: E, payload: GatewayEventPayload[E]): void {
    const set = this.eventListeners[event] as Set<(payload: GatewayEventPayload[E]) => void>;
    for (const handler of set) {
      handler(payload);
    }
  }

  // ── Agents & routing ──────────────────────────────────────────────────────

  async listAgents(): Promise<Agent[]> {
    this.assertConnected();
    return [...this.agents];
  }

  async setActiveAgent(agentId: string): Promise<void> {
    this.assertConnected();
    const found = this.agents.find((a) => a.id === agentId);
    if (!found) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    this.activeAgentId = agentId;
  }

  /** Test helper: read the currently active agent id. */
  _getActiveAgent(): string {
    return this.activeAgentId;
  }

  // ── Threads / messages ────────────────────────────────────────────────────

  async listThreads(): Promise<Thread[]> {
    this.assertConnected();
    return [...this.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async postMessage(threadId: string, input: MessageInput): Promise<void> {
    this.assertConnected();
    const messages = this.messagesByThread.get(threadId);
    if (!messages) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    const userMessage: Message = {
      id: uid('msg'),
      threadId,
      role: 'user',
      content: input.content,
      createdAt: Date.now(),
    };
    messages.push(userMessage);
    this.broadcastThreadEvent(threadId, { type: 'message', message: userMessage });

    // Schedule a fake assistant reply. We don't await it from `postMessage` so
    // the caller sees the same semantics as a real WS: the reply arrives via
    // the stream subscription, not as a return value.
    const assistantId = uid('msg');
    const fire = () => {
      const assistantMessage: Message = {
        id: assistantId,
        threadId,
        role: 'assistant',
        content: `Echo: ${input.content}`,
        createdAt: Date.now(),
      };
      messages.push(assistantMessage);
      this.broadcastThreadEvent(threadId, {
        type: 'message',
        message: assistantMessage,
      });
      this.broadcastThreadEvent(threadId, {
        type: 'token',
        messageId: assistantId,
        delta: assistantMessage.content,
      });
      this.broadcastThreadEvent(threadId, {
        type: 'tool_call',
        messageId: assistantId,
        toolName: 'echo.lookup',
        args: { input: input.content },
      });
      this.broadcastThreadEvent(threadId, { type: 'done', messageId: assistantId });
    };

    if (this.replyDelayMs <= 0) {
      // Run on a microtask so subscribers attached *after* `await postMessage`
      // still receive the events. (Real WS replies always come in a turn or
      // two later, never synchronously.)
      queueMicrotask(fire);
    } else {
      setTimeout(fire, this.replyDelayMs);
    }
  }

  streamThread(threadId: string, onEvent: (e: ThreadEvent) => void): Unsubscribe {
    let set = this.threadListeners.get(threadId);
    if (!set) {
      set = new Set();
      this.threadListeners.set(threadId, set);
    }
    set.add(onEvent);
    return () => {
      set!.delete(onEvent);
    };
  }

  private broadcastThreadEvent(threadId: string, event: ThreadEvent): void {
    const set = this.threadListeners.get(threadId);
    if (!set) return;
    for (const handler of set) {
      handler(event);
    }
  }

  // ── Canvas ────────────────────────────────────────────────────────────────

  async getCanvas(surfaceId: string): Promise<CanvasSurface> {
    this.assertConnected();
    const existing = this.canvasById.get(surfaceId);
    if (existing) return existing;
    const surface: CanvasSurface = {
      id: surfaceId,
      title: `Mock surface ${surfaceId}`,
      content: { kind: 'empty' },
      updatedAt: Date.now(),
    };
    this.canvasById.set(surfaceId, surface);
    return surface;
  }

  onCanvasUpdate(surfaceId: string, handler: (patch: CanvasPatch) => void): Unsubscribe {
    let set = this.canvasListeners.get(surfaceId);
    if (!set) {
      set = new Set();
      this.canvasListeners.set(surfaceId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /** Test helper: synthesize a canvas patch to feed subscribers. */
  _emitCanvasPatch(patch: CanvasPatch): void {
    const set = this.canvasListeners.get(patch.surfaceId);
    if (!set) return;
    for (const handler of set) {
      handler(patch);
    }
  }

  // ── Voice ─────────────────────────────────────────────────────────────────

  async openVoice(opts: VoiceOpts): Promise<VoiceSession> {
    this.assertConnected();
    const id = uid('voice');
    return {
      id,
      mode: opts.mode,
      close: async () => {
        /* no-op in mock */
      },
    };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private assertConnected(): void {
    if (!this.connected || !this.currentToken) {
      throw new Error('GatewayClient.connect() must succeed before this call');
    }
  }
}
