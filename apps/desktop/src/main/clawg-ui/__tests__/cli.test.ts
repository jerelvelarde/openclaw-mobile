// Tests for the `openclaw` CLI wrapper (P11B).
//
// We never spawn a real process — every test injects a fake `spawn` so
// the assertions can verify the command + args + timeout behaviour.

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FALLBACK_PATHS,
  PAIRING_CODE_PATTERN,
  resolveOpenClawBinary,
  runClawgUiPairingApprove,
  type ChildProcessLike,
  type SpawnFn,
} from '../cli';

/** Build a fake child process that exposes `stdout`/`stderr` event streams. */
function buildFakeChild(): ChildProcessLike & {
  emitStdout(s: string): void;
  emitStderr(s: string): void;
  emitError(err: Error): void;
  finish(code: number | null, signal?: NodeJS.Signals | null): void;
  killCalls: NodeJS.Signals[];
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const lifecycle = new EventEmitter();
  const killCalls: NodeJS.Signals[] = [];
  const child = {
    stdout: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => stdout.on(event, cb) },
    stderr: { on: (event: 'data', cb: (chunk: Buffer | string) => void) => stderr.on(event, cb) },
    on(event: 'error' | 'close', cb: (...args: unknown[]) => void) {
      lifecycle.on(event, cb);
    },
    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
      killCalls.push(signal);
      return true;
    },
    emitStdout(s: string): void {
      stdout.emit('data', s);
    },
    emitStderr(s: string): void {
      stderr.emit('data', s);
    },
    emitError(err: Error): void {
      lifecycle.emit('error', err);
    },
    finish(code: number | null, signal: NodeJS.Signals | null = null): void {
      lifecycle.emit('close', code, signal);
    },
    killCalls,
  };
  return child as ReturnType<typeof buildFakeChild>;
}

describe('PAIRING_CODE_PATTERN', () => {
  it('accepts the documented clawg-ui code shapes', () => {
    expect(PAIRING_CODE_PATTERN.test('ABCD1234')).toBe(true);
    expect(PAIRING_CODE_PATTERN.test('abcd1234')).toBe(true);
    expect(PAIRING_CODE_PATTERN.test('ABCD-1234')).toBe(true);
    expect(PAIRING_CODE_PATTERN.test('A')).toBe(true);
  });

  it('rejects shell metacharacters', () => {
    expect(PAIRING_CODE_PATTERN.test('ABCD; rm -rf /')).toBe(false);
    expect(PAIRING_CODE_PATTERN.test('ABCD$(whoami)')).toBe(false);
    expect(PAIRING_CODE_PATTERN.test('ABCD 1234')).toBe(false);
    expect(PAIRING_CODE_PATTERN.test('')).toBe(false);
    expect(PAIRING_CODE_PATTERN.test('A'.repeat(64))).toBe(false);
  });
});

describe('resolveOpenClawBinary', () => {
  it('returns the explicit binaryPath when it exists', () => {
    const found = resolveOpenClawBinary({
      binaryPath: '/custom/openclaw',
      pathExists: (p) => p === '/custom/openclaw',
    });
    expect(found).toBe('/custom/openclaw');
  });

  it('returns null when the explicit binaryPath does not exist', () => {
    const found = resolveOpenClawBinary({
      binaryPath: '/nope/openclaw',
      pathExists: () => false,
    });
    expect(found).toBeNull();
  });

  it('walks $PATH and returns the first match', () => {
    const found = resolveOpenClawBinary({
      env: { PATH: '/a:/b:/c' },
      platform: 'darwin',
      pathExists: (p) => p === '/b/openclaw',
    });
    expect(found).toBe('/b/openclaw');
  });

  it('uses openclaw.exe on win32', () => {
    // The path-walker uses `node:path`'s `delimiter` to split PATH.
    // On linux that's `:`; we sidestep the cross-platform difference
    // by passing a single-entry PATH so no split is needed.
    const found = resolveOpenClawBinary({
      env: { PATH: 'C:\\bin' },
      platform: 'win32',
      pathExists: (p) => typeof p === 'string' && /openclaw\.exe$/.test(p),
    });
    expect(typeof found).toBe('string');
    expect(found ?? '').toMatch(/openclaw\.exe$/);
  });

  it('falls back to well-known install locations', () => {
    const found = resolveOpenClawBinary({
      env: { PATH: '/nowhere' },
      pathExists: (p) => p === DEFAULT_FALLBACK_PATHS[0],
    });
    expect(found).toBe(DEFAULT_FALLBACK_PATHS[0]);
  });

  it('returns null when nothing matches', () => {
    const found = resolveOpenClawBinary({
      env: { PATH: '/nowhere' },
      pathExists: () => false,
    });
    expect(found).toBeNull();
  });
});

