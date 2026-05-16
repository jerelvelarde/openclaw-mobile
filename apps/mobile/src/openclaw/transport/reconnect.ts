// Reconnect state machine + backoff scheduler.
//
// `ReconnectController` wraps `openSocket` from `ws.ts` and decides:
//
//   - when to attempt a fresh connection (the backoff schedule below),
//   - what to expose to the UI (the "Can't reach your Mac" banner reads
//     `state.kind` and `state.since` to decide whether to show),
//   - and how to terminate a reconnect loop (manual `stop()`, the user
//     re-pairs, or the token expires).
//
// The schedule is intentional: tight at first (1s, 2s) so a flaky LAN
// transition (e.g. switching SSIDs) heals before the user even notices,
// looser later (5s, 10s, 30s capped) so we don't burn battery while the
// phone is offline. ±25% jitter keeps us from synchronizing with anything
// else doing the same thing.

/** Coarse-grained connection state the UI surfaces in the banner. */
export type ReconnectStateKind = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/**
 * Full state snapshot. `since` is epoch ms of the last transition into the
 * current state; the banner uses it to decide whether to show (only after
 * `reconnecting > 5s` to avoid flashing on every transient blip).
 */
export interface ReconnectState {
  kind: ReconnectStateKind;
  /** Epoch ms when the controller entered the current `kind`. */
  since: number;
  /** Number of consecutive failed connect attempts since the last success. */
  attempt: number;
  /** Last close/error info; null if we've never been disconnected. */
  lastError?: string;
}

/** Listeners observe state transitions. Re-fires on every `kind` change. */
export type ReconnectListener = (state: ReconnectState) => void;

/**
 * Backoff schedule per the plan: 1s, 2s, 5s, 10s, 30s (and stay at 30s).
 * We add ±25% jitter at apply-time so two phones reconnecting after a
 * router blip don't sync up.
 */
export const RECONNECT_SCHEDULE_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Used once the schedule is exhausted. */
export const RECONNECT_STEADY_MS = 30_000;

/**
 * Return the next backoff delay in ms with jitter applied. Exposed so the
 * tests can assert the schedule deterministically by passing a fixed RNG.
 */
export function nextBackoffMs(
  attempt: number,
  rng: () => number = Math.random,
  schedule: readonly number[] = RECONNECT_SCHEDULE_MS,
  steady: number = RECONNECT_STEADY_MS,
): number {
  const base = attempt < schedule.length ? (schedule[attempt] ?? steady) : steady;
  // ±25% jitter: multiplier in [0.75, 1.25). Avoids the all-clients-at-once
  // thundering herd against a freshly-rebooted desktop.
  const jitter = 0.75 + rng() * 0.5;
  return Math.round(base * jitter);
}

/** Injection for the timer + clock so tests can drive the loop with fake timers. */
export interface ReconnectClock {
  now: () => number;
  /** Returns a cancel function so the controller can abort a pending attempt. */
  schedule: (cb: () => void, ms: number) => () => void;
}

