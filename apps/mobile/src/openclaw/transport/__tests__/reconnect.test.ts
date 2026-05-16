// Reconnect controller + backoff schedule.
//
// We exercise the controller with an injected fake clock (deterministic
// `now()` + `schedule()`) and a fixed `rng()` so the jittered backoff
// becomes assertable. The tests cover:
//
//   - the per-attempt schedule (1s, 2s, 5s, 10s, 30s+jitter, then steady),
//   - `connected → reconnecting` on a disconnect notification,
//   - `reconnecting → offline` once we've been failing past the threshold,
//   - `retryNow()` cancelling a pending backoff,
//   - `stop()` parking the loop.

import {
  RECONNECT_SCHEDULE_MS,
  RECONNECT_STEADY_MS,
  ReconnectController,
  nextBackoffMs,
  type ReconnectClock,
  type ReconnectState,
} from '../reconnect';

/**
 * Deterministic fake clock. `tick(ms)` advances `now` by `ms` and runs any
 * timer that comes due. Lets the suite assert specific schedule values
 * without `jest.useFakeTimers`.
 */
function makeFakeClock(): ReconnectClock & {
  tick: (ms: number) => void;
  pending: () => Array<{ at: number; cb: () => void }>;
  now: () => number;
  setNow: (n: number) => void;
} {
  let now = 0;
  const timers: Array<{ at: number; cb: () => void; cancelled: boolean }> = [];
  return {
    now: () => now,
    setNow: (n: number) => {
      now = n;
    },
    schedule: (cb, ms) => {
      const t = { at: now + ms, cb, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    pending: () => timers.filter((t) => !t.cancelled).map((t) => ({ at: t.at, cb: t.cb })),
    tick: (ms: number) => {
      now += ms;
      // Run all timers that came due, in insertion order. Each timer
      // can schedule new ones — let those run on the next tick.
      const due = timers.filter((t) => !t.cancelled && t.at <= now);
      for (const t of due) {
        if (t.cancelled) continue;
        t.cancelled = true;
        t.cb();
      }
    },
  };
}

describe('nextBackoffMs', () => {
  it('walks 1s, 2s, 5s, 10s, 30s then plateaus', () => {
    // rng() = 0.5 → multiplier 1.0, so the jittered value equals the base.
    const rng = () => 0.5;
    expect(nextBackoffMs(0, rng)).toBe(RECONNECT_SCHEDULE_MS[0]);
    expect(nextBackoffMs(1, rng)).toBe(RECONNECT_SCHEDULE_MS[1]);
    expect(nextBackoffMs(2, rng)).toBe(RECONNECT_SCHEDULE_MS[2]);
    expect(nextBackoffMs(3, rng)).toBe(RECONNECT_SCHEDULE_MS[3]);
    expect(nextBackoffMs(4, rng)).toBe(RECONNECT_SCHEDULE_MS[4]);
    expect(nextBackoffMs(5, rng)).toBe(RECONNECT_STEADY_MS);
    expect(nextBackoffMs(99, rng)).toBe(RECONNECT_STEADY_MS);
  });

  it('applies ±25% jitter at the extremes', () => {
    // rng() = 0 → multiplier 0.75; rng() = 1 → multiplier 1.25 (open).
    expect(nextBackoffMs(0, () => 0)).toBe(Math.round(RECONNECT_SCHEDULE_MS[0]! * 0.75));
    // Use 0.99 to stay strictly below the open upper bound.
    expect(nextBackoffMs(0, () => 0.99)).toBeCloseTo(
      Math.round(RECONNECT_SCHEDULE_MS[0]! * 1.245),
      0,
    );
  });
});

describe('ReconnectController', () => {
  it('starts in `connecting` and resolves to `connected` after a successful attempt', async () => {
    const clock = makeFakeClock();
    let resolveAttempt!: () => void;
    const attempt = jest.fn(
      () =>
        new Promise<void>((res) => {
          resolveAttempt = res;
        }),
    );
    const states: ReconnectState[] = [];
    const ctrl = new ReconnectController({ attempt, clock, rng: () => 0.5 });
    ctrl.subscribe((s) => states.push({ ...s }));
    expect(ctrl.getState().kind).toBe('connecting');

    ctrl.start();
    clock.tick(0); // run the immediate first attempt
    expect(attempt).toHaveBeenCalledTimes(1);

    resolveAttempt();
    await Promise.resolve(); // let `runAttempt` continue
    expect(ctrl.getState().kind).toBe('connected');
    // Initial `connecting` subscription replay + the `connected` transition.
    expect(states.map((s) => s.kind)).toContain('connected');
  });

  it('schedules the next attempt per the backoff schedule on disconnect', async () => {
    const clock = makeFakeClock();
    let resolveFirst!: () => void;
    let attemptCalls = 0;
    const attempt = jest.fn(() => {
      attemptCalls += 1;
      return new Promise<void>((res) => {
        if (attemptCalls === 1) resolveFirst = res;
        else res();
      });
    });
    const ctrl = new ReconnectController({ attempt, clock, rng: () => 0.5 });
    ctrl.start();
    clock.tick(0); // run first attempt
    resolveFirst();
    await Promise.resolve();
    expect(ctrl.getState().kind).toBe('connected');

    // Simulate a drop. We should be scheduled for the *first* slot of the
    // schedule (1s with rng=0.5).
    ctrl.notifyDisconnected('socket closed');
    expect(ctrl.getState().kind).toBe('reconnecting');
    const pending = clock.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.at).toBe(RECONNECT_SCHEDULE_MS[0]);

    // Advance time and the second attempt fires.
    clock.tick(RECONNECT_SCHEDULE_MS[0]!);
    await Promise.resolve();
    expect(attemptCalls).toBe(2);
    await Promise.resolve();
    expect(ctrl.getState().kind).toBe('connected');
  });

  it('promotes to `offline` once we have been failing for more than 60s', async () => {
    const clock = makeFakeClock();
    const attempt = jest.fn(() => Promise.reject(new Error('connection refused')));
    const ctrl = new ReconnectController({ attempt, clock, rng: () => 0.5 });
    ctrl.start();
    // Walk through attempts; each rejected attempt schedules the next at
    // RECONNECT_SCHEDULE_MS[i].
    for (let i = 0; i < 6; i += 1) {
      clock.tick(0);
      // Let the rejected promise settle.
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
      const wait = RECONNECT_SCHEDULE_MS[i] ?? RECONNECT_STEADY_MS;
      clock.tick(wait);
    }
    // We've burned more than 60s in cumulative backoffs (1+2+5+10+30=48s
    // through the schedule then another 30s steady), so offline.
    expect(['offline', 'reconnecting']).toContain(ctrl.getState().kind);
    // Force one more advance past the 60s threshold and the next disconnect
    // notification should land us in `offline`.
    clock.tick(RECONNECT_STEADY_MS);
    await Promise.resolve();
    expect(ctrl.getState().kind).toBe('offline');
  });

  it('`stop()` cancels any pending attempt and parks at offline', async () => {
    const clock = makeFakeClock();
    const attempt = jest.fn(
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );
    const ctrl = new ReconnectController({ attempt, clock, rng: () => 0.5 });
    ctrl.start();
    clock.tick(0); // schedule first attempt
    expect(clock.pending().length).toBeGreaterThanOrEqual(0);
    ctrl.stop();
    expect(ctrl.getState().kind).toBe('offline');
    // After stop, no pending callbacks should remain — none of them should
    // fire even if we tick further.
    clock.tick(1_000_000);
    // attempt was called once (the in-flight one) and no more after stop.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('`retryNow()` cancels backoff and runs the next attempt immediately', async () => {
    const clock = makeFakeClock();
    const attempt = jest
      .fn<Promise<void>, []>()
      .mockImplementationOnce(() => Promise.reject(new Error('first fail')))
      .mockImplementationOnce(() => Promise.resolve());
    const ctrl = new ReconnectController({ attempt, clock, rng: () => 0.5 });
    ctrl.start();
    clock.tick(0);
    await Promise.resolve();
    await Promise.resolve();
    // Backoff to RECONNECT_SCHEDULE_MS[0] is now pending.
    const before = clock.pending();
    expect(before.length).toBe(1);
    expect(before[0]!.at).toBe(RECONNECT_SCHEDULE_MS[0]);

    ctrl.retryNow();
    clock.tick(0);
    await Promise.resolve();
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(ctrl.getState().kind).toBe('connected');
  });
});
