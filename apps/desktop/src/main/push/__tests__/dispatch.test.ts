// Push dispatcher tests.
//
// We drive a real `Router` (cheap, in-process) but stub the push client
// + the device registry so we can assert on the payloads the dispatcher
// hands out. No network, no Expo SDK.

import { describe, expect, it } from 'vitest';
import type { ThreadEvent } from '@openclaw/protocol';
import { createRouter } from '../../transport/router';
import { attachPushDispatcher } from '../dispatch';
import type { PushDeviceRegistry, PushTarget } from '../devices';
import type { PushClient, PushNotification, PushSendResult } from '../expoClient';

interface FakePushClient extends PushClient {
  sent: PushNotification[][];
}

function fakePushClient(opts?: { throwOnSend?: boolean }): FakePushClient {
  const sent: PushNotification[][] = [];
  const client: PushClient = {
    async sendNotification(notif): Promise<PushSendResult> {
      sent.push([notif]);
      return { tickets: [{ status: 'ok', id: 'tk' }] };
    },
    async sendNotifications(notifs): Promise<PushSendResult> {
      if (opts?.throwOnSend) throw new Error('explode');
      sent.push(notifs);
      return { tickets: notifs.map((_, i) => ({ status: 'ok', id: `tk-${i}` })) };
    },
    isExpoPushToken(token): token is string {
      return typeof token === 'string';
    },
  };
  return Object.assign(client, { sent });
}

function fakeRegistry(targets: PushTarget[]): PushDeviceRegistry {
  return {
    setPushToken: () => true,
    clearPushToken: () => true,
    listPushTargets: () => targets,
  };
}

const ONE_TARGET: PushTarget[] = [
  {
    deviceId: 'dev-a',
    deviceName: 'Phone A',
    pushToken: 'ExponentPushToken[abc]',
    pushPlatform: 'ios',
  },
];

async function flush(): Promise<void> {
  // Two microtask drains: dispatch.notify is async and the router fires
  // handlers synchronously, so a single `await Promise.resolve()` is
  // usually enough — we add a second for any fakePushClient async path.
  await Promise.resolve();
  await Promise.resolve();
}

