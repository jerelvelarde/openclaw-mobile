// `RealGateway` voice topic tests — P07A.
//
// We mirror the structure of `RealGateway.test.ts` (fake WS factory +
// `triggerOpen`/`triggerMessage`) and exercise the new voice surface:
//
//  - `openVoice` posts a `voice.open` frame and returns a `VoiceSession`.
//  - `sendVoiceSignal` posts a `voice.<sessionId>.signal` envelope with
//    the offer/answer/ice payload.
//  - `onVoiceSignal` fans inbound `voice.<sessionId>.signal` frames out
//    to subscribers (and ignores frames for other sessions).
//  - `onVoiceTranscript` fans `voice.<sessionId>.transcript` frames out
//    to subscribers.
//  - `VoiceSession.close()` posts a `voice.close` frame.
//
// The tests run without a real socket — the fake factory records `sent`
// strings the way the existing P05A tests do.

import type { VoiceSignal, VoiceTranscript } from '@openclaw/protocol';

import { PLACEHOLDER_PUBLIC_KEY, RealGateway } from '../RealGateway';
import { WS_OPEN, type WebSocketFactory, type WebSocketLike } from '../ws';

interface FakeSocket extends WebSocketLike {
  sent: string[];
  triggerOpen: () => void;
  triggerMessage: (raw: string) => void;
  triggerClose: (code?: number, reason?: string) => void;
}

