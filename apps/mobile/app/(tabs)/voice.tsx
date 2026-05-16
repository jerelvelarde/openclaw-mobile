// Voice tab — push-to-talk surface (P07A).
//
// Full-screen layout:
//
//   [ Connection status banner ]
//   [ Live transcript          ]
//   [ Agent reply caption      ]
//   [ Waveform stub            ]
//   [ Big PTT button           ]
//
// The screen owns:
//
//   - Mic permission gate (`permissions.ts`).
//   - One `VoiceSession` per visit (created on mount, closed on unmount).
//   - One `VoicePeerHandle` for the live WebRTC peer.
//   - The push-to-talk hook (`usePushToTalk`) driving the FSM + transcripts.
//
// Web fallback: `react-native-webrtc` doesn't ship for web, so we render a
// "Voice is mobile-only for v1" placeholder there. The web fallback is
// deliberately a separate codepath so the iOS/Android implementation never
// has to branch on `Platform.OS` inside the layout.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import type { VoiceSession } from '@openclaw/protocol';

import { usePairing } from '../../src/pairing/PairingProvider';
import { colors, fontSize, radius, spacing } from '../../src/theme';
import {
  MIC_PERMISSION_RATIONALE,
  getMicPermissionStatus,
  requestMicPermission,
  type MicPermissionStatus,
} from '../../src/voice/permissions';
import { usePushToTalk } from '../../src/voice/usePushToTalk';
import { openVoicePeer, type VoicePeerHandle } from '../../src/voice/webrtc';

// ── Web fallback ────────────────────────────────────────────────────────────

/**
 * Inert screen rendered on web. `react-native-webrtc` doesn't have a web
 * build that fits our v1 needs, and we explicitly scoped voice to mobile.
 * Showing a friendly placeholder is more useful than crashing on import.
 */
function VoiceWebFallback(): React.ReactElement {
  return (
    <View style={styles.fallback} testID="voice-web-fallback">
      <Text style={styles.fallbackTitle}>Voice is mobile-only for v1</Text>
      <Text style={styles.fallbackHint}>
        Push-to-talk voice runs through your phone&apos;s microphone. Open OpenClaw on iOS or
        Android to use it.
      </Text>
    </View>
  );
}

// ── Native screen ───────────────────────────────────────────────────────────

/**
 * iOS/Android implementation. Top-level export switches between this and
 * the web fallback so the import graph on web never reaches into
 * `react-native-webrtc`.
 */
