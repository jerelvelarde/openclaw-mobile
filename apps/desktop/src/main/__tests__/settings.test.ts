// Unit tests for the JSON settings store.
//
// Covers default values, persistence across reads, partial updates, and
// graceful handling of a corrupted file.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, SettingsStore } from '../settings';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'openclaw-settings-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('returns defaults when the file does not exist', () => {
    const store = new SettingsStore(tmp);
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists updates and merges with defaults', () => {
    const store = new SettingsStore(tmp);
    const updated = store.update({ lan_enabled: false });
    expect(updated.lan_enabled).toBe(false);
    expect(new SettingsStore(tmp).read().lan_enabled).toBe(false);
  });

  it('falls back to defaults if the file is corrupted', () => {
    const path = join(tmp, 'settings.json');
    writeFileSync(path, 'this-is-not-json');
    const store = new SettingsStore(tmp);
    expect(store.read()).toEqual(DEFAULT_SETTINGS);
  });

  it('coerces unknown lan_enabled values to the default', () => {
    const path = join(tmp, 'settings.json');
    writeFileSync(path, JSON.stringify({ version: 1, lan_enabled: 'yes' }));
    const store = new SettingsStore(tmp);
    expect(store.read().lan_enabled).toBe(DEFAULT_SETTINGS.lan_enabled);
  });
});
