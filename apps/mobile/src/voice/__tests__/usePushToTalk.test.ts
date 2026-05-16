// State-machine + transcript-merge tests for the push-to-talk hook (P07A).
//
// We exercise the pure pieces (`transition`, `mergeTranscript`) directly —
// no React Testing Library, no native module mocking. The render-time hook
// behaviour is covered indirectly by the screen tests that may land in
// later plans; for v1 the FSM contract is the load-bearing surface.

import {
  emptyTranscriptLog,
  mergeTranscript,
  transition,
  type PushToTalkState,
  type TranscriptLog,
} from '../usePushToTalk';

describe('transition (PTT state machine)', () => {
  it('arms from idle and is a no-op otherwise', () => {
    expect(transition('idle', { kind: 'arm' })).toBe('arming');
    expect(transition('arming', { kind: 'arm' })).toBe('arming');
    expect(transition('listening', { kind: 'arm' })).toBe('listening');
  });

  it('promotes arming → listening on peerReady', () => {
    expect(transition('arming', { kind: 'peerReady' })).toBe('listening');
    expect(transition('idle', { kind: 'peerReady' })).toBe('idle');
    expect(transition('listening', { kind: 'peerReady' })).toBe('listening');
  });

  it('press from listening enters sending', () => {
    expect(transition('listening', { kind: 'press' })).toBe('sending');
  });

  it('release from sending enters receiving', () => {
    expect(transition('sending', { kind: 'release' })).toBe('receiving');
    // Releases from non-sending states are no-ops (defensive).
    expect(transition('listening', { kind: 'release' })).toBe('listening');
    expect(transition('idle', { kind: 'release' })).toBe('idle');
  });

  it('interruption rule — press during receiving re-enters sending', () => {
    expect(transition('receiving', { kind: 'press' })).toBe('sending');
  });

  it('done from receiving returns to listening', () => {
    expect(transition('receiving', { kind: 'done' })).toBe('listening');
    expect(transition('sending', { kind: 'done' })).toBe('listening');
    expect(transition('listening', { kind: 'done' })).toBe('listening');
  });

  it('reply transitions only from listening/receiving; sending stays sending', () => {
    expect(transition('listening', { kind: 'reply' })).toBe('receiving');
    expect(transition('receiving', { kind: 'reply' })).toBe('receiving');
    expect(transition('sending', { kind: 'reply' })).toBe('sending');
  });

  it('stop returns to idle from any state', () => {
    const states: PushToTalkState[] = ['idle', 'arming', 'listening', 'sending', 'receiving'];
    for (const s of states) {
      expect(transition(s, { kind: 'stop' })).toBe('idle');
    }
  });

  it('happy-path sequence: idle → arming → listening → sending → receiving → listening', () => {
    let s: PushToTalkState = 'idle';
    s = transition(s, { kind: 'arm' });
    expect(s).toBe('arming');
    s = transition(s, { kind: 'peerReady' });
    expect(s).toBe('listening');
    s = transition(s, { kind: 'press' });
    expect(s).toBe('sending');
    s = transition(s, { kind: 'release' });
    expect(s).toBe('receiving');
    s = transition(s, { kind: 'done' });
    expect(s).toBe('listening');
  });
});

describe('mergeTranscript', () => {
  it('appends final fragments and clears interim', () => {
    const log = mergeTranscript(emptyTranscriptLog, {
      text: 'hello',
      isFinal: true,
      ts: 1,
    });
    expect(log.finals).toHaveLength(1);
    expect(log.finals[0]!.text).toBe('hello');
    expect(log.interim).toBeNull();
  });

  it('replaces interim with the latest non-final fragment', () => {
    let log: TranscriptLog = emptyTranscriptLog;
    log = mergeTranscript(log, { text: 'he', isFinal: false, ts: 1 });
    expect(log.interim?.text).toBe('he');
    log = mergeTranscript(log, { text: 'hello', isFinal: false, ts: 2 });
    expect(log.interim?.text).toBe('hello');
    expect(log.finals).toHaveLength(0);
  });

  it('committing a final clears any prior interim', () => {
    let log: TranscriptLog = emptyTranscriptLog;
    log = mergeTranscript(log, { text: 'partial', isFinal: false, ts: 1 });
    log = mergeTranscript(log, { text: 'final answer', isFinal: true, ts: 2 });
    expect(log.finals).toEqual([{ text: 'final answer', isFinal: true, ts: 2 }]);
    expect(log.interim).toBeNull();
  });
});
