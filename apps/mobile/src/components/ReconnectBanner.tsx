// "Can't reach your Mac" banner.
//
// Mounted once at the root from `app/_layout.tsx`. Reads the reconnect-state
// snapshot the `PairingProvider` exposes (which itself comes from the
// `RealGateway`'s `ReconnectController`). Visibility rules per the plan:
//
//   - hidden when there's no live socket session (mock gateway or pre-pairing),
//   - hidden when `kind === 'connected'`,
//   - hidden when `kind === 'connecting'` (initial handshake — no drama yet),
//   - shown when `kind === 'offline'`,
//   - shown when `kind === 'reconnecting'` *and* we've been in that state
//     for longer than 5s. The threshold matches the plan's "flash on every
//     transient blip" anti-goal.
//
// The 5s grace period is implemented with a `setTimeout`-driven re-render
// scheduled from a `useEffect`; we deliberately do NOT poll on every tick.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ReconnectState } from '../openclaw/gateway';
import { colors, fontSize, radius, spacing } from '../theme';

/** Wait this long after `reconnecting` starts before flashing the banner. */
export const RECONNECTING_GRACE_MS = 5_000;

/** Pure function — decides whether to render given a state + current clock. */
export function shouldShowBanner(state: ReconnectState | null, now: number): boolean {
  if (!state) return false;
  if (state.kind === 'connected' || state.kind === 'connecting') return false;
  if (state.kind === 'offline') return true;
  // `reconnecting` — show only after the grace period.
  return now - state.since >= RECONNECTING_GRACE_MS;
}

/** Banner message variants. */
function bannerCopy(state: ReconnectState): { label: string; hint: string } {
  if (state.kind === 'offline') {
    return {
      label: "Can't reach your Mac",
      hint:
        state.lastError && state.lastError !== 'stopped'
          ? state.lastError
          : 'We will keep trying in the background.',
    };
  }
  // reconnecting > 5s
  return {
    label: 'Reconnecting…',
    hint: state.lastError ? state.lastError : 'Working on getting you back online.',
  };
}

export interface ReconnectBannerProps {
  state: ReconnectState | null;
  /** Override for tests so we can step time deterministically. */
  now?: () => number;
}

/**
 * Render the banner if the reconnect state warrants it. Returns `null`
 * otherwise so the layout above it shifts in/out without an empty View.
 */
export function ReconnectBanner({
  state,
  now = Date.now,
}: ReconnectBannerProps): React.ReactElement | null {
  // Re-render once the grace period elapses so the banner shows up without
  // any external state change. We only schedule the timer while in
  // `reconnecting` and within the grace window.
  const [, force] = useState(0);
  useEffect(() => {
    if (!state) return;
    if (state.kind !== 'reconnecting') return;
    const elapsed = now() - state.since;
    if (elapsed >= RECONNECTING_GRACE_MS) return;
    const id = setTimeout(() => {
      force((n) => n + 1);
    }, RECONNECTING_GRACE_MS - elapsed);
    return () => clearTimeout(id);
  }, [state, now]);

  if (!shouldShowBanner(state, now())) return null;
  // `state` is non-null when shouldShowBanner returns true.
  const copy = bannerCopy(state as ReconnectState);

  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.banner,
        (state as ReconnectState).kind === 'offline' ? styles.bannerOffline : styles.bannerWarn,
      ]}
      testID="reconnect-banner"
    >
      <Text style={styles.bannerLabel}>{copy.label}</Text>
      <Text style={styles.bannerHint}>{copy.hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    gap: spacing.xs,
    margin: spacing.sm,
  },
  bannerWarn: {
    backgroundColor: '#3a2a14',
    borderColor: '#d9a14a',
    borderWidth: 1,
  },
  bannerOffline: {
    backgroundColor: '#3a1414',
    borderColor: colors.danger,
    borderWidth: 1,
  },
  bannerLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  bannerHint: { color: colors.muted, fontSize: fontSize.xs },
});
