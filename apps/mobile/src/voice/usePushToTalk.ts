// Push-to-talk state machine + React hook (P07A).
//
// The hook drives a small finite state machine:
//
//   idle  ─arm()──►  arming   ─peerReady()─►  listening
//                       │                          │
//                       │                          press()
//                       │                          ▼
//                       │                        sending
//                       │                          │
//                       │                          release()
//                       │                          ▼
//                       │                        receiving
//                       │                          │
//                       │                          interruption()
//                       │                          │  / done()
//                       ▼                          ▼
//                      idle  ◄──────── stop() ───── idle
//
// Transitions are kept out of `voice.tsx` so the screen stays declarative
// and the machine can be unit-tested without React. The hook layer wraps
// the reducer + adds a transcript stream subscription so the screen reads
// `transcripts` directly without juggling its own list.
//
// Interruption rule (per the plan): a `press()` during `receiving` cancels
// the agent reply and starts a fresh `sending` turn (the screen wires a
// tap-during-playback to call `press()`).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import type { Unsubscribe, VoiceTranscript } from '@openclaw/protocol';

// ── State machine ───────────────────────────────────────────────────────────

/** All states the PTT flow can be in. */
export type PushToTalkState = 'idle' | 'arming' | 'listening' | 'sending' | 'receiving';

/** Events the machine accepts. Each one tagged via `kind` so we can switch. */
export type PushToTalkEvent =
  | { kind: 'arm' } // user opened the screen / started a session
  | { kind: 'peerReady' } // ICE connection is up — we can hold to talk
  | { kind: 'press' } // user pressed the PTT button (or tapped during playback)
  | { kind: 'release' } // user released the PTT button
  | { kind: 'reply' } // agent began streaming a reply
  | { kind: 'done' } // agent finished the reply (final transcript)
  | { kind: 'stop' }; // user closed the screen / explicit stop

/**
 * Snapshot accessible from the hook + tests.
 *
 *  - `state`            — current FSM node.
 *  - `transition`       — pure reducer; exposed for tests.
 *  - `legalEvents`      — events the machine would accept right now. Useful
 *                         for tests + a-11y "disabled-button" derivation.
 */
export interface PushToTalkSnapshot {
  state: PushToTalkState;
}

/**
 * Pure reducer. The hook owns the live state; tests exercise this directly
 * with `expect(transition(state, event)).toBe(...)`.
 *
 * Rules:
 *
 *   - `arm`        from `idle` → `arming`.
 *   - `peerReady`  from `arming` → `listening`.
 *   - `press`      from `listening` or `receiving` → `sending`. (Interruption.)
 *   - `release`    from `sending` → `receiving`.
 *   - `reply`      from `sending` or `receiving` → `receiving`. (Idempotent.)
 *   - `done`       from `receiving` or `sending` → `listening`.
 *   - `stop`       from any state → `idle`.
 *
 * Anything else is a no-op; we don't throw because the screen can race the
 * machine (e.g. a `release` arriving after a `stop`). Returning the
 * previous state keeps the hook's `useReducer` reference-stable on no-ops.
 */
export function transition(state: PushToTalkState, event: PushToTalkEvent): PushToTalkState {
  switch (event.kind) {
    case 'arm':
      return state === 'idle' ? 'arming' : state;
    case 'peerReady':
      return state === 'arming' ? 'listening' : state;
    case 'press':
      // Interruption rule: pressing during `receiving` cancels the agent
      // reply and starts a new turn. Pressing from `listening` is the
      // normal "start talking" path.
      if (state === 'listening' || state === 'receiving') return 'sending';
      return state;
    case 'release':
      return state === 'sending' ? 'receiving' : state;
    case 'reply':
      // The agent began (or is mid-) reply — common path is `sending`
      // -> agent picks up the trailing audio -> emits `reply` -> we
      // transition to `receiving` once the user has released. If the user
      // hasn't released yet, stay in `sending` so the local mic capture
      // remains gated correctly.
      if (state === 'sending') return state;
      if (state === 'listening' || state === 'receiving') return 'receiving';
      return state;
    case 'done':
      if (state === 'receiving' || state === 'sending') return 'listening';
      return state;
    case 'stop':
      return 'idle';
    default:
      return state;
  }
}

// ── Transcript merge ────────────────────────────────────────────────────────

/**
 * Reduction shape for the live transcript: a list of committed fragments
 * + a single trailing interim (the "ghost" line that updates rapidly). New
 * `isFinal: false` frames replace the interim; new `isFinal: true` frames
 * push onto `finals` and clear the interim.
 *
 * Exposed as a pure helper so tests can drive it without React.
 */
export interface TranscriptLog {
  finals: VoiceTranscript[];
  interim: VoiceTranscript | null;
}

export const emptyTranscriptLog: TranscriptLog = { finals: [], interim: null };

/**
 * Merge a new fragment into a transcript log. Pure — returns a new log if
 * the inbound fragment changes anything, otherwise the same reference.
 */
export function mergeTranscript(log: TranscriptLog, frag: VoiceTranscript): TranscriptLog {
  if (frag.isFinal) {
    return { finals: [...log.finals, frag], interim: null };
  }
  return { finals: log.finals, interim: frag };
}

// ── Hook ────────────────────────────────────────────────────────────────────

