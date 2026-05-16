import { describe, expect, it } from 'vitest';

import {
  decode,
  encode,
  envelopeSchema,
  InMemoryMockGateway,
  MessageSchema,
  ThreadEventSchema,
  type ThreadEvent,
} from '../index';

function makeGateway() {
  // 0ms reply lets tests await deterministically via microtasks/timers without
  // burning real wall time.
  return new InMemoryMockGateway({ replyDelayMs: 0 });
}

async function pairAndConnect(gateway: InMemoryMockGateway): Promise<string> {
  const handshake = await gateway.requestPairing({ deviceName: 'Test Phone' });
  const paired = gateway.awaitPaired();
  gateway._approvePairing(handshake.code);
  const { token } = await paired;
  await gateway.connect(token.value);
  return token.value;
}

describe('InMemoryMockGateway', () => {
  it('completes the pairing handshake and resolves awaitPaired with a token', async () => {
    const gateway = makeGateway();

    const handshake = await gateway.requestPairing({ deviceName: 'Test Phone' });
    expect(handshake.code).toMatch(/^\d{6}$/);
    expect(handshake.expiresAt).toBeGreaterThan(Date.now());

    const pairedPromise = gateway.awaitPaired();
    const approved = gateway._approvePairing(handshake.code);
    expect(approved.code).toBe(handshake.code);

    const { token } = await pairedPromise;
    expect(token.value).toMatch(/^tok_/);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it('listAgents returns both default agents once connected', async () => {
    const gateway = makeGateway();
    await pairAndConnect(gateway);

    const agents = await gateway.listAgents();
    const ids = agents.map((a) => a.id).sort();
    expect(ids).toEqual(['hermes', 'openclaw.default']);
  });

  it('setActiveAgent switches the active route', async () => {
    const gateway = makeGateway();
    await pairAndConnect(gateway);

    expect(gateway._getActiveAgent()).toBe('openclaw.default');
    await gateway.setActiveAgent('hermes');
    expect(gateway._getActiveAgent()).toBe('hermes');

    await expect(gateway.setActiveAgent('nope')).rejects.toThrow(/Unknown agent/);
  });

  it('postMessage triggers a streamed reply with at least one tool_call event', async () => {
    const gateway = makeGateway();
    await pairAndConnect(gateway);
    const [thread] = await gateway.listThreads();
    expect(thread).toBeDefined();

    const events: ThreadEvent[] = [];
    const collected = new Promise<void>((resolve) => {
      const unsub = gateway.streamThread(thread!.id, (e) => {
        events.push(e);
        if (e.type === 'done') {
          unsub();
          resolve();
        }
      });
    });

    await gateway.postMessage(thread!.id, { content: 'ping' });
    await collected;

    const types = events.map((e) => e.type);
    expect(types).toContain('message');
    expect(types).toContain('tool_call');
    expect(types).toContain('done');

    const toolCall = events.find((e) => e.type === 'tool_call');
    // Discriminated-union narrow: TS knows toolCall is the tool_call variant.
    if (toolCall?.type !== 'tool_call') throw new Error('expected tool_call event');
    expect(toolCall.toolName).toBe('echo.lookup');
    expect(toolCall.args).toEqual({ input: 'ping' });

    // Every emitted event must satisfy the published schema.
    for (const event of events) {
      expect(() => ThreadEventSchema.parse(event)).not.toThrow();
    }
  });

  it('decode() rejects malformed envelope payloads', () => {
    // A valid envelope wrapping a Message round-trips.
    const valid = {
      id: 'frame_1',
      topic: 'threads.message',
      type: 'thread.message',
      payload: {
        id: 'msg_1',
        threadId: 'thread_1',
        role: 'assistant' as const,
        content: 'hi',
        createdAt: Date.now(),
      },
      ts: Date.now(),
    };
    const wire = encode(valid);
    const decoded = decode(wire, MessageSchema);
    expect(decoded.payload.content).toBe('hi');

    // Wrong payload shape — `role: "wizard"` is not a valid MessageRole.
    const invalidPayload = JSON.stringify({
      ...valid,
      payload: { ...valid.payload, role: 'wizard' },
    });
    expect(() => decode(invalidPayload, MessageSchema)).toThrow();

    // Missing required envelope field (`topic`).
    const missingTopic = JSON.stringify({
      id: 'frame_2',
      type: 'thread.message',
      payload: valid.payload,
      ts: Date.now(),
    });
    expect(() => decode(missingTopic, MessageSchema)).toThrow();

    // Whole-envelope schema also rejects garbage.
    expect(() => envelopeSchema(MessageSchema).parse({})).toThrow();
  });

  it('requires connect() before agent or thread calls', async () => {
    const gateway = makeGateway();
    await expect(gateway.listAgents()).rejects.toThrow(/connect/);
    await expect(gateway.listThreads()).rejects.toThrow(/connect/);
  });
});