function VoiceNativeScreen(): React.ReactElement {
  const { gateway, state: pairingState } = usePairing();

  const [permissionStatus, setPermissionStatus] = useState<MicPermissionStatus>('unknown');
  const [session, setSession] = useState<VoiceSession | null>(null);
  const [peer, setPeer] = useState<VoicePeerHandle | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  // Keep a ref to the latest peer so the cleanup effect closes it without
  // re-running on every state change.
  const peerRef = useRef<VoicePeerHandle | null>(null);
  useEffect(() => {
    peerRef.current = peer;
  }, [peer]);

  // ── Mic permission ────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      const initial = await getMicPermissionStatus();
      setPermissionStatus(initial);
    })();
  }, []);

  const requestPermission = async (): Promise<void> => {
    const next = await requestMicPermission({ rationale: MIC_PERMISSION_RATIONALE });
    setPermissionStatus(next);
  };

  // ── Voice session + WebRTC peer ───────────────────────────────────────────
  //
  // We require: pairing is `paired`, mic permission is `granted`. Until
  // both are true, the screen renders rationale / status copy instead.
  const canOpen = pairingState.status === 'paired' && permissionStatus === 'granted';

  useEffect(() => {
    if (!canOpen) return;
    let cancelled = false;
    let openedSession: VoiceSession | null = null;
    let openedPeer: VoicePeerHandle | null = null;
    void (async () => {
      try {
        // Cast to the narrowed `RealGateway` API surface — `GatewayClient`
        // doesn't expose `sendVoiceSignal` / `onVoiceSignal` because they're
        // mobile/desktop-app concerns, not part of the wire protocol.
        const gw = gateway as unknown as {
          openVoice: typeof gateway.openVoice;
          sendVoiceSignal?: (sessionId: string, signal: unknown) => Promise<void>;
          onVoiceSignal?: (sessionId: string, handler: (signal: unknown) => void) => () => void;
        };
        const opened = await gw.openVoice({
          agentId: 'openclaw.default',
          format: 'opus',
          sampleRate: 16000,
        });
        if (cancelled) {
          void opened.close();
          return;
        }
        openedSession = opened;
        if (!gw.sendVoiceSignal || !gw.onVoiceSignal) {
          throw new Error('Gateway does not support voice signaling');
        }
        // `RealGateway.sendVoiceSignal` already builds the envelope, so we
        // pass through directly rather than going through the standalone
        // `createVoiceSignalingAdapter` (which is exported for callers that
        // need to wire a non-`RealGateway` source — P07B agent runtime).
        const directSignaling = {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sendVoiceSignal: (sid: string, sig: any): Promise<void> =>
            gw.sendVoiceSignal!(sid, sig as never),
          onVoiceSignal: (sid: string, handler: (signal: never) => void): (() => void) =>
            gw.onVoiceSignal!(sid, handler as never),
        };
        const peerHandle = await openVoicePeer({
          sessionId: opened.id,
          opts: { agentId: opened.agentId, format: 'opus', sampleRate: 16000 },
          gateway: directSignaling,
        });
        if (cancelled) {
          await peerHandle.close();
          return;
        }
        openedPeer = peerHandle;
        setSession(opened);
        setPeer(peerHandle);
        setOpenError(null);
      } catch (err) {
        if (cancelled) return;
        setOpenError(err instanceof Error ? err.message : String(err));
      }
    })();
    return (): void => {
      cancelled = true;
      // Tear down asynchronously — closing the peer + session is best-effort.
      void (async () => {
        try {
          if (openedPeer) await openedPeer.close();
        } catch {
          /* ignore */
        }
        try {
          if (openedSession) await openedSession.close();
        } catch {
          /* ignore */
        }
      })();
      setSession(null);
      setPeer(null);
    };
  }, [canOpen, gateway]);

  // ── Push-to-talk hook ─────────────────────────────────────────────────────
  const subscribeTranscript = useMemo(() => {
    return (sid: string, handler: (frag: never) => void): (() => void) => {
      const gw = gateway as unknown as {
        onVoiceTranscript?: (sid: string, h: (t: never) => void) => () => void;
      };
      if (!gw.onVoiceTranscript) return () => undefined;
      return gw.onVoiceTranscript(sid, handler);
    };
  }, [gateway]);

  const ptt = usePushToTalk({
    sessionId: session?.id ?? null,
    peer,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscribeTranscript: subscribeTranscript as any,
  });

  // ── Waveform stub animation ───────────────────────────────────────────────
  //
  // A real DSP-driven waveform is overkill for v1. We animate a single
  // pulsing bar that scales with the FSM state so the user gets visual
  // confirmation that audio capture is on. P07B/P08 can wire a real
  // analyser when we have the bandwidth.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!ptt.isSending) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 360,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 360,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return (): void => loop.stop();
  }, [ptt.isSending, pulse]);

  const waveformScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] });

  // ── Render variants ───────────────────────────────────────────────────────
  if (pairingState.status !== 'paired') {
    return (
      <View style={styles.gate} testID="voice-needs-pairing">
        <Text style={styles.gateTitle}>Pair your Mac first</Text>
        <Text style={styles.gateHint}>
          Voice routes through the desktop gateway. Finish pairing in the Welcome flow to enable
          push-to-talk.
        </Text>
      </View>
    );
  }

  if (permissionStatus === 'unavailable') {
    return (
      <View style={styles.gate} testID="voice-mic-unavailable">
        <Text style={styles.gateTitle}>Microphone not available</Text>
        <Text style={styles.gateHint}>
          This device doesn&apos;t expose a microphone OpenClaw can capture. Try the iOS or Android
          build.
        </Text>
      </View>
    );
  }

  if (permissionStatus === 'unknown' || permissionStatus === 'denied') {
    return (
      <View style={styles.gate} testID="voice-mic-rationale">
        <Text style={styles.gateTitle}>{MIC_PERMISSION_RATIONALE.title}</Text>
        <Text style={styles.gateHint}>{MIC_PERMISSION_RATIONALE.message}</Text>
        <Pressable
          accessibilityRole="button"
          style={styles.gateButton}
          onPress={() => void requestPermission()}
          testID="voice-mic-allow"
        >
          <Text style={styles.gateButtonText}>Allow microphone</Text>
        </Pressable>
      </View>
    );
  }

  if (permissionStatus === 'blocked') {
    return (
      <View style={styles.gate} testID="voice-mic-blocked">
        <Text style={styles.gateTitle}>Microphone blocked</Text>
        <Text style={styles.gateHint}>
          OpenClaw needs the microphone permission. Open the system Settings app to grant access,
          then return here.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="voice-screen">
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>
          {ptt.state === 'idle' ? 'Idle' : null}
          {ptt.state === 'arming' ? 'Connecting…' : null}
          {ptt.state === 'listening' ? 'Hold to talk' : null}
          {ptt.state === 'sending' ? 'Listening to you' : null}
          {ptt.state === 'receiving' ? 'Agent replying' : null}
        </Text>
        {ptt.state === 'arming' ? <ActivityIndicator color={colors.accent} /> : null}
      </View>

      {openError ? (
        <Text style={styles.error} testID="voice-error">
          {openError}
        </Text>
      ) : null}

      <ScrollView
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        testID="voice-transcript"
      >
        {ptt.transcripts.finals.map((frag, idx) => (
          <Text key={`final-${idx}-${frag.ts}`} style={styles.transcriptFinal}>
            {frag.text}
          </Text>
        ))}
        {ptt.transcripts.interim ? (
          <Text style={styles.transcriptInterim} testID="voice-transcript-interim">
            {ptt.transcripts.interim.text}
          </Text>
        ) : null}
      </ScrollView>

      <View style={styles.waveformWrap}>
        <Animated.View
          style={[styles.waveformBar, { transform: [{ scaleY: waveformScale }] }]}
          testID="voice-waveform"
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Push to talk"
        accessibilityHint="Hold to speak; release to hear the agent reply"
        onPressIn={ptt.press}
        onPressOut={ptt.release}
        disabled={ptt.state === 'arming'}
        style={({ pressed }) => [
          styles.pttButton,
          ptt.isSending && styles.pttButtonActive,
          ptt.isReceiving && styles.pttButtonReceiving,
          pressed && styles.pttButtonPressed,
        ]}
        testID="voice-ptt-button"
      >
        <Text style={styles.pttLabel}>
          {ptt.isSending ? 'Speaking…' : ptt.isReceiving ? 'Tap to interrupt' : 'Hold to talk'}
        </Text>
      </Pressable>
    </View>
  );
}

