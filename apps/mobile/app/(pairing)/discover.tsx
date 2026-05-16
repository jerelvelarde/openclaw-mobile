// Pairing — discover screen.
//
// P04A: real Bonjour browse via `react-native-zeroconf` (wrapped in
// `src/openclaw/transport/bonjour.ts`). Tap a host → kicks off the real
// HTTP pairing flow against `httpBase`. Below the list lives the
// "Paste URL" fallback for Tailscale / ngrok / remote hosts.
//
// Web fallback: the bonjour wrapper returns a no-op on web, so the list
// stays empty there and the user uses the paste-URL input. That matches
// the v1 reachability tiers in `.chalk/plan.md` §3.

import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { browse, resolveHttpBase, type DiscoveredHost } from '../../src/openclaw/gateway';
import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';

/**
 * Debounce window for emitting a fresh list. Bonjour resolves can arrive in
 * bursts (e.g. on a switch between cellular and Wi-Fi) — we coalesce a few
 * frames worth so we re-render once instead of N times.
 */
const DISCOVERY_DEBOUNCE_MS = 200;

export default function PairingDiscoverScreen() {
  const router = useRouter();
  const { state, selectHost, error } = usePairing();

  /**
   * Map of `host.id → DiscoveredHost`. We keep a stable record vs. an array
   * so onFound/onLost can be O(1) and so React's list keying stays
   * predictable across rapid Bonjour updates.
   */
  const [hosts, setHosts] = useState<Record<string, DiscoveredHost>>({});
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);

  // Pending host map mutated synchronously by the bonjour callbacks. We
  // commit it into React state on a debounce so a burst of events
  // produces a single render. The ref pattern (vs. setState in the
  // callback) keeps the debounce simple — we don't need any closures over
  // the prior `hosts` value.
  const pending = useRef<Record<string, DiscoveredHost>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pending.current = {};
    const flush = () => {
      debounceRef.current = null;
      setHosts({ ...pending.current });
    };
    const queueFlush = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(flush, DISCOVERY_DEBOUNCE_MS);
    };

    const unsub = browse({
      onFound: (host) => {
        pending.current[host.id] = host;
        queueFlush();
      },
      onLost: (id) => {
        delete pending.current[id];
        queueFlush();
      },
      // Errors from the native browser are surfaced via the pairing
      // reducer's `error` so the existing error row picks them up. We
      // don't dispatch FAILED — discovery is best-effort, and falling
      // back to the paste-URL flow is always available.
      onError: () => {
        /* swallow — the empty list is signal enough */
      },
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      unsub();
    };
  }, []);

  // Once the gateway issues a code, advance to the code screen. Doing this
  // in an effect (vs. inline after `selectHost`) keeps the navigation
  // reactive to state changes — if a re-render happens mid-flight, we
  // still navigate.
  useEffect(() => {
    if (state.status === 'awaiting_approval') {
      router.push('/(pairing)/code');
    }
  }, [state.status, router]);

  const onSelectHost = async (host: DiscoveredHost) => {
    await selectHost(host.id, 'OpenClaw mobile', host.httpBase);
  };

  const onSubmitPasteUrl = async () => {
    setPasteError(null);
    if (!pasteUrl.trim()) {
      setPasteError('Enter a URL to pair manually');
      return;
    }
    let httpBase: string;
    try {
      httpBase = resolveHttpBase(pasteUrl);
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : 'Invalid URL');
      return;
    }
    await selectHost(`pasted:${httpBase}`, 'OpenClaw mobile', httpBase);
  };

  const isBusy = state.status === 'requesting' || state.status === 'awaiting_approval';
  const hostList = useMemo(() => Object.values(hosts), [hosts]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      testID="pairing-discover"
    >
      <View style={styles.header}>
        <Text style={styles.title}>Pick your Mac</Text>
        <Text style={styles.paragraph}>
          We&apos;ll show you a 6-digit code, then ask you to approve it in the desktop app.
        </Text>
      </View>

      <View style={styles.hostList}>
        {hostList.length === 0 ? (
          <Text style={styles.emptyHint} testID="pairing-discover-empty">
            Searching for Macs on this Wi-Fi…
          </Text>
        ) : (
          hostList.map((host) => (
            <Pressable
              key={host.id}
              accessibilityRole="button"
              style={[styles.hostRow, isBusy && styles.hostRowBusy]}
              disabled={isBusy}
              onPress={() => {
                void onSelectHost(host);
              }}
              testID={`pairing-discover-host-${host.id}`}
            >
              <View style={styles.hostMeta}>
                <Text style={styles.hostName}>{host.name}</Text>
                <Text style={styles.hostHint}>
                  {host.host}:{host.port}
                </Text>
              </View>
              <Text style={styles.hostAction}>{isBusy ? 'Requesting…' : 'Pair'}</Text>
            </Pressable>
          ))
        )}
      </View>

      {error ? (
        <Text style={styles.error} testID="pairing-discover-error">
          {error}
        </Text>
      ) : null}

      <View style={styles.pasteBlock}>
        <Text style={styles.pasteLabel}>Or paste a gateway URL</Text>
        <TextInput
          value={pasteUrl}
          onChangeText={setPasteUrl}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isBusy}
          keyboardType="url"
          placeholder="http://mac-mini.local:18789 or https://…"
          placeholderTextColor={colors.muted}
          style={styles.pasteInput}
          testID="pairing-discover-paste"
        />
        <Pressable
          accessibilityRole="button"
          disabled={isBusy}
          onPress={() => {
            void onSubmitPasteUrl();
          }}
          style={[styles.pasteButton, isBusy && styles.hostRowBusy]}
          testID="pairing-discover-paste-submit"
        >
          <Text style={styles.pasteButtonLabel}>Pair via URL</Text>
        </Pressable>
        {pasteError ? (
          <Text style={styles.error} testID="pairing-discover-paste-error">
            {pasteError}
          </Text>
        ) : null}
        <Text style={styles.pasteHint}>
          Use this for Tailscale MagicDNS, ngrok, or any non-LAN host.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.bg },
  container: { padding: spacing.lg, gap: spacing.lg },
  header: { gap: spacing.sm, marginTop: spacing.lg },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '600' },
  paragraph: { color: colors.muted, fontSize: fontSize.md, lineHeight: 22 },
  hostList: { gap: spacing.sm },
  emptyHint: { color: colors.muted, fontSize: fontSize.sm },
  hostRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  hostRowBusy: { opacity: 0.6 },
  hostMeta: { flexShrink: 1, paddingRight: spacing.sm },
  hostName: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  hostHint: { color: colors.muted, fontSize: fontSize.xs, marginTop: spacing.xs },
  hostAction: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
  error: { color: colors.danger, fontSize: fontSize.sm },
  pasteBlock: { gap: spacing.sm, marginTop: spacing.lg },
  pasteLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '600' },
  pasteInput: {
    borderColor: colors.muted,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.text,
    fontSize: fontSize.md,
  },
  pasteButton: {
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
  },
  pasteButtonLabel: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
  pasteHint: { color: colors.muted, fontSize: fontSize.xs },
});
