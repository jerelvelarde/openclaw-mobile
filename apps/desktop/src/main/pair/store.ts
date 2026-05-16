// Persisted approved-device store.
//
// Per P03B step 4: a JSON file at `app.getPath('userData')/devices.json`
// holding the list of devices that have been approved for pairing.
// **Never** persist raw tokens — only the metadata needed to render the
// "Paired devices" list and to recognise a device on reconnect. Tokens
// live on the device that holds them; if a user wants to revoke a device
// they remove the entry here and the gateway refuses future connections.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Record of one approved device. Field names use snake_case to match the
 * shape we serialise in `devices.json` and the on-wire protocol used by
 * `server.ts`; this keeps the JSON round-trip free of remapping logic.
 */
export interface PairedDevice {
  /** Stable id assigned by the desktop at approval time. */
  device_id: string;
  /** Human-readable device name (whatever the phone sent at pairing). */
  device_name: string;
  /** Epoch ms when the user approved this device. */
  paired_at: number;
  /** Epoch ms of the last time we saw a successful auth from this device. */
  last_seen: number;
}

interface DeviceFile {
  version: 1;
  devices: PairedDevice[];
}

function read(filePath: string): DeviceFile {
  if (!existsSync(filePath)) {
    return { version: 1, devices: [] };
  }
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as DeviceFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.devices)) {
    throw new Error(`devices store: unsupported envelope at ${filePath}`);
  }
  return parsed;
}

function write(filePath: string, file: DeviceFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
}

/**
 * Devices store. Construct once at app start with the userData dir and
 * reuse for the lifetime of the process — no in-memory cache, every call
 * round-trips through disk, which is fine for the expected handful-of-
 * devices size.
 */
export class DeviceStore {
  private readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, 'devices.json');
  }

  /** Where the JSON file lives on disk. Exposed for tests + tray UI. */
  get path(): string {
    return this.filePath;
  }

  /** Insert or replace the device with `device.device_id`. */
  addDevice(device: PairedDevice): void {
    const file = read(this.filePath);
    const idx = file.devices.findIndex((d) => d.device_id === device.device_id);
    if (idx >= 0) {
      file.devices[idx] = device;
    } else {
      file.devices.push(device);
    }
    write(this.filePath, file);
  }

  /** Return all approved devices, sorted by `paired_at` descending. */
  listDevices(): PairedDevice[] {
    const file = read(this.filePath);
    return [...file.devices].sort((a, b) => b.paired_at - a.paired_at);
  }

  /** Remove the device with `device_id`. No-op if it's already absent. */
  revokeDevice(deviceId: string): void {
    const file = read(this.filePath);
    file.devices = file.devices.filter((d) => d.device_id !== deviceId);
    write(this.filePath, file);
  }

  /** Update the `last_seen` timestamp for a device. No-op if absent. */
  touch(deviceId: string, now: number = Date.now()): void {
    const file = read(this.filePath);
    const device = file.devices.find((d) => d.device_id === deviceId);
    if (!device) return;
    device.last_seen = now;
    write(this.filePath, file);
  }
}