/** Production clock — wraps `Date.now` + `setTimeout`. */
export const realClock: ReconnectClock = {
  now: () => Date.now(),
  schedule: (cb, ms) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

/** Caller-supplied attempt function; resolves on connect, rejects on failure. */
export type ConnectAttempt = (signal: { cancelled: boolean }) => Promise<void>;

/** Options for `ReconnectController`. */
export interface ReconnectControllerOptions {
  /** Run one connect attempt. Resolves on success, rejects on failure. */
  attempt: ConnectAttempt;
  /** Override the clock for tests. */
  clock?: ReconnectClock;
  /** Override the RNG used for jitter. */
  rng?: () => number;
  /** Override the schedule (for tests + future "aggressive reconnect" mode). */
  schedule?: readonly number[];
  /** Override the steady-state interval. */
  steadyMs?: number;
}

/**
 * Owns the reconnect loop. Lifecycle:
 *
 *   `start()`  → kicks off the first attempt; flips to `connecting`.
 *   `attempt` resolves → `connected`. Listeners fire.
 *   `notifyDisconnected(reason)` → flips to `reconnecting` + schedules the
 *     next attempt per `nextBackoffMs(attempt)`.
 *   After 60s of consecutive failure we transition `reconnecting → offline`
 *     (UI banner shows; we keep retrying but stop spamming notifications).
 *   `stop()` cancels any pending attempt and parks at `offline` with no
 *     scheduled work.
 *
 * The controller is host-agnostic; the caller's `attempt` decides which
 * URL + token to use. That matches the plan's "reconnect should be
 * token-bound, not host-bound" constraint.
 */
export class ReconnectController {
  /** Threshold after which `reconnecting` is promoted to `offline`. */
  static readonly OFFLINE_AFTER_MS = 60_000;

  private state: ReconnectState;
  private listeners = new Set<ReconnectListener>();
  private cancelPending: (() => void) | null = null;
  private stopped = false;
  private readonly opts: Required<Omit<ReconnectControllerOptions, 'attempt' | 'rng'>> & {
    attempt: ConnectAttempt;
    rng: () => number;
  };

  constructor(options: ReconnectControllerOptions) {
    this.opts = {
      attempt: options.attempt,
      clock: options.clock ?? realClock,
      rng: options.rng ?? Math.random,
      schedule: options.schedule ?? RECONNECT_SCHEDULE_MS,
      steadyMs: options.steadyMs ?? RECONNECT_STEADY_MS,
    };
    this.state = { kind: 'connecting', since: this.opts.clock.now(), attempt: 0 };
  }

  /** Current state snapshot. Safe to read at any time. */
  getState(): ReconnectState {
    return this.state;
  }

  /** Subscribe to state transitions. Listener fires immediately with current state. */
  subscribe(listener: ReconnectListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Kick off the first attempt. Idempotent — calling twice is a no-op if
   * we're already trying to connect.
   */
  start(): void {
    if (this.stopped) {
      this.stopped = false;
    }
    if (this.cancelPending) return;
    this.transition('connecting');
    this.scheduleAttempt(0);
  }

  /** Cancel any pending attempt and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.cancelPending) {
      this.cancelPending();
      this.cancelPending = null;
    }
    if (this.state.kind !== 'offline') {
      this.transition('offline', 'stopped');
    }
  }

  /**
   * Caller signals that the live socket dropped. We bump the attempt
   * counter, mark `reconnecting`, and schedule the next attempt. If a
   * reconnect is already pending we ignore the call (the new socket would
   * just race the existing schedule).
   */
  notifyDisconnected(reason: string): void {
    if (this.stopped) return;
    if (this.cancelPending) return;
    // We only bump the attempt counter when we were previously connected;
    // failures during the connecting handshake are counted by `scheduleAttempt`.
    const nextAttempt = this.state.kind === 'connected' ? 1 : this.state.attempt + 1;
    this.state = { ...this.state, attempt: nextAttempt, lastError: reason };
    this.maybePromoteToOffline(reason);
    if (this.state.kind !== 'offline') {
      this.transition('reconnecting', reason);
    }
    this.scheduleAttempt(nextAttempt);
  }

  /**
   * Force an immediate retry — used by the "Retry" affordance in the banner.
   * Cancels any pending backoff and runs the next attempt right away.
   */
  retryNow(): void {
    if (this.stopped) return;
    if (this.cancelPending) {
      this.cancelPending();
      this.cancelPending = null;
    }
    this.scheduleAttempt(this.state.attempt, 0);
  }

  /** Internals ------------------------------------------------------------- */

  private transition(kind: ReconnectStateKind, lastError?: string): void {
    if (this.state.kind === kind) return;
    this.state = {
      ...this.state,
      kind,
      since: this.opts.clock.now(),
      lastError: lastError ?? this.state.lastError,
    };
    for (const l of this.listeners) l(this.state);
  }

  private maybePromoteToOffline(reason: string): void {
    if (this.state.kind === 'offline') return;
    // Promote to `offline` once we've been failing for longer than the
    // threshold OR once we've burned through the entire jittered schedule.
    const beenFailingFor = this.opts.clock.now() - this.state.since;
    if (
      beenFailingFor >= ReconnectController.OFFLINE_AFTER_MS &&
      this.state.kind === 'reconnecting'
    ) {
      this.transition('offline', reason);
    }
  }

  private scheduleAttempt(attempt: number, overrideMs?: number): void {
    if (this.stopped) return;
    const delay =
      overrideMs ??
      (attempt === 0
        ? 0
        : nextBackoffMs(attempt - 1, this.opts.rng, this.opts.schedule, this.opts.steadyMs));
    this.cancelPending = this.opts.clock.schedule(() => {
      this.cancelPending = null;
      void this.runAttempt(attempt);
    }, delay);
  }

  private async runAttempt(attempt: number): Promise<void> {
    if (this.stopped) return;
    const signal = { cancelled: false };
    // While the attempt is in flight, store a canceler so `stop()` /
    // `retryNow()` can interrupt.
    this.cancelPending = () => {
      signal.cancelled = true;
    };
    try {
      await this.opts.attempt(signal);
      if (signal.cancelled || this.stopped) return;
      this.cancelPending = null;
      this.state = { ...this.state, attempt: 0, lastError: undefined };
      this.transition('connected');
    } catch (err) {
      if (signal.cancelled || this.stopped) return;
      this.cancelPending = null;
      const reason = err instanceof Error ? err.message : String(err);
      this.state = { ...this.state, attempt: attempt + 1, lastError: reason };
      this.maybePromoteToOffline(reason);
      if (this.state.kind !== 'offline') {
        this.transition('reconnecting', reason);
      }
      this.scheduleAttempt(attempt + 1);
    }
  }
}
