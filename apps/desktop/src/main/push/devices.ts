// Push-side view over the device store from P03B.
//
// Per P08B step 2: every paired device may register an Expo push token
// after pairing finishes. The token + the platform that produced it live
// on the existing `PairedDevice` record (see `pair/store.ts`); this
// module is a thin push-specific facade that the dispatcher and the
// `/devices/:id/push-token` route both consume.
//
// Keeping the push helpers in their own module — even though the actual
// persistence lives in `DeviceStore` — means the dispatch + the route
// import from `push/*` only, which makes the surface easy to mock in
// tests and easy to swap if we ever move from JSON-on-disk to SQLite.

import type { DeviceStore, PairedDevice } from '../pair/store';

/** Platform a push token was issued for. Mirrors mobile's `Platform.OS`. */
export type PushPlatform = 'ios' | 'android';

/**
 * Subset of `PairedDevice` the dispatcher actually cares about. We
 * narrow the shape so test fixtures don't have to fill in every field of
 * the persisted record (paired_at, last_seen, etc.).
 */
export interface PushTarget {
  deviceId: string;
  deviceName: string;
  pushToken: string;
  pushPlatform?: PushPlatform;
}

/** Public surface the rest of the push module talks to. */
export interface PushDeviceRegistry {
  /**
   * Record (or update) the Expo push token mobile reported via
   * `POST /devices/:id/push-token`. Returns `false` if the device id
   * isn't paired (caller should answer 404).
   */
  setPushToken(deviceId: string, token: string, platform: PushPlatform): boolean;
  /** Clear the push token for a device. No-op if it's already absent. */
  clearPushToken(deviceId: string): boolean;
  /**
   * Every paired device that currently has a registered push token. The
   * dispatcher iterates this list per gateway event. Devices without a
   * token are filtered out — they won't get notifications until they
   * register one.
   */
  listPushTargets(): PushTarget[];
}

/**
 * Build a push-device registry on top of an existing `DeviceStore`. The
 * registry doesn't own state of its own — every call round-trips through
 * the store, same as the rest of `DeviceStore`'s methods.
 */
export function createPushDeviceRegistry(store: DeviceStore): PushDeviceRegistry {
  return {
    setPushToken(deviceId, token, platform) {
      return store.setPushToken(deviceId, token, platform);
    },
    clearPushToken(deviceId) {
      return store.setPushToken(deviceId, null);
    },
    listPushTargets() {
      const out: PushTarget[] = [];
      for (const d of store.listDevices()) {
        if (typeof d.pushToken === 'string' && d.pushToken.length > 0) {
          out.push(toPushTarget(d));
        }
      }
      return out;
    },
  };
}

/**
 * Project a `PairedDevice` to the trimmed `PushTarget` shape. Exported
 * so tests that build records directly can share the projection logic.
 */
export function toPushTarget(device: PairedDevice): PushTarget {
  return {
    deviceId: device.device_id,
    deviceName: device.device_name,
    pushToken: device.pushToken ?? '',
    pushPlatform: device.pushPlatform,
  };
}