describe('runClawgUiPairingApprove', () => {
  it('refuses to spawn for codes outside the allowed charset', async () => {
    const spawnFn = vi.fn() as unknown as SpawnFn;
    const result = await runClawgUiPairingApprove({
      pairingCode: 'ABCD; rm -rf /',
      spawnFn,
      pathExists: () => true,
      binaryPath: '/fake/openclaw',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not match');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('surfaces a clear error when the binary is missing', async () => {
    const spawnFn = vi.fn() as unknown as SpawnFn;
    const result = await runClawgUiPairingApprove({
      pairingCode: 'ABCD1234',
      spawnFn,
      pathExists: () => false,
      env: { PATH: '/nowhere' },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/openclaw/);
    expect(result.binaryPath).toBe('');
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawns `openclaw pairing approve clawg-ui <code>` with array args (no shell)', async () => {
    const child = buildFakeChild();
    const spawnFn = vi.fn((_cmd: string, _args: readonly string[], opts?: unknown) => {
      // Critical: shell mode must NOT be enabled (anti-pattern in plan).
      expect(opts).not.toHaveProperty('shell', true);
      return child;
    }) as unknown as SpawnFn;

    const resultPromise = runClawgUiPairingApprove({
      pairingCode: 'ABCD1234',
      binaryPath: '/usr/local/bin/openclaw',
      pathExists: () => true,
      spawnFn,
    });

    child.emitStdout('approved.\n');
    child.finish(0);

    const result = await resultPromise;
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const callArgs = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(callArgs[0]).toBe('/usr/local/bin/openclaw');
    expect(callArgs[1]).toEqual(['pairing', 'approve', 'clawg-ui', 'ABCD1234']);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('approved.');
    expect(result.binaryPath).toBe('/usr/local/bin/openclaw');
  });

  it('marks non-zero exits as not ok and includes stderr', async () => {
    const child = buildFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const resultPromise = runClawgUiPairingApprove({
      pairingCode: 'ABCD1234',
      binaryPath: '/usr/local/bin/openclaw',
      pathExists: () => true,
      spawnFn,
    });

    child.emitStderr('unknown channel clawg-ui\n');
    child.finish(1);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown channel');
  });

  it('kills the child + reports timeout when the CLI hangs', async () => {
    vi.useFakeTimers();
    try {
      const child = buildFakeChild();
      const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

      const resultPromise = runClawgUiPairingApprove({
        pairingCode: 'ABCD1234',
        binaryPath: '/usr/local/bin/openclaw',
        pathExists: () => true,
        spawnFn,
        timeoutMs: 100,
      });

      // Fast-forward the timeout. The fake child's `kill` is recorded;
      // we then drive the `close` event the same way real child
      // processes do after SIGTERM.
      vi.advanceTimersByTime(100);
      expect(child.killCalls).toEqual(['SIGTERM']);
      child.finish(null, 'SIGTERM');

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces spawn errors (e.g. ENOENT after path probe)', async () => {
    const child = buildFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const resultPromise = runClawgUiPairingApprove({
      pairingCode: 'ABCD1234',
      binaryPath: '/usr/local/bin/openclaw',
      pathExists: () => true,
      spawnFn,
    });

    child.emitError(new Error('ENOENT'));

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to spawn/);
  });
});
