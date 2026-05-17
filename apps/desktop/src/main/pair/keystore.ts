// Secret storage abstraction used by `keypair.ts` to persist the desktop
// app's Ed25519 signing key.
//
// On macOS / Windows / Linux-with-Secret-Service, `keytar` (libsecret on
// Linux, Keychain on macOS, Credential Vault on Windows) is the right
// backend — see the desktop plan, P03B step 2. In some container / CI
// environments (notably this repo's Linux dev container) libsecret-1.so.0
// is not present, so `require('keytar')` throws at load time. To keep the
// `pnpm --filter @openclaw/desktop build` and `test` baseline green on
// Linux, we fall back to a file-encrypted blob at
// `app.getPath('userData')/keystore.enc`, with the encryption key derived
// from a host-stable identifier (`/etc/machine-id` on Linux, falling back
// to `os.hostname()` + `os.platform()`). This fallback is **dev-only** —
// production hardening is tracked in `.chalk/open-questions.md`.
//
// The public surface is the same in both modes: `getSecret(account)` and
// `setSecret(account, value)`. The service name is fixed at construction
// time so callers don't repeat it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Service name we register under in Keychain / Secret Service. */
export const KEYSTORE_SERVICE = 'dev.openclaw.desktop';

/**
 * Minimal interface implemented by both the keytar-backed and the
 * file-encrypted-backed keystores. Keep the surface tight — anything more
 * than `get`/`set` belongs in a higher-level module (e.g. `keypair.ts`).
 */
export interface Keystore {
  /** Returns the stored secret for `account`, or `null` if absent. */
  getSecret(account: string): Promise<string | null>;
  /** Persists `value` for `account`, overwriting any prior value. */
  setSecret(account: string, value: string): Promise<void>;
  /** Human-readable backend name, used in diagnostics + tests. */
  readonly backend: 'keytar' | 'file';
}

/** Tagged record used by the file-encrypted fallback's JSON envelope. */
interface FileEntry {
  /** base64 ciphertext */
  ct: string;
  /** base64 iv (12 bytes for AES-256-GCM) */
  iv: string;
  /** base64 auth tag (16 bytes) */
  tag: string;
}

interface FileEnvelope {
  /** Schema version so we can rotate the format without losing data. */
  version: 1;
  /** `account` → `FileEntry`. */
  entries: Record<string, FileEntry>;
}

/**
 * Try to load `keytar`. We `require` lazily because the native binding
 * throws at `require` time on Linux systems without libsecret. A throw
 * here is the signal that we should fall back to the file-encrypted
 * keystore.
 */
function tryLoadKeytar(): typeof import('keytar') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar') as typeof import('keytar');
  } catch {
    return null;
  }
}

/**
 * Derive a host-stable 32-byte key for the file-encrypted fallback. We
 * read `/etc/machine-id` when present (stable across reboots on Linux),
 * otherwise fold `os.hostname()` + `os.platform()` together. This is **not**
 * a defense against an attacker with disk access — it's just enough to
 * stop the private key from sitting in cleartext on disk in the dev
 * container. Production hardening is tracked in open-questions.md.
 */
function deriveFileKey(): Buffer {
  let seed: string;
  try {
    if (existsSync('/etc/machine-id')) {
      seed = readFileSync('/etc/machine-id', 'utf8').trim();
    } else if (existsSync('/var/lib/dbus/machine-id')) {
      seed = readFileSync('/var/lib/dbus/machine-id', 'utf8').trim();
    } else {
      seed = `${hostname()}::${platform()}`;
    }
  } catch {
    seed = `${hostname()}::${platform()}`;
  }
  // Fixed salt is fine here because the threat model is local-only; rotating
  // the salt would mean we couldn't reopen the keystore after a reload.
  return scryptSync(seed, 'openclaw-desktop-keystore-v1', 32);
}

function readEnvelope(filePath: string): FileEnvelope {
  if (!existsSync(filePath)) {
    return { version: 1, entries: {} };
  }
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as FileEnvelope;
  if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) {
    throw new Error(`keystore: unsupported envelope at ${filePath}`);
  }
  return parsed;
}

function writeEnvelope(filePath: string, envelope: FileEnvelope): void {
  mkdirSync(dirname(filePath), { recursive: true });
  // 0o600 isn't honored on every filesystem, but it's a cheap signal.
  writeFileSync(filePath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
}

/** File-encrypted fallback. AES-256-GCM, one entry per account. */
class FileKeystore implements Keystore {
  readonly backend = 'file' as const;
  private readonly key = deriveFileKey();

  constructor(private readonly filePath: string) {}

  async getSecret(account: string): Promise<string | null> {
    const env = readEnvelope(this.filePath);
    const entry = env.entries[account];
    if (!entry) return null;
    const iv = Buffer.from(entry.iv, 'base64');
    const tag = Buffer.from(entry.tag, 'base64');
    const ct = Buffer.from(entry.ct, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  }

  async setSecret(account: string, value: string): Promise<void> {
    const env = readEnvelope(this.filePath);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    env.entries[account] = {
      ct: ct.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
    writeEnvelope(this.filePath, env);
  }
}

/** Thin adapter so the keytar API matches our `Keystore` interface. */
class KeytarKeystore implements Keystore {
  readonly backend = 'keytar' as const;

  constructor(
    private readonly keytarModule: typeof import('keytar'),
    private readonly service: string,
  ) {}

  async getSecret(account: string): Promise<string | null> {
    return this.keytarModule.getPassword(this.service, account);
  }

  async setSecret(account: string, value: string): Promise<void> {
    await this.keytarModule.setPassword(this.service, account, value);
  }
}

/**
 * Construct the best-available keystore for the current host.
 *
 * - If `keytar` loads and a probe call succeeds, return the keytar-backed
 *   implementation (Keychain on macOS, Secret Service on Linux, Credential
 *   Vault on Windows).
 * - Otherwise return the file-encrypted fallback rooted at `userDataDir`.
 *
 * `service` defaults to `KEYSTORE_SERVICE`; tests override it to avoid
 * colliding with a real user's Keychain entries.
 */
export async function openKeystore(
  userDataDir: string,
  service: string = KEYSTORE_SERVICE,
): Promise<Keystore> {
  const keytarModule = tryLoadKeytar();
  if (keytarModule) {
    try {
      // Probe a read so we surface runtime failures (e.g. dbus missing
      // despite libsecret being installed) before we hand out a backend
      // that will throw on first real use.
      await keytarModule.getPassword(service, '__openclaw_probe__');
      return new KeytarKeystore(keytarModule, service);
    } catch {
      // fall through to file fallback
    }
  }
  return new FileKeystore(join(userDataDir, 'keystore.enc'));
}
