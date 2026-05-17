// String-constant catalogue for the IPC channels shared by main + preload.
//
// Keeping the names in one file removes a class of typo bugs and gives
// the renderer something to import for tests + UI code without crossing
// into the Electron API surface.

export const IPC = {
  /** Renderer → main: list current pending pairs. */
  PAIRING_LIST_PENDING: 'pairing:list-pending',
  /** Renderer → main: approve a pending pair by id. */
  PAIRING_APPROVE: 'pairing:approve',
  /** Renderer → main: deny a pending pair by id. */
  PAIRING_DENY: 'pairing:deny',
  /** Renderer → main: list approved devices. */
  PAIRING_LIST_DEVICES: 'pairing:list-devices',
  /** Renderer → main: revoke an approved device by id. */
  PAIRING_REVOKE_DEVICE: 'pairing:revoke-device',
  /** Main → renderer: a new pending pair just arrived. */
  PAIRING_PENDING_EVENT: 'pairing:pending-event',
  /**
   * Main → renderer: open a specific page (e.g. when the notification
   * is clicked). Payload is the page hash to show.
   */
  NAVIGATE: 'pairing:navigate',
  /** Renderer → main: fetch the current `SettingsFile` (P04B). */
  SETTINGS_GET: 'settings:get',
  /**
   * Renderer → main: fetch the self-issued bearer token + the loopback
   * URLs the renderer uses to reach the gateway (P05B). Local-only;
   * never expose this channel's value over IPC to anything but the
   * trusted renderer.
   */
  SYSTEM_GET_SELF_TOKEN: 'system:get-self-token',
} as const;

/**
 * Channel names for the clawg-ui pairing flow (P11B). Lives in a
 * separate namespace from `IPC` so a future P03B / P11B coexistence bug
 * can't accidentally cross-fire — e.g. the legacy `PAIRING_APPROVE`
 * channel takes a `pair_id`, the clawg-ui `PAIRING_APPROVE` takes a
 * `pairingCode`.
 */
export const CLAWG_UI_IPC = {
  /** Renderer → main: read the current `ClawgUiPairingState`. */
  PAIRING_STATE_GET: 'clawg-ui:pairing:state:get',
  /** Renderer → main: approve a pending pairing by code (spawns CLI). */
  PAIRING_APPROVE: 'clawg-ui:pairing:approve',
  /** Renderer → main: deny a pending pairing (local dismissal only). */
  PAIRING_DENY: 'clawg-ui:pairing:deny',
  /** Renderer → main: reset the state machine to `idle`. */
  PAIRING_DISMISS: 'clawg-ui:pairing:dismiss',
  /** Main → renderer: state machine transition. */
  PAIRING_STATE_EVENT: 'clawg-ui:pairing:state-event',
  /**
   * Main → renderer: tray notification fallback asked us to show the
   * Settings page so the user can approve from the in-window banner.
   */
  NAVIGATE_TO_SETTINGS: 'clawg-ui:navigate-settings',
} as const;

/** Payload sent over `PAIRING_PENDING_EVENT` and returned by `PAIRING_LIST_PENDING`. */
export interface PendingPairView {
  pair_id: string;
  device_name: string;
  code: string;
  expires_at: number;
}

/** Payload returned by `PAIRING_LIST_DEVICES`. Mirrors `PairedDevice`. */
export interface PairedDeviceView {
  device_id: string;
  device_name: string;
  paired_at: number;
  last_seen: number;
}

/**
 * Payload returned by `SETTINGS_GET`. Mirrors `SettingsFile` in
 * `main/settings.ts`. Re-declared here so the preload bridge doesn't
 * import from the main-process tree.
 */
export interface SettingsView {
  version: 1;
  lan_enabled: boolean;
  /**
   * Which gateway plumbing the desktop boots. `"stub"` keeps the legacy
   * in-process echo gateway; `"clawg-ui"` (Wave 15 — P11A/P11B) points
   * the runtime at the clawg-ui gateway plugin's `/v1/clawg-ui`
   * endpoint and runs the desktop-wrapped pairing flow. Restart-only.
   */
  gateway_mode: 'stub' | 'clawg-ui';
}

/**
 * Payload returned by `SYSTEM_GET_SELF_TOKEN`. The renderer uses these
 * to open the local WS + post against the local CopilotKit runtime
 * adapter. All URLs are loopback (`127.0.0.1`) regardless of whether
 * LAN exposure is on — the self-token must not leak onto the LAN.
 */
export interface SelfTokenView {
  /** Bearer token signed by the gateway's private key with `device_id: "self"`. */
  token: string;
  /** Epoch ms when the token stops being accepted. Renderer refetches near expiry. */
  expires_at: number;
  /** Loopback WS URL — `ws://127.0.0.1:<port>/ws`. */
  ws_url: string;
  /** Loopback runtime base URL — `http://127.0.0.1:<port>/copilot/runtime`. */
  runtime_url: string;
}
