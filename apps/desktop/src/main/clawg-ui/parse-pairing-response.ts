// Shared parser for clawg-ui's `403 pairing_pending` response body.
//
// `vendor/clawg-ui/src/http-handler.ts:295-307` defines the wire shape:
//
//   {
//     pairing_code: "ABCD1234",                 // top-level shortcut (back-compat)
//     bearer_token: "<signed jwt-ish blob>",    // top-level shortcut (back-compat)
//     error: {
//       type: "pairing_pending",
//       message: "...",
//       pairing: { pairingCode, token, instructions }   // preferred nested form
//     }
//   }
//
// Per P11B we prefer the nested `error.pairing.*` fields; the top-level
// `pairing_code` / `bearer_token` keys are tolerated as a fallback so a
// future version of clawg-ui that drops the flat shape doesn't break us
// here (and vice-versa).
//
// Lives in `clawg-ui/` rather than in P11A's transport client because
// both the runtime client (P11A) and the pairing-state state machine
// (P11B) need to detect a pairing-pending response. Keeping it shared
// avoids two near-identical parsers diverging on edge cases.

/**
 * Successful parse of a clawg-ui pairing-pending 403 body. Both fields
 * are guaranteed non-empty strings; the caller decides what to do with
 * them (P11A stashes `token`; P11B surfaces `pairingCode` in the UI).
 */
export interface ClawgUiPairingPending {
  /** The short alphanumeric code the user types into the gateway CLI. */
  pairingCode: string;
  /** The bearer token to use on the subsequent retry once approved. */
  token: string;
}

/**
 * Inspect an arbitrary JSON body + status code and return the pairing
 * envelope if it matches clawg-ui's pairing-pending shape. Returns
 * `null` otherwise — the caller treats that as "not a pairing pending
 * response, handle as a normal 403/200/etc".
 *
 * This function is intentionally non-throwing: a malformed body just
 * yields `null` so unrelated 403s don't get misclassified.
 */
export function parseClawgUiPairingPending(
  status: number,
  body: unknown,
): ClawgUiPairingPending | null {
  if (status !== 403) return null;
  if (typeof body !== 'object' || body === null) return null;

  const obj = body as Record<string, unknown>;

  // 1. Preferred shape: error.pairing.{pairingCode,token}.
  const errorField = obj['error'];
  if (typeof errorField === 'object' && errorField !== null) {
    const err = errorField as Record<string, unknown>;
    if (err['type'] !== 'pairing_pending') return null;
    const pairing = err['pairing'];
    if (typeof pairing === 'object' && pairing !== null) {
      const p = pairing as Record<string, unknown>;
      const pairingCode = typeof p['pairingCode'] === 'string' ? (p['pairingCode'] as string) : '';
      const token = typeof p['token'] === 'string' ? (p['token'] as string) : '';
      if (pairingCode && token) return { pairingCode, token };
    }
  }

  // 2. Back-compat shape: top-level pairing_code / bearer_token.
  const pairingCodeFlat =
    typeof obj['pairing_code'] === 'string' ? (obj['pairing_code'] as string) : '';
  const tokenFlat = typeof obj['bearer_token'] === 'string' ? (obj['bearer_token'] as string) : '';
  if (pairingCodeFlat && tokenFlat) {
    return { pairingCode: pairingCodeFlat, token: tokenFlat };
  }

  return null;
}
