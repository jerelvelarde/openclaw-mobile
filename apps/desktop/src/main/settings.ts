// Persistent app settings.
//
// P04B introduces the first runtime-tunable setting: `lan_enabled`. When
// true the pairing server binds to `0.0.0.0` so Bonjour-advertised
// neighbours on the same Wi-Fi can reach it; when false it stays bound
// to loopback (the P03B default). We persist the file at
// `userData/settings.json` so toggling survives restarts.
//
// The format is intentionally trivial — a single JSON object with a
// version envelope. Unknown fields are preserved across reads (so a
// downgrade doesn't drop settings written by a newer version). Future
// settings land here too rather than spawning per-feature stores.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Shape of the persisted JSON object. */
export interface SettingsFile {
  version: 1;
  /**
   * When `true`, the pairing + WS server binds to `0.0.0.0` and Bonjour
   * advertises the gateway on the LAN. When `false`, the server stays
   * loopback-only and Bonjour publishing is skipped.
   */
  lan_enabled: boolean;
}

/** Reasonable defaults applied when the file is missing or partial. */
export const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  lan_enabled: true,
};

function read(filePath: string): SettingsFile {
  if (!existsSync(filePath)) {
    return { ...DEFAULT_SETTINGS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    // Corrupted file — fall back to defaults rather than crashing the app.
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Partial<SettingsFile> & Record<string, unknown>;
  return {
    ...DEFAULT_SETTINGS,
    ...obj,
    version: 1,
    lan_enabled:
      typeof obj.lan_enabled === 'boolean' ? obj.lan_enabled : DEFAULT_SETTINGS.lan_enabled,
  };
}

function write(filePath: string, file: SettingsFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/**
 * Persistent settings store. Construct once at app start with the
 * `userData` directory and reuse for the lifetime of the process. Like
 * `DeviceStore`, we don't cache in memory — disk round-trips are fine
 * for a single-digit number of fields.
 */
export class SettingsStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'settings.json');
  }

  /** Filesystem path of the settings JSON. Exposed for tests + diagnostics. */
  get path(): string {
    return this.filePath;
  }

  /** Return the current settings, applying defaults for missing fields. */
  read(): SettingsFile {
    return read(this.filePath);
  }

  /**
   * Patch the settings. Missing fields keep their current values; the
   * resulting object is written verbatim. Returns the new full state.
   */
  update(patch: Partial<Omit<SettingsFile, 'version'>>): SettingsFile {
    const current = read(this.filePath);
    const next: SettingsFile = {
      ...current,
      ...patch,
      version: 1,
    };
    write(this.filePath, next);
    return next;
  }
}
