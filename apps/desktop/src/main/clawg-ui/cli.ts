// Wrapper around the host's `openclaw` CLI for the clawg-ui pairing
// approve step (P11B).
//
// `vendor/clawg-ui/README.md:303-304` documents two CLI commands the
// gateway owner runs after a client posts an initial unauthenticated
// `RunAgentInput`:
//
//   openclaw pairing list clawg-ui
//   openclaw pairing approve clawg-ui <code>
//
// The clawg-ui README does *not* document a `pairing reject` command;
// our "Deny" button only dismisses the banner locally — the issued
// device token simply times out server-side (per clawg-ui's 10-minute
// pending TTL). See P11B Notes: there is no reject RPC to wrap.
//
// All `child_process.spawn` calls in the codebase MUST go through this
// module (per the plan's success criteria) so the CLI args are
// validated in exactly one place. We refuse pairing codes outside
// `[A-Za-z0-9-]{1,32}` defensively — clawg-ui issues short alphanumeric
// codes in practice, but the runtime regex stays slightly forgiving so
// a future format change upstream doesn't immediately break us.

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * Acceptable pairing-code charset. `vendor/clawg-ui/src/http-handler.ts:273`
 * pairing codes are short alphanumeric strings; we also tolerate `-`
 * because some pairing CLIs format codes as `ABCD-1234` for readability.
 * Anything outside this range is rejected without spawning a process.
 */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9-]{1,32}$/;

/** Default time (ms) before we kill the child process. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** Default well-known install locations probed when `which`/`where` fails. */
export const DEFAULT_FALLBACK_PATHS = [
  '/usr/local/bin/openclaw',
  '/opt/homebrew/bin/openclaw',
  '/opt/openclaw/bin/openclaw',
];

/** Minimal `child_process.spawn`-shaped surface, kept narrow for testability. */
export interface ChildProcessLike {
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): void } | null;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: 'close', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Spawn signature compatible with `node:child_process.spawn`. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
) => ChildProcessLike;

/** Inputs to `runClawgUiPairingApprove`. */
export interface ApprovePairingOptions {
  /** Pairing code received in the 403 body's `error.pairing.pairingCode`. */
  pairingCode: string;
  /**
   * Optional explicit path to the `openclaw` binary. When omitted, we
   * probe (in order) `PATH`, then `DEFAULT_FALLBACK_PATHS`. The desktop
   * Settings page can let the user set this when auto-detect fails.
   */
  binaryPath?: string;
  /** Override the spawn timeout in ms. Default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injected `child_process.spawn` for tests. */
  spawnFn?: SpawnFn;
  /** Injected `process.env` so tests can drive PATH resolution. */
  env?: NodeJS.ProcessEnv;
  /** Injected `process.platform` so tests can drive PATHEXT handling. */
  platform?: NodeJS.Platform;
  /** Injected fs-exists for tests; defaults to `existsSync`. */
  pathExists?: (p: string) => boolean;
}

/** Result of a CLI invocation. */
export interface ApprovePairingResult {
  /** True iff the process exited with code 0. */
  ok: boolean;
  /** Stdout captured from the process. */
  stdout: string;
  /** Stderr captured from the process. */
  stderr: string;
  /** Exit code, or `null` if the process was killed. */
  exitCode: number | null;
  /** Resolved binary path actually used. */
  binaryPath: string;
  /** Populated when we never spawned (validation failure, binary missing). */
  error?: string;
}

/**
 * Resolve the absolute path to the `openclaw` binary. Search order:
 *
 *   1. Explicit `binaryPath` arg (if provided + exists).
 *   2. `$PATH` walk — each directory in `process.env.PATH` is checked
 *      for an `openclaw` file (or `openclaw.exe` on win32).
 *   3. Well-known install locations in `DEFAULT_FALLBACK_PATHS`.
 *
 * Returns `null` if no candidate exists. The caller is expected to
 * surface a "could not find openclaw CLI" error in the UI rather than
 * spawning a bogus path.
 */
export function resolveOpenClawBinary(opts: {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (p: string) => boolean;
}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.pathExists ?? existsSync;

  // 1. Explicit path wins.
  if (opts.binaryPath && opts.binaryPath.length > 0) {
    if (exists(opts.binaryPath)) return opts.binaryPath;
    return null;
  }

  // 2. PATH walk. We don't shell out to `which` — that's another
  // spawn the plan forbids anywhere outside this module + adds a
  // race window. A direct directory scan is faster and deterministic.
  //
  // Pick the path flavour by the *target* platform argument (not the
  // current process's platform). This keeps unit tests deterministic
  // on a linux CI box when asserting the win32 PATHEXT behaviour.
  const pathLib = platform === 'win32' ? win32 : posix;
  const exe = platform === 'win32' ? 'openclaw.exe' : 'openclaw';
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  if (pathVar.length > 0) {
    const parts = pathVar.split(pathLib.delimiter);
    for (const dir of parts) {
      if (!dir) continue;
      const candidate = pathLib.isAbsolute(dir) ? pathLib.join(dir, exe) : null;
      if (candidate && exists(candidate)) return candidate;
    }
  }

  // 3. Well-known install locations.
  for (const fallback of DEFAULT_FALLBACK_PATHS) {
    if (exists(fallback)) return fallback;
  }

  return null;
}

/**
 * Run `openclaw pairing approve clawg-ui <pairingCode>` against the
 * resolved binary. Returns a structured result; never throws on
 * non-zero exit codes — the caller decides whether to surface them.
 *
 * Per P11B's anti-pattern list: this spawn does NOT pass `shell: true`.
 * Args are arrays so a future pairing code that snuck past the regex
 * still can't inject shell metacharacters.
 */
export async function runClawgUiPairingApprove(
  options: ApprovePairingOptions,
): Promise<ApprovePairingResult> {
  const { pairingCode } = options;
  if (!PAIRING_CODE_PATTERN.test(pairingCode)) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      binaryPath: '',
      error: `Refusing to spawn: pairing code "${pairingCode}" does not match ${PAIRING_CODE_PATTERN}`,
    };
  }

  const binaryPath = resolveOpenClawBinary({
    binaryPath: options.binaryPath,
    env: options.env,
    platform: options.platform,
    pathExists: options.pathExists,
  });
  if (!binaryPath) {
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: null,
      binaryPath: '',
      error:
        'Could not find the `openclaw` CLI on $PATH or in a well-known location. ' +
        'Install it via `npm install -g @openclaw/cli` (or set the binary path in Settings) and try again.',
    };
  }

  const spawnImpl = options.spawnFn ?? (spawn as unknown as SpawnFn);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<ApprovePairingResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killed = false;

    const child = spawnImpl(binaryPath, ['pairing', 'approve', 'clawg-ui', pairingCode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore — `close` will still fire with a non-zero exit.
      }
    }, timeoutMs);

    const settle = (result: ApprovePairingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      settle({
        ok: false,
        stdout,
        stderr,
        exitCode: null,
        binaryPath,
        error: `Failed to spawn ${binaryPath}: ${err.message}`,
      });
    });
    child.on('close', (code) => {
      const exitCode = code;
      const baseError = killed ? `Timed out after ${timeoutMs}ms` : undefined;
      settle({
        ok: !killed && exitCode === 0,
        stdout,
        stderr,
        exitCode,
        binaryPath,
        ...(baseError ? { error: baseError } : {}),
      });
    });
  });
}