describe('push dispatcher', () => {
  it('translates an assistant `threads.event` into the expected Expo payload', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const registry = fakeRegistry(ONE_TARGET);
    const dispatcher = attachPushDispatcher({
      router,
      registry,
      pushClient,
      resolveAgentName: () => 'OpenClaw',
    });

    const event: ThreadEvent = {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'Echo: hello',
        createdAt: 0,
      },
    };
    router.publish('threads.event', 'threads.event', event);
    await flush();

    expect(pushClient.sent).toHaveLength(1);
    const batch = pushClient.sent[0]!;
    expect(batch).toHaveLength(1);
    expect(batch[0]).toEqual({
      token: 'ExponentPushToken[abc]',
      title: 'OpenClaw',
      body: 'Echo: hello',
      data: { threadId: 't1', kind: 'assistant_message' },
    });

    dispatcher.detach();
  });

  it('skips user-role messages', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
    });

    const event: ThreadEvent = {
      type: 'message',
      message: {
        id: 'm0',
        threadId: 't1',
        role: 'user',
        content: 'hi',
        createdAt: 0,
      },
    };
    router.publish('threads.event', 'threads.event', event);
    await flush();
    expect(pushClient.sent).toEqual([]);
    dispatcher.detach();
  });

  it('skips when no devices have push tokens registered', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry([]),
      pushClient,
    });

    const event: ThreadEvent = {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'Hello',
        createdAt: 0,
      },
    };
    router.publish('threads.event', 'threads.event', event);
    await flush();
    expect(pushClient.sent).toEqual([]);
    dispatcher.detach();
  });

  it('throttles bursts: a second message in the same thread within the window is dropped', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const clock = { now: 1_000 };
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
      now: () => clock.now,
      throttleWindowMs: 30_000,
    });

    const make = (content: string): ThreadEvent => ({
      type: 'message',
      message: {
        id: `m-${content}`,
        threadId: 't1',
        role: 'assistant',
        content,
        createdAt: clock.now,
      },
    });

    router.publish('threads.event', 'threads.event', make('first'));
    await flush();
    // Inside the window — should be dropped.
    clock.now += 5_000;
    router.publish('threads.event', 'threads.event', make('second'));
    await flush();
    // Still inside — also dropped.
    clock.now += 20_000;
    router.publish('threads.event', 'threads.event', make('third'));
    await flush();
    // Now past the 30s window — fires again.
    clock.now += 10_000;
    router.publish('threads.event', 'threads.event', make('fourth'));
    await flush();

    expect(pushClient.sent.map((b) => b[0]!.body)).toEqual(['first', 'fourth']);
    dispatcher.detach();
  });

  it('throttle window is per-thread', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const clock = { now: 1_000 };
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
      now: () => clock.now,
      throttleWindowMs: 30_000,
    });

    router.publish('threads.event', 'threads.event', {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 'thread-A',
        role: 'assistant',
        content: 'A1',
        createdAt: clock.now,
      },
    } satisfies ThreadEvent);
    await flush();

    router.publish('threads.event', 'threads.event', {
      type: 'message',
      message: {
        id: 'm2',
        threadId: 'thread-B',
        role: 'assistant',
        content: 'B1',
        createdAt: clock.now,
      },
    } satisfies ThreadEvent);
    await flush();

    expect(pushClient.sent).toHaveLength(2);
    dispatcher.detach();
  });

  it('truncates long bodies with an ellipsis', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
    });
    const long = 'x'.repeat(500);
    router.publish('threads.event', 'threads.event', {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: long,
        createdAt: 0,
      },
    } satisfies ThreadEvent);
    await flush();
    expect(pushClient.sent[0]?.[0]?.body.endsWith('…')).toBe(true);
    expect(pushClient.sent[0]?.[0]?.body.length).toBeLessThanOrEqual(140);
    dispatcher.detach();
  });

  it('no-ops when the pushClient is null (SDK failed to load)', async () => {
    const router = createRouter();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient: null,
    });
    router.publish('threads.event', 'threads.event', {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'hi',
        createdAt: 0,
      },
    } satisfies ThreadEvent);
    await flush();
    // No assertion beyond "did not throw" — we just confirm the
    // dispatcher tolerates an unavailable push client.
    dispatcher.detach();
  });

  it('fires on an agent-originated voice offer signal', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
      resolveAgentName: () => 'OpenClaw',
    });

    router.publish('voice.session-1.signal', 'voice.signal', {
      type: 'offer',
      from: 'agent',
      sdp: 'v=0...',
    });
    await flush();

    expect(pushClient.sent).toHaveLength(1);
    expect(pushClient.sent[0]?.[0]?.body).toBe('Agent is requesting voice.');
    expect(pushClient.sent[0]?.[0]?.data?.['kind']).toBe('voice_request');
    dispatcher.detach();
  });

  it('ignores phone-originated voice offers (no `from: agent`)', async () => {
    const router = createRouter();
    const pushClient = fakePushClient();
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
    });

    router.publish('voice.session-1.signal', 'voice.signal', {
      type: 'offer',
      sdp: 'v=0...',
    });
    await flush();

    expect(pushClient.sent).toEqual([]);
    dispatcher.detach();
  });

  it('survives a throwing pushClient.sendNotifications', async () => {
    const router = createRouter();
    const pushClient = fakePushClient({ throwOnSend: true });
    const logs: string[] = [];
    const dispatcher = attachPushDispatcher({
      router,
      registry: fakeRegistry(ONE_TARGET),
      pushClient,
      logger: (level, msg) => {
        logs.push(`${level}:${msg}`);
      },
    });
    router.publish('threads.event', 'threads.event', {
      type: 'message',
      message: {
        id: 'm1',
        threadId: 't1',
        role: 'assistant',
        content: 'kaboom',
        createdAt: 0,
      },
    } satisfies ThreadEvent);
    await flush();
    expect(logs.some((l) => l.startsWith('error:'))).toBe(true);
    dispatcher.detach();
  });
});
