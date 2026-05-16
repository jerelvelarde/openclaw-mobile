// Push device registry: token round-trip + listPushTargets filter.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore } from '../../pair/store';
import { createPushDeviceRegistry } from '../devices';

describe('push device registry', () => {
  let tmp: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openclaw-push-devices-'));
    store = new DeviceStore(tmp);
    store.addDevice({
      device_id: 'dev-a',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    store.addDevice({
      device_id: 'dev-b',
      device_name: 'Phone B',
      paired_at: 2000,
      last_seen: 2000,
    });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('persists a push token + platform on a paired device', () => {
    const registry = createPushDeviceRegistry(store);
    expect(registry.setPushToken('dev-a', 'ExponentPushToken[abc]', 'ios')).toBe(true);
    const listed = store.listDevices().find((d) => d.device_id === 'dev-a');
    expect(listed?.pushToken).toBe('ExponentPushToken[abc]');
    expect(listed?.pushPlatform).toBe('ios');
  });

  it('survives a fresh DeviceStore instance reading from disk', () => {
    const registry = createPushDeviceRegistry(store);
    registry.setPushToken('dev-a', 'ExponentPushToken[xyz]', 'android');
    const fresh = new DeviceStore(tmp);
    const listed = fresh.listDevices().find((d) => d.device_id === 'dev-a');
    expect(listed?.pushToken).toBe('ExponentPushToken[xyz]');
    expect(listed?.pushPlatform).toBe('android');
  });

  it('returns false when setting a token for an unknown device', () => {
    const registry = createPushDeviceRegistry(store);
    expect(registry.setPushToken('does-not-exist', 'ExponentPushToken[abc]', 'ios')).toBe(false);
  });

  it('listPushTargets filters out devices without a token', () => {
    const registry = createPushDeviceRegistry(store);
    registry.setPushToken('dev-b', 'ExponentPushToken[only-b]', 'ios');
    const targets = registry.listPushTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]?.deviceId).toBe('dev-b');
    expect(targets[0]?.pushToken).toBe('ExponentPushToken[only-b]');
    expect(targets[0]?.pushPlatform).toBe('ios');
  });

  it('clearPushToken removes both the token and the platform', () => {
    const registry = createPushDeviceRegistry(store);
    registry.setPushToken('dev-a', 'ExponentPushToken[abc]', 'ios');
    expect(registry.clearPushToken('dev-a')).toBe(true);
    const listed = store.listDevices().find((d) => d.device_id === 'dev-a');
    expect(listed?.pushToken).toBeUndefined();
    expect(listed?.pushPlatform).toBeUndefined();
    expect(registry.listPushTargets()).toEqual([]);
  });
});
