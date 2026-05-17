// Tests for the clawg-ui unsupported-surfaces router shim (P11A).
//
// In `gateway_mode === "clawg-ui"` the legacy P10A bridge no longer
// answers `canvas.*` / `voice.*` / `agents.setActive`. This shim
// subscribes to the same topics and replies with the same typed
// `unsupportedInRealMode` envelope so the renderer + mobile clients see
// a structured error instead of a timeout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouter, type InboundFrame, type Router } from '../../transport/router';
import {
  attachClawgUiUnsupportedSurfaces,
  type ClawgUiUnsupportedAttachment,
  type UnsupportedInRealModeError,
} from '../clawg-ui-unsupported';

let router: Router;
let attachment: ClawgUiUnsupportedAttachment;
let captured: InboundFrame[];
let logs: string[];

function sendInbound(topic: string, type: string, payload: unknown): void {
  const frame: InboundFrame = {
    id: `id-${type}`,
    topic,
    type,
    payload,
    ts: Date.now(),
  };
  router.dispatchRaw(JSON.stringify(frame), { deviceId: 'test-device' });
}

beforeEach(() => {
  router = createRouter();
  captured = [];
  logs = [];
  router.setBroadcaster((f) => {
    captured.push(f);
  });
  attachment = attachClawgUiUnsupportedSurfaces({
    router,
    log: (msg) => logs.push(msg),
  });
});

afterEach(() => {
  attachment.detach();
});

describe('attachClawgUiUnsupportedSurfaces', () => {
  it('replies to canvas.get with unsupportedInRealMode { feature: "canvas" }', async () => {
    sendInbound('canvas.get', 'canvas.get', { surfaceId: 's1' });
    await Promise.resolve();
    expect(captured.length).toBe(1);
    const reply = captured[0] as InboundFrame;
    expect(reply.type).toBe('canvas.get.error');
    const payload = reply.payload as UnsupportedInRealModeError;
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe('unsupportedInRealMode');
    expect(payload.feature).toBe('canvas');
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('canvas');
  });

  it('replies to voice (talk.*) topics with unsupportedInRealMode { feature: "voice" }', async () => {
    sendInbound('talk.start', 'talk.start', { roomId: 'r1' });
    await Promise.resolve();
    expect(captured.length).toBe(1);
    const reply = captured[0] as InboundFrame;
    expect(reply.type).toBe('talk.start.error');
    const payload = reply.payload as UnsupportedInRealModeError;
    expect(payload.feature).toBe('voice');
  });

  it('replies to agents.setActive with unsupportedInRealMode { feature: "agentsSetActive" }', async () => {
    sendInbound('agents.setActive', 'agents.setActive', { agentId: 'a1' });
    await Promise.resolve();
    expect(captured.length).toBe(1);
    const reply = captured[0] as InboundFrame;
    expect(reply.type).toBe('agents.setActive.response');
    const payload = reply.payload as UnsupportedInRealModeError;
    expect(payload.feature).toBe('agentsSetActive');
  });

  it('detach() removes the subscriptions', async () => {
    attachment.detach();
    sendInbound('canvas.get', 'canvas.get', {});
    await Promise.resolve();
    expect(captured.length).toBe(0);
  });
});