/** Voice peer surface the hook needs. Matches {@link VoicePeerHandle}. */
export interface PushToTalkPeer {
  setSending(sending: boolean): void;
  close(): Promise<void>;
}

/** Transcript subscription source. Matches the gateway's `onVoiceTranscript`. */
export type PushToTalkTranscriptSource = (
  sessionId: string,
  handler: (frag: VoiceTranscript) => void,
) => Unsubscribe;

/** Hook arguments. */
export interface UsePushToTalkOptions {
  /** Session id the screen is bound to; `null` while we haven't dialed. */
  sessionId: string | null;
  /** Live peer handle from `openVoicePeer`. `null` while booting. */
  peer: PushToTalkPeer | null;
  /** Transcript subscription source (the gateway). */
  subscribeTranscript: PushToTalkTranscriptSource;
  /**
   * Optional override — by default the machine emits `peerReady` once the
   * caller has supplied a non-null `peer`. Tests pass `false` to drive the
   * `arming → listening` transition manually.
   */
  autoArm?: boolean;
}

/** Hook return shape. */
export interface UsePushToTalk {
  /** Current FSM state. */
  state: PushToTalkState;
  /** Snapshot helpers — useful for `disabled` button derivation. */
  isBusy: boolean;
  isSending: boolean;
  isReceiving: boolean;
  /** Live transcript log. Renderers read `finals` + `interim`. */
  transcripts: TranscriptLog;
  /** PTT press handler. Bind to `onPressIn` (or to a tap during playback). */
  press: () => void;
  /** PTT release handler. Bind to `onPressOut`. */
  release: () => void;
  /** Explicit teardown — used by the screen's blur/unmount path. */
  stop: () => void;
  /** Emit a `reply`/`done` event externally — exposed for the screen. */
  dispatchEvent: (event: PushToTalkEvent) => void;
}

/**
 * Drive the push-to-talk lifecycle. Owns:
 *
 *  - The FSM state (via `useReducer`).
 *  - Transcript subscription bookkeeping.
 *  - Mic-gating: flips `peer.setSending(true/false)` in lockstep with the
 *    FSM so the underlying `MediaStreamTrack.enabled` matches user intent.
 */
export function usePushToTalk(options: UsePushToTalkOptions): UsePushToTalk {
  const [state, dispatch] = useReducer(transition, 'idle' as PushToTalkState);
  const [transcripts, setTranscripts] = useState<TranscriptLog>(emptyTranscriptLog);

  // Keep a ref to the latest peer so the imperative `press`/`release`
  // callbacks don't rebind on every render. The hook caller is expected
  // to replace `peer` with a fresh reference between sessions.
  const peerRef = useRef<PushToTalkPeer | null>(options.peer);
  useEffect(() => {
    peerRef.current = options.peer;
  }, [options.peer]);

  // ── Arm / peerReady wiring ────────────────────────────────────────────────
  //
  // The screen passes `sessionId` once it has dialed. We emit `arm` on the
  // first non-null sessionId so the FSM moves into `arming`; `peerReady`
  // fires once `peer` is non-null AND `autoArm` is not false.
  useEffect(() => {
    if (options.sessionId) dispatch({ kind: 'arm' });
  }, [options.sessionId]);

  const autoArm = options.autoArm !== false;
  useEffect(() => {
    if (autoArm && options.peer) dispatch({ kind: 'peerReady' });
  }, [autoArm, options.peer]);

  // ── Transcript subscription ───────────────────────────────────────────────
  useEffect(() => {
    if (!options.sessionId) return;
    const unsubscribe = options.subscribeTranscript(options.sessionId, (frag) => {
      setTranscripts((prev) => mergeTranscript(prev, frag));
      // Treat the first interim/final fragment as the "agent started
      // replying" event so the FSM can switch into `receiving`.
      dispatch({ kind: 'reply' });
      if (frag.isFinal) {
        dispatch({ kind: 'done' });
      }
    });
    return unsubscribe;
    // The deliberate `subscribeTranscript` omission is to avoid resubscribing
    // when the caller passes a fresh closure each render — they're expected
    // to memoize. We'd loop otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.sessionId]);

  // ── Mic gating side-effect ────────────────────────────────────────────────
  //
  // The FSM is the single source of truth for "is the mic open?" — we
  // mirror it onto `peer.setSending` whenever the state changes.
  useEffect(() => {
    peerRef.current?.setSending(state === 'sending');
  }, [state]);

  // ── Stable callbacks for the screen ───────────────────────────────────────
  const press = useCallback((): void => {
    dispatch({ kind: 'press' });
  }, []);
  const release = useCallback((): void => {
    dispatch({ kind: 'release' });
  }, []);
  const stop = useCallback((): void => {
    dispatch({ kind: 'stop' });
    setTranscripts(emptyTranscriptLog);
  }, []);
  const dispatchEvent = useCallback((event: PushToTalkEvent): void => {
    dispatch(event);
  }, []);

  // Derived flags so the screen doesn't pattern-match `state` itself.
  const flags = useMemo(
    () => ({
      isBusy: state === 'arming' || state === 'sending' || state === 'receiving',
      isSending: state === 'sending',
      isReceiving: state === 'receiving',
    }),
    [state],
  );

  return {
    state,
    transcripts,
    press,
    release,
    stop,
    dispatchEvent,
    ...flags,
  };
}
