// React hook that drives push registration off the pairing state machine.
//
// Mounted once near the top of the app tree (see `app/_layout.tsx`). The
// effect fires exactly once per `paired` transition — we key it on the
// token value + httpBase so a token rotation re-registers, but a render
// caused by an unrelated state change (e.g. reconnect state) doesn't.
//
// Sits in `apps/mobile/src/push/usePushRegistration.ts` rather than inside
// `PairingProvider` itself so the provider stays a pure state-machine +
// gateway holder; the side effect of "register for Expo push" is the
// caller's choice, mirroring how the CopilotKit provider is wired up
// from `_layout.tsx` rather than from inside `PairingProvider`.
//
// Web is a no-op (registerPushToken returns null), so the hook is safe to
// call from any platform.

import { useEffect, useRef } from 'react';

import { usePairing } from '../pairing/PairingProvider';
import { registerPushToken, type PushRegistration } from './register';

/**
 * Subscribe to the pairing state machine and register for push
 * notifications whenever a fresh `paired` session lands.
 *
 * No props — everything we need comes off `usePairing()`. The hook is a
 * single effect; rendering is unaffected.
 */
export function usePushRegistration(): void {
  const { state } = usePairing();
  // Track the active registration so we can tear down the token-refresh
  // listener on token rotation / logout. A ref (not state) because no
  // render path depends on the registration handle.
  const registrationRef = useRef<PushRegistration | null>(null);

  // Key the effect on the *token value* + `httpBase` so we re-run only on
  // a meaningful identity change. The reconnect controller flips `status`
  // back to `paired` after a transient drop — that path doesn't change the
  // token, so we deliberately don't re-register on every status flip.
  const tokenValue = state.status === 'paired' ? state.token?.value : undefined;
  const httpBase = state.status === 'paired' ? state.httpBase : undefined;
  const pairingToken = state.status === 'paired' ? state.token : undefined;

  useEffect(() => {
    // Tear down any previous registration before we kick off a new one.
    const previous = registrationRef.current;
    registrationRef.current = null;
    if (previous) previous.unsubscribe();

    // Nothing to do until we've reached `paired` and have an httpBase.
    if (!tokenValue || !httpBase || !pairingToken) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const reg = await registerPushToken({
          httpBase,
          pairingToken,
        });
        if (cancelled) {
          // The effect was torn down before the promise resolved — tear
          // down the listener we just attached so it doesn't leak.
          reg?.unsubscribe();
          return;
        }
        registrationRef.current = reg;
      } catch (err) {
        // We don't surface a UI error here — the desktop will simply not
        // be able to fan out pushes to this device until a re-pair or app
        // restart succeeds. A console warn is enough for v1.
        // eslint-disable-next-line no-console
        console.warn('[openclaw/push] registration failed:', err);
      }
    })();

    return () => {
      cancelled = true;
      const current = registrationRef.current;
      registrationRef.current = null;
      if (current) current.unsubscribe();
    };
  }, [tokenValue, httpBase, pairingToken]);
}
