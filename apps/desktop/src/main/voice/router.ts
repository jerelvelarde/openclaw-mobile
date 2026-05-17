// Voice session lifecycle router.
//
// P07B step 4: subscribe to the `voice` topic prefix on the shared
// envelope router; for each unique `voice.<sessionId>.*` topic we see,
// spin up a `VoicePeer` + an `AgentBridge` on demand, route signaling
// frames to the right peer, and tear everything down when the session
// closes (either via an explicit `voice.<sid>.signal { type: 'close' }`
// — out of band of the WebRTC standard but useful for the WS-fallback
// world — or by the peer's own `onconnectionstatechange`).
//
// We extract the session id from the topic with a small parser rather
// than from the payload so the same code path works for `signal` and
// (future) `frame` topics. The router-level handler is registered on
// the `voice` prefix exactly once.

import type { VoiceSignal } from '@openclaw/protocol';
import { VoiceSignalSchema, voiceTopics } from '@openclaw/protocol';
import type { InboundFrame, Router } from '../transport/router';
import { createAgentBridge, VOICE_SIGNAL_TYPE, type AgentBridge } from './agentBridge';
import { createVoicePeer, type PeerDeps, type VoicePeer } from './peer';

/** Tracks everything we own for one session. */
interface VoiceSessionState {
  sessionId: string;
  deviceId: string;
  peer: VoicePeer;
  bridge: AgentBridge;
}

/** Public surface of the voice router. */
export interface VoiceRouter {
  /** Sessions currently live. Keyed by session id. */
  readonly sessions: ReadonlyMap<string, VoiceSessionState>;
  /** Detach the prefix subscription + close every session. */
  close(): Promise<void>;
  /** Test-only: number of sessions ever created. */
  _createdCount(): number;
  /** Test-only: number of sessions destroyed. */
  _destroyedCount(): number;
}

/** Options for `createVoiceRouter`. */
export interface CreateVoiceRouterOpts {
  /** The shared envelope router (from `transport/router.ts`). */
  router: Router;
  /** WebRTC dependency injection (production: `loadWrtcDeps()`'s result). */
  deps: PeerDeps;
  /** Optional clock for deterministic tests. */
  now?: () => number;
}

/**
 * Parse `voice.<sessionId>.<sub>` topics. Returns `null` if the topic
 * doesn't match — defensive against the router prefix matcher firing
 * for a topic that *starts with* `voice.` but isn't well-formed.
 */
export function parseVoiceTopic(topic: string): { sessionId: string; sub: string } | null {
  if (!topic.startsWith('voice.')) return null;
  const rest = topic.slice('voice.'.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  const sessionId = rest.slice(0, dot);
  const sub = rest.slice(dot + 1);
  if (!sessionId || !sub) return null;
  return { sessionId, sub };
}

/** Build a voice router subscribed to the shared envelope router. */
export function createVoiceRouter(opts: CreateVoiceRouterOpts): VoiceRouter {
  const { router, deps, now = (): number => Date.now() } = opts;
  const sessions = new Map<string, VoiceSessionState>();
  let createdCount = 0;
  let destroyedCount = 0;
  let closed = false;

  function destroySession(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    destroyedCount += 1;
    try {
      state.bridge.detach();
    } catch {
      // ignore
    }
    void state.peer.close();
  }

  function ensureSession(sessionId: string, deviceId: string): VoiceSessionState {
    let state = sessions.get(sessionId);
    if (state) return state;

    const peer: VoicePeer = createVoicePeer({
      sessionId,
      deps,
      onLocalSignal: (signal) => {
        // Outbound signaling lands back on `voice.<sid>.signal`, scoped
        // to the originating device (the phone). The phone's WS session
        // will receive it via the broadcaster.
        router.publish(voiceTopics.signal(sessionId), VOICE_SIGNAL_TYPE, signal, {
          target: { deviceId },
          ts: now(),
        });
      },
      onInboundAudio: (frame) => {
        // Forwarded immediately to the agent bridge — `state` is in scope
        // by closure even though it's not assigned yet at peer-create
        // time, because the audio handler only fires after the remote
        // has actually negotiated a track (i.e. after the bridge is
        // built and stored below).
        const live = sessions.get(sessionId);
        live?.bridge.handleInboundAudio(frame);
      },
      onClose: () => {
        // The peer detected a hard close (connectionState=closed/failed).
        // Mirror that to the session map.
        if (sessions.has(sessionId)) {
          destroySession(sessionId);
        }
      },
    });

    const bridge: AgentBridge = createAgentBridge({
      sessionId,
      deviceId,
      router,
      peer,
      now,
    });

    state = { sessionId, deviceId, peer, bridge };
    sessions.set(sessionId, state);
    createdCount += 1;
    return state;
  }

  function handleSignalFrame(
    frame: InboundFrame,
    parsed: VoiceSignal,
    ctx: { deviceId: string },
  ): void {
    if (closed) return;
    const route = parseVoiceTopic(frame.topic);
    if (!route || route.sub !== 'signal') return;

    // An "ice"-with-empty-candidate from a session we never spun up is
    // benign — happens if the phone flushes its candidate queue after
    // we tore down. Drop quietly.
    const existing = sessions.get(route.sessionId);
    if (!existing && parsed.type === 'ice' && !parsed.candidate) return;

    const state = existing ?? ensureSession(route.sessionId, ctx.deviceId);

    void state.peer.applySignal(parsed).catch(() => {
      // Signal-level errors (bad SDP, unexpected state) shouldn't kill
      // the router. We close the session so the client can retry.
      destroySession(route.sessionId);
    });
  }

  // Subscribe at the `voice` prefix so we catch every
  // `voice.<sid>.signal` (and, in a future cycle, `voice.<sid>.frame`
  // for the WS-fallback path P07.0 calls out).
  const unsub = router.subscribe('voice', (frame, ctx) => {
    const route = parseVoiceTopic(frame.topic);
    if (!route) return;

    // We only consume signaling frames here. Frame-topic traffic that
    // *we* publish (inbound audio out to the agent) loops back to us
    // via the prefix subscription too — we ignore everything that
    // isn't a signal, and we ignore `voice.frame` (our own outbound
    // publish) by checking the `type` field as well.
    if (route.sub !== 'signal') return;
    if (frame.type !== VOICE_SIGNAL_TYPE) return;

    const result = VoiceSignalSchema.safeParse(frame.payload);
    if (!result.success) return;
    handleSignalFrame(frame, result.data, ctx);
  });

  return {
    sessions,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        unsub();
      } catch {
        // ignore
      }
      for (const sid of [...sessions.keys()]) {
        destroySession(sid);
      }
    },
    _createdCount: (): number => createdCount,
    _destroyedCount: (): number => destroyedCount,
  };
}
