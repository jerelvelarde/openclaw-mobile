// Root layout for the Expo Router app. Per `.chalk/plan.md` §6, this is
// where `CopilotKit` / `GatewayProvider` / theme / query wrappers will live
// once those packages land (P05+). For P03A we ship the pairing-aware shell:
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

import { Redirect, Stack, useSegments } from 'expo-router';
import { SafeAreaView, StyleSheet, View } from 'react-native';

import { ReconnectBanner } from '../src/components/ReconnectBanner';
import { PairingProvider, usePairing } from '../src/pairing/PairingProvider';
import { colors } from '../src/theme';

/**
 * Inner component that has access to `usePairing()`. Split out from
 * `RootLayout` so the provider can wrap it.
 */
function Gate() {
  const { state, reconnect } = usePairing();
  // `useSegments` returns the active route segments, e.g.
  // `["(pairing)", "welcome"]` or `["(tabs)", "index"]`. We need this to
  // avoid redirect loops — only redirect when the user is in the "wrong"
  // group for their current pairing state.
  const segments = useSegments();
  const inPairingGroup = segments[0] === '(pairing)';
  const inTabsGroup = segments[0] === '(tabs)';

  if (state.status === 'paired' && inPairingGroup) {
    return <Redirect href="/(tabs)" />;
  }
  if (state.status !== 'paired' && inTabsGroup) {
    return <Redirect href="/(pairing)/welcome" />;
  }

  // No mismatch: render the normal stack. The `(pairing)` and `(tabs)`
  // groups each own their inner layout (`(tabs)/_layout.tsx` provides the
  // tab bar; `(pairing)/_layout.tsx` provides a header-less stack).
  return (
    <SafeAreaView style={styles.root}>
      {/*
       * Banner first so it sits at the top of every screen. The component
       * returns `null` when nothing is wrong (mock gateway, fresh
       * `connected` state, etc.) — no visible chrome cost in the happy path.
       */}
      <ReconnectBanner state={reconnect} />
      <View style={styles.body}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(pairing)" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1 },
});

export default function RootLayout() {
  return (
    <PairingProvider>
      <Gate />
    </PairingProvider>
  );
}
