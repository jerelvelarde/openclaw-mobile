// Device store: add → list → revoke → touch round-trip.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore } from '../store';

describe('DeviceStore', () => {
  let tmp: string;
  let store: DeviceStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'openclaw-store-'));
    store = new DeviceStore(tmp);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty list before any device is added', () => {
    expect(store.listDevices()).toEqual([]);
  });

  it('adds a device, persists it, and lists it', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    const listed = store.listDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.device_name).toBe('Phone A');
    expect(existsSync(join(tmp, 'devices.json'))).toBe(true);
  });

  it('replaces a device with the same id rather than duplicating it', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A renamed',
      paired_at: 2000,
      last_seen: 2000,
    });
    const listed = store.listDevices();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.device_name).toBe('Phone A renamed');
  });

  it('sorts listDevices by paired_at descending', () => {
    store.addDevice({
      device_id: 'older',
      device_name: 'old',
      paired_at: 1000,
      last_seen: 1000,
    });
    store.addDevice({
      device_id: 'newer',
      device_name: 'new',
      paired_at: 2000,
      last_seen: 2000,
    });
    const listed = store.listDevices();
    expect(listed.map((d) => d.device_id)).toEqual(['newer', 'older']);
  });

  it('revokes a device and survives revoke of an unknown id', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    store.revokeDevice('dev-unknown');
    expect(store.listDevices()).toHaveLength(1);
    store.revokeDevice('dev-1');
    expect(store.listDevices()).toEqual([]);
  });

  it('updates last_seen via touch()', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    store.touch('dev-1', 5000);
    expect(store.listDevices()[0]?.last_seen).toBe(5000);
  });

  it('reads back state from disk in a fresh instance', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    const fresh = new DeviceStore(tmp);
    expect(fresh.listDevices()).toHaveLength(1);
  });

  it('does not write raw tokens to the JSON file', () => {
    store.addDevice({
      device_id: 'dev-1',
      device_name: 'Phone A',
      paired_at: 1000,
      last_seen: 1000,
    });
    const raw = readFileSync(join(tmp, 'devices.json'), 'utf8');
    expect(raw).not.toMatch(/token/i);
  });
});
