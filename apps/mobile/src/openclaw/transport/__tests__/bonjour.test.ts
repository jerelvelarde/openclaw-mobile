// Bonjour wrapper tests.
//
// We mock the underlying `react-native-zeroconf`-shaped factory and assert
// that `browse()` translates events into the normalized `DiscoveredHost`
// surface the discover screen consumes. The wrapper has three jobs:
//
//   1. start a scan on construction,
//   2. translate `resolved` payloads into `DiscoveredHost`s,
//   3. clean up listeners on unsubscribe.
//
// Mocking the native module is the same pattern we'll use in the real
// device-less CI environment.

import { browse, toDiscoveredHost, type ZeroconfLike, type ZeroconfResolved } from '../bonjour';

/**
 * Fake `Zeroconf` instance whose emit-points the test drives directly.
 * We type the listener bag as `unknown` and `as`-cast it on register so
 * the overloaded `on()` shape matches the `ZeroconfLike` interface.
 */
interface FakeZeroconf extends ZeroconfLike {
  triggerResolved: (svc: ZeroconfResolved) => void;
  triggerRemove: (name: string) => void;
  triggerError: (err: Error) => void;
  scanCalls: number;
  stopCalls: number;
  removedAll: boolean;
}

function makeFakeZeroconf(): FakeZeroconf {
  const handlers: { [key: string]: ((arg: never) => void)[] } = {};
  const fake: FakeZeroconf = {
    scanCalls: 0,
    stopCalls: 0,
    removedAll: false,
    on(event: 'resolved' | 'remove' | 'error', handler: (arg: never) => void) {
      const set = handlers[event] ?? (handlers[event] = []);
      set.push(handler);
    },
    removeAllListeners(event?: string) {
      if (event) {
        delete handlers[event];
      } else {
        for (const k of Object.keys(handlers)) delete handlers[k];
      }
      fake.removedAll = true;
    },
    scan() {
      fake.scanCalls += 1;
    },
    stop() {
      fake.stopCalls += 1;
    },
    triggerResolved(svc: ZeroconfResolved) {
      for (const h of handlers.resolved ?? []) h(svc as never);
    },
    triggerRemove(name: string) {
      for (const h of handlers.remove ?? []) h(name as never);
    },
    triggerError(err: Error) {
      for (const h of handlers.error ?? []) h(err as never);
    },
  };
  return fake;
}

describe('toDiscoveredHost', () => {
  it('prefers an IPv4 address from `addresses[]` over `host`', () => {
    const host = toDiscoveredHost({
      name: 'Jerel-Mac.local',
      host: 'Jerel-Mac.local.',
      port: 18789,
      addresses: ['fe80::1', '192.168.1.42'],
    });
    expect(host.host).toBe('192.168.1.42');
    expect(host.httpBase).toBe('http://192.168.1.42:18789');
  });

  it('falls back to `host` when no addresses are provided', () => {
    const host = toDiscoveredHost({ name: 'mac', host: 'mac.local', port: 18789 });
    expect(host.host).toBe('mac.local');
    expect(host.httpBase).toBe('http://mac.local:18789');
  });
});

describe('browse', () => {
  it('starts a scan and translates `resolved` events into DiscoveredHosts', () => {
    const zc = makeFakeZeroconf();
    const onFound = jest.fn();
    const onLost = jest.fn();
    const unsub = browse({ onFound, onLost }, () => zc);
    expect(zc.scanCalls).toBe(1);

    zc.triggerResolved({
      name: 'Mac mini',
      host: 'mac.local',
      port: 18789,
      addresses: ['192.168.1.42'],
    });
    expect(onFound).toHaveBeenCalledTimes(1);
    expect(onFound.mock.calls[0]![0]).toEqual({
      id: 'Mac mini',
      name: 'Mac mini',
      host: '192.168.1.42',
      port: 18789,
      httpBase: 'http://192.168.1.42:18789',
      txt: undefined,
    });

    zc.triggerRemove('Mac mini');
    expect(onLost).toHaveBeenCalledWith('Mac mini');

    unsub();
    expect(zc.stopCalls).toBe(1);
    expect(zc.removedAll).toBe(true);
  });

  it('forwards errors to onError without crashing', () => {
    const zc = makeFakeZeroconf();
    const onError = jest.fn();
    const unsub = browse({ onFound: jest.fn(), onLost: jest.fn(), onError }, () => zc);
    zc.triggerError(new Error('scan failed'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    unsub();
  });

  it('ignores resolved payloads without a name or port', () => {
    const zc = makeFakeZeroconf();
    const onFound = jest.fn();
    const unsub = browse({ onFound, onLost: jest.fn() }, () => zc);
    zc.triggerResolved({ name: '', host: 'mac.local', port: 18789 });
    zc.triggerResolved({
      name: 'has-no-port',
      host: 'mac.local',
      port: undefined as unknown as number,
    });
    expect(onFound).not.toHaveBeenCalled();
    unsub();
  });

  it('returns a no-op unsubscribe if the factory throws', () => {
    const onError = jest.fn();
    const unsub = browse({ onFound: jest.fn(), onLost: jest.fn(), onError }, () => {
      throw new Error('native module missing');
    });
    expect(onError).toHaveBeenCalledTimes(1);
    // Calling the no-op unsubscribe must not throw.
    expect(() => unsub()).not.toThrow();
  });
});
