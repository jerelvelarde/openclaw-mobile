// Expo client wrapper tests.
//
// We don't import `expo-server-sdk` here — the Linux dev container has
// no way to actually reach Expo's push gateway, and we don't want a
// network call in unit tests. Instead we use `createPushClient`'s
// `expoClass` injection to plug a fake `Expo`-class-shaped object. The
// shape is exactly what the real SDK exposes (constructor, two methods,
// the static `isExpoPushToken` predicate) so when this test passes the
// production wire-up is guaranteed to compile against the real types.

import { describe, expect, it } from 'vitest';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import {
  createPushClient,
  type ExpoSdkCtor,
  type ExpoSdkLike,
  type PushClientOptions,
} from '../expoClient';

interface FakeExpoCalls {
  constructed: Array<{ accessToken?: string }>;
  sent: ExpoPushMessage[][];
}

function makeFakeExpoClass(opts?: {
  chunkSize?: number;
  ticketsFor?: (msgs: ExpoPushMessage[]) => ExpoPushTicket[];
  throwOnSend?: boolean;
}): { Ctor: ExpoSdkCtor; calls: FakeExpoCalls } {
  const calls: FakeExpoCalls = { constructed: [], sent: [] };
  const chunkSize = opts?.chunkSize ?? 100;
  const ticketsFor =
    opts?.ticketsFor ??
    ((msgs: ExpoPushMessage[]): ExpoPushTicket[] =>
      msgs.map((_m, i) => ({ status: 'ok', id: `ticket-${i}` })));

  class FakeExpo implements ExpoSdkLike {
    constructor(options?: { accessToken?: string }) {
      calls.constructed.push({ accessToken: options?.accessToken });
    }
    async sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
      calls.sent.push(messages);
      if (opts?.throwOnSend) throw new Error('boom');
      return ticketsFor(messages);
    }
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
      const chunks: ExpoPushMessage[][] = [];
      for (let i = 0; i < messages.length; i += chunkSize) {
        chunks.push(messages.slice(i, i + chunkSize));
      }
      return chunks;
    }
    static isExpoPushToken(token: unknown): boolean {
      return typeof token === 'string' && token.startsWith('ExponentPushToken[');
    }
  }

  return { Ctor: FakeExpo as unknown as ExpoSdkCtor, calls };
}

describe('createPushClient', () => {
  it('passes the accessToken through to the underlying SDK ctor', async () => {
    const { Ctor, calls } = makeFakeExpoClass();
    const optsArg: PushClientOptions = { expoClass: Ctor, accessToken: 'secret-token' };
    await createPushClient(optsArg);
    expect(calls.constructed).toEqual([{ accessToken: 'secret-token' }]);
  });

  it('translates sendNotification into the SDK shape (title/body/data/to)', async () => {
    const { Ctor, calls } = makeFakeExpoClass();
    const client = await createPushClient({ expoClass: Ctor });
    const res = await client.sendNotification({
      token: 'ExponentPushToken[abc]',
      title: 'OpenClaw',
      body: 'Echo: hello',
      data: { threadId: 't1' },
    });
    expect(res.error).toBeUndefined();
    expect(res.tickets).toHaveLength(1);
    expect(calls.sent).toHaveLength(1);
    expect(calls.sent[0]).toEqual([
      {
        to: 'ExponentPushToken[abc]',
        title: 'OpenClaw',
        body: 'Echo: hello',
        data: { threadId: 't1' },
        sound: 'default',
        priority: 'high',
        channelId: undefined,
      },
    ]);
  });

  it('chunks bulk sends through the SDK chunker', async () => {
    const { Ctor, calls } = makeFakeExpoClass({ chunkSize: 2 });
    const client = await createPushClient({ expoClass: Ctor });
    const tokens = ['a', 'b', 'c', 'd', 'e'].map((s) => `ExponentPushToken[${s}]`);
    await client.sendNotifications(tokens.map((t) => ({ token: t, title: 'Bulk', body: 'b' })));
    expect(calls.sent.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('captures errors from sendPushNotificationsAsync and reports via result.error', async () => {
    const { Ctor } = makeFakeExpoClass({ throwOnSend: true });
    const logs: Array<[string, string, unknown?]> = [];
    const client = await createPushClient({
      expoClass: Ctor,
      logger: (level, msg, meta) => {
        logs.push([level, msg, meta]);
      },
    });
    const res = await client.sendNotification({
      token: 'ExponentPushToken[abc]',
      title: 'T',
      body: 'B',
    });
    expect(res.error?.message).toBe('boom');
    expect(res.tickets).toEqual([]);
    expect(logs.some(([level]) => level === 'error')).toBe(true);
  });

  it('logs ticket-level errors at warn but still returns them', async () => {
    const { Ctor } = makeFakeExpoClass({
      ticketsFor: (): ExpoPushTicket[] => [
        {
          status: 'error',
          message: 'DeviceNotRegistered',
          details: { error: 'DeviceNotRegistered' },
        },
      ],
    });
    const logs: Array<[string, string]> = [];
    const client = await createPushClient({
      expoClass: Ctor,
      logger: (level, msg) => {
        logs.push([level, msg]);
      },
    });
    const res = await client.sendNotification({
      token: 'ExponentPushToken[abc]',
      title: 'T',
      body: 'B',
    });
    expect(res.tickets).toHaveLength(1);
    expect(logs.some(([level, msg]) => level === 'warn' && msg.includes('ticket error'))).toBe(
      true,
    );
  });

  it('isExpoPushToken delegates to the SDK static predicate', async () => {
    const { Ctor } = makeFakeExpoClass();
    const client = await createPushClient({ expoClass: Ctor });
    expect(client.isExpoPushToken('ExponentPushToken[abc]')).toBe(true);
    expect(client.isExpoPushToken('not-a-token')).toBe(false);
    expect(client.isExpoPushToken(42)).toBe(false);
  });
});
