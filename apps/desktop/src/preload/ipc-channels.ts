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
}