// ── Top-level export ────────────────────────────────────────────────────────

export default function VoiceScreen(): React.ReactElement {
  if (Platform.OS === 'web') {
    return <VoiceWebFallback />;
  }
  return <VoiceNativeScreen />;
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.md,
    gap: spacing.md,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
  },
  statusLabel: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  error: { color: colors.danger, fontSize: fontSize.sm },
  transcript: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  transcriptContent: { gap: spacing.sm },
  transcriptFinal: { color: colors.text, fontSize: fontSize.md, lineHeight: 22 },
  transcriptInterim: {
    color: colors.muted,
    fontSize: fontSize.md,
    fontStyle: 'italic',
    lineHeight: 22,
  },
  waveformWrap: {
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waveformBar: {
    width: 12,
    height: 64,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
  },
  pttButton: {
    height: 128,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.accent,
  },
  pttButtonActive: { backgroundColor: colors.accent },
  pttButtonReceiving: { borderColor: colors.muted },
  pttButtonPressed: { opacity: 0.85 },
  pttLabel: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  gate: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  gateTitle: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700', textAlign: 'center' },
  gateHint: {
    color: colors.muted,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  gateButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
  },
  gateButtonText: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  fallback: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  fallbackTitle: {
    color: colors.text,
    fontSize: fontSize.xl,
    fontWeight: '700',
    textAlign: 'center',
  },
  fallbackHint: { color: colors.muted, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
});