function fakeWsFactory(): { factory: WebSocketFactory; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = () => {
    let readyState = 0;
    const fake: FakeSocket = {
      readyState,
      sent: [],
      send(data: string) {
        fake.sent.push(data);
      },
      close() {
        readyState = 3;
        fake.readyState = readyState;
        fake.onclose?.({ code: 1000, reason: 'manual_close' });
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      triggerOpen() {
        readyState = WS_OPEN;
        fake.readyState = readyState;
        fake.onopen?.();
      },
      triggerMessage(raw: string) {
        fake.onmessage?.({ data: raw });
      },
      triggerClose(code, reason) {
        readyState = 3;
        fake.readyState = readyState;
        fake.onclose?.({ code, reason });
      },
    };
    sockets.push(fake);
    return fake;
  };
  return { factory, sockets };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await Promise.resolve();
  await Promise.resolve();
}

describe('RealGateway voice topics', () => {
  let gw: RealGateway;
  let sockets: FakeSocket[];

  afterEach(() => {
    try {
      gw?.disconnect();
    } catch {
      /* ignore */
    }
  });

  beforeEach(async () => {
    const { factory, sockets: list } = fakeWsFactory();
    sockets = list;
    gw = new RealGateway({
      httpBase: 'http://127.0.0.1:18789',
      deviceName: 'test',
      publicKey: PLACEHOLDER_PUBLIC_KEY,
      webSocketFactory: factory,
    });
    const connecting = gw.connect('tok_test');
    await flush();
    expect(sockets.length).toBeGreaterThan(0);
    sockets[0]!.triggerOpen();
    await connecting;
  });

  it('openVoice posts a voice.open frame and returns a session handle', async () => {
    const session = await gw.openVoice({
      agentId: 'openclaw.default',
      format: 'opus',
      sampleRate: 16000,
    });

    const openFrames = sockets[0]!.sent.filter((s) => s.includes('voice.open'));
    expect(openFrames).toHaveLength(1);
    const frame = JSON.parse(openFrames[0]!);
    expect(frame.topic).toBe('voice');
    expect(frame.type).toBe('voice.open');
    expect(frame.payload.sessionId).toBe(session.id);
    expect(frame.payload.opts).toEqual({
      agentId: 'openclaw.default',
      format: 'opus',
      sampleRate: 16000,
    });
    expect(session.agentId).toBe('openclaw.default');
    expect(session.id).toMatch(/^vs_/);
  });

  it('sendVoiceSignal posts a voice.<id>.signal envelope', async () => {
    const offer: VoiceSignal = { type: 'offer', sdp: 'v=0\r\n...' };
    await gw.sendVoiceSignal('vs_x', offer);
    const signalFrames = sockets[0]!.sent.filter((s) => s.includes('voice.vs_x.signal'));
    expect(signalFrames).toHaveLength(1);
    const frame = JSON.parse(signalFrames[0]!);
    expect(frame.topic).toBe('voice.vs_x.signal');
    expect(frame.type).toBe('voice.signal');
    expect(frame.payload).toEqual(offer);
  });

  it('onVoiceSignal fans inbound signal frames to per-session subscribers', () => {
    const received: VoiceSignal[] = [];
    const unsub = gw.onVoiceSignal('vs_x', (s) => received.push(s));

    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'f1',
        topic: 'voice.vs_x.signal',
        type: 'voice.signal',
        payload: { type: 'answer', sdp: 'v=0\r\n...' },
        ts: 1,
      }),
    );
    // Different session — must not be delivered.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'f2',
        topic: 'voice.vs_other.signal',
        type: 'voice.signal',
        payload: { type: 'ice', candidate: 'cand1' },
        ts: 2,
      }),
    );
    // Different sub-kind — also must not be delivered.
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'f3',
        topic: 'voice.vs_x.transcript',
        type: 'voice.transcript',
        payload: { text: 'no', isFinal: false, ts: 3 },
        ts: 3,
      }),
    );

    expect(received).toEqual([{ type: 'answer', sdp: 'v=0\r\n...' }]);
    unsub();

    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 'f4',
        topic: 'voice.vs_x.signal',
        type: 'voice.signal',
        payload: { type: 'ice', candidate: 'cand2' },
        ts: 4,
      }),
    );
    // Post-unsub: no further deliveries.
    expect(received).toHaveLength(1);
  });

  it('onVoiceTranscript fans inbound transcript frames to per-session subscribers', () => {
    const received: VoiceTranscript[] = [];
    const unsub = gw.onVoiceTranscript('vs_t', (t) => received.push(t));

    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 't1',
        topic: 'voice.vs_t.transcript',
        type: 'voice.transcript',
        payload: { text: 'partial', isFinal: false, ts: 100 },
        ts: 100,
      }),
    );
    sockets[0]!.triggerMessage(
      JSON.stringify({
        id: 't2',
        topic: 'voice.vs_t.transcript',
        type: 'voice.transcript',
        payload: { text: 'final answer', isFinal: true, ts: 200 },
        ts: 200,
      }),
    );

    expect(received).toEqual([
      { text: 'partial', isFinal: false, ts: 100 },
      { text: 'final answer', isFinal: true, ts: 200 },
    ]);
    unsub();
  });

  it('VoiceSession.close posts a voice.close frame', async () => {
    const session = await gw.openVoice({
      agentId: 'a',
      format: 'opus',
      sampleRate: 16000,
    });
    await session.close();
    const closes = sockets[0]!.sent.filter((s) => s.includes('voice.close'));
    expect(closes).toHaveLength(1);
    const frame = JSON.parse(closes[0]!);
    expect(frame.topic).toBe('voice');
    expect(frame.type).toBe('voice.close');
    expect(frame.payload.sessionId).toBe(session.id);
  });

  it('rejects openVoice / sendVoiceSignal when the socket is closed', async () => {
    const { factory } = fakeWsFactory();
    const unconnected = new RealGateway({
      httpBase: 'http://127.0.0.1:18789',
      deviceName: 'test',
      webSocketFactory: factory,
    });
    await expect(
      unconnected.openVoice({ agentId: 'a', format: 'opus', sampleRate: 16000 }),
    ).rejects.toThrow(/not connected/);
    await expect(
      unconnected.sendVoiceSignal('vs_x', { type: 'offer', sdp: '...' }),
    ).rejects.toThrow(/not connected/);
  });
});
