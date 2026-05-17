// Root layout for the Expo Router app. Per `.chalk/plan.md` §6, this is
// where `CopilotKit` / `GatewayProvider` / theme / query wrappers live.
//
// - `PairingProvider` owns the reducer + active GatewayClient.
// - A short-lived `<Redirect>` enforces the gating rule: an unpaired user
//   always lands inside the `(pairing)` group; once `state.status === "paired"`
//   the same redirect rule sends them into `(tabs)`.
//
// P04A adds the global "Can't reach your Mac" banner — it lives above the
// `Stack` so it survives navigation between the pairing flow and the tabs
// group. Visibility is driven by the reconnect state machine that the
// `PairingProvider` exposes from the active `RealGateway`.
//
// P05A wraps the *paired* subtree in `<CopilotKitProvider>` so screens
// under `(tabs)/*` can call `useCopilotKit()` + `useCopilotAction()`
// + `useCopilotReadable()`. The provider only mounts once we have a
// runtime URL + token in hand — before pairing it has nothing to wrap.
//
// P08A adds push registration + the notification handlers. They live
// alongside the gating logic here (rather than inside `PairingProvider`)
// so the side effects of "ask for Expo push token" + "subscribe to taps"
// only run after the layout has mounted the router — `useRouter()` in the
// response handler depends on being inside an Expo Router tree.

import { Redirect, Slot, Stack, useRouter, useSegments } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Platform, SafeAreaView, StyleSheet, View } from 'react-native';

import { ClawgUiPairingProvider } from '../src/clawgUi/ClawgUiPairingProvider';
import { ReconnectBanner } from '../src/components/ReconnectBanner';
import { CopilotKitProvider } from '../src/copilot/CopilotKitProvider';
import { resolveRuntimeUrl } from '../src/copilot/runtimeUrl';
import { RealGateway } from '../src/openclaw/gateway';
import { PairingProvider, usePairing } from '../src/pairing/PairingProvider';
import { attachNotificationResponseHandler, setupNotificationHandler } from '../src/push/handler';
import { usePushRegistration } from '../src/push/usePushRegistration';
import { colors } from '../src/theme';

/**
 * Inner component that has access to `usePairing()`. Split out from
 * `RootLayout` so the provider can wrap it.
 */
function Gate() {
  const { state, reconnect, gateway } = usePairing();
  const router = useRouter();
  // `useSegments` returns the active route segments, e.g.
  // `["(pairing)", "welcome"]` or `["(tabs)", "index"]`. We need this to
  // avoid redirect loops — only redirect when the user is in the "wrong"
  // group for their current pairing state.
  const segments = useSegments();
  const inPairingGroup = segments[0] === '(pairing)';
  const inTabsGroup = segments[0] === '(tabs)';

  // P08A — register for Expo push notifications whenever a fresh paired
  // session lands, and subscribe to notification taps so the user lands
  // on the right thread. The hook + setup helpers are no-ops on web.
  usePushRegistration();
  useEffect(() => {
    const isWeb = Platform.OS === 'web';
    const detachResponses = attachNotificationResponseHandler({ router, isWeb });
    const detachForeground = setupNotificationHandler({ isWeb });
    return () => {
      detachResponses();
      detachForeground();
    };
  }, [router]);

  // Open the WS once the user is paired. Idempotent — `connect()` ignores
  // repeat calls when there's already a live socket. We do this in an
  // effect so a stale paired state doesn't kick off a connect storm on
  // every render. Mock gateways are skipped (the mock has no WS).
  const token = state.status === 'paired' ? state.token?.value : undefined;
  useEffect(() => {
    if (state.status !== 'paired') return;
    if (!token) return;
    if (!(gateway instanceof RealGateway)) return;
    if (gateway._getCurrentToken()) return; // already connected
    void gateway.connect(token).catch(() => {
      // Errors surface via the reconnect controller's offline state —
      // the banner picks them up. Nothing to do here.
    });
  }, [state.status, token, gateway]);

  // Build the CopilotKit runtime config. Memoized so the provider
  // doesn't re-mount on unrelated re-renders (a re-mount would drop the
  // action/readable registry mid-stream).
  const copilotConfig = useMemo<{ runtimeUrl: string; token: string } | null>(() => {
    if (state.status !== 'paired') return null;
    if (!state.token?.value) return null;
    try {
      const runtimeUrl = resolveRuntimeUrl({
        ...(state.runtimeUrl ? { runtimeUrl: state.runtimeUrl } : {}),
        ...(state.httpBase ? { httpBase: state.httpBase } : {}),
      });
      return { runtimeUrl, token: state.token.value };
    } catch {
      // No runtime URL or httpBase — paired session is in an inconsistent
      // state (older build that didn't persist them). The user will need
      // to re-pair. We render without the provider so the tabs still
      // load; the chat screen will throw a friendlier error.
      return null;
    }
  }, [state.status, state.runtimeUrl, state.httpBase, state.token?.value]);

  if (state.status === 'paired' && inPairingGroup) {
    return <Redirect href="/(tabs)" />;
  }
  if (state.status !== 'paired' && inTabsGroup) {
    return <Redirect href="/(pairing)/welcome" />;
  }

  // No mismatch: render the normal stack. The `(pairing)` and `(tabs)`
  // groups each own their inner layout (`(tabs)/_layout.tsx` provides the
  // tab bar; `(pairing)/_layout.tsx` provides a header-less stack).
  const stackContent = (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(pairing)" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );

  return (
    <SafeAreaView style={styles.root}>
      {/*
       * Banner first so it sits at the top of every screen. The component
       * returns `null` when nothing is wrong (mock gateway, fresh
       * `connected` state, etc.) — no visible chrome cost in the happy path.
       */}
      <ReconnectBanner state={reconnect} />
      <View style={styles.body}>
        {copilotConfig ? (
          <CopilotKitProvider runtimeUrl={copilotConfig.runtimeUrl} token={copilotConfig.token}>
            {stackContent}
          </CopilotKitProvider>
        ) : (
          stackContent
        )}
      </View>
    </SafeAreaView>
  );
}

// Re-export `Slot` so the Expo Router type-check stays happy when this
// module is imported — `Slot` is exported by `expo-router` but only the
// `Stack` is used directly here. Keeping the import in scope means the
// router treats this file as a layout, and a future plan that swaps in
// `<Slot />` instead of `<Stack />` only needs to change one line.
void Slot;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
});

export default function RootLayout() {
  return (
    <PairingProvider>
      <ClawgUiPairingProvider>
        <Gate />
      </ClawgUiPairingProvider>
    </PairingProvider>
  );
}
