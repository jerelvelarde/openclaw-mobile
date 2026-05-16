// Microphone permission flow for the voice surface (P07A).
//
// On native (`ios`/`android`) we hit `PermissionsAndroid.RECORD_AUDIO` or
// rely on the OS to surface its prompt the first time `getUserMedia` runs
// (iOS — `NSMicrophoneUsageDescription` in `Info.plist` drives the copy).
// On web we use `navigator.mediaDevices.getUserMedia`; on the placeholder
// web fallback we never call this module.
//
// The flow is shaped around the "friendly rationale" requirement:
//
//   1. `getMicPermissionStatus()` — non-blocking peek. Returns the last
//      cached/persisted value so the UI can render the rationale without
//      blocking on a permissions IPC.
//   2. `requestMicPermission({ rationale })` — fires the runtime prompt.
//      Persists a `"denied"` outcome so subsequent calls can show "open
//      Settings" instead of re-asking (Android's `NEVER_ASK_AGAIN` and
//      iOS's silent-deny both fall under this).
//
// We persist denial state in `SecureStore` on native and `localStorage` on
// web — same backend pattern the pairing store uses (see `pairing/store.ts`).
// Persistence is best-effort: a failed write doesn't reject the promise.

import { PermissionsAndroid, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Storage key for the persisted permission outcome. */
export const MIC_PERMISSION_STATE_KEY = 'openclaw.voice.mic.state';

/**
 * Discriminated permission outcomes the UI cares about.
 *
 *  - `"granted"`   — mic capture is allowed; the PTT screen can proceed.
 *  - `"denied"`    — user said no this turn; we may re-prompt next launch.
 *  - `"blocked"`   — user said no _and_ Android's "Don't ask again" /
 *                    iOS's permanent deny is in effect. UI should deep-link
 *                    into Settings instead of re-prompting.
 *  - `"unavailable"` — the platform has no mic (e.g. web fallback, sim
 *                      without a microphone). UI shows a placeholder.
 *  - `"unknown"`    — initial state; we haven't asked yet.
 */
export type MicPermissionStatus = 'granted' | 'denied' | 'blocked' | 'unavailable' | 'unknown';

/** Options for {@link requestMicPermission}. */
export interface RequestMicPermissionOptions {
  /**
   * Title + body shown above the OS prompt on Android. iOS reads its copy
   * from `Info.plist`'s `NSMicrophoneUsageDescription`, so the rationale
   * here is ignored on iOS — we still accept the prop so the call sites
   * read identically across platforms.
   */
  rationale?: { title: string; message: string };
}

/**
 * Optional dependency-injection seam so tests can swap out:
 *
 *  - `Platform.OS`        — to exercise iOS/Android/web branches.
 *  - `PermissionsAndroid` — to assert the right `request` call.
 *  - `navigator`          — to drive the web `getUserMedia` happy path.
 *  - `SecureStore`        — to avoid touching native Keychain in jest.
 *
 * Production callers don't pass overrides; the module's defaults (real
 * RN primitives + `expo-secure-store`) take over.
 */
export interface MicPermissionsDeps {
  platformOS?: typeof Platform.OS;
  permissionsAndroid?: typeof PermissionsAndroid;
  /** A pluggable `navigator`-like with `mediaDevices.getUserMedia`. */
  webNavigator?: {
    mediaDevices?: {
      getUserMedia?: (constraints: {
        audio: boolean;
      }) => Promise<{ getTracks(): Array<{ stop(): void }> }>;
    };
  };
  /** Pluggable secure-store-like; matches `expo-secure-store`'s API. */
  secureStore?: {
    setItemAsync(key: string, value: string): Promise<void>;
    getItemAsync(key: string): Promise<string | null>;
    deleteItemAsync(key: string): Promise<void>;
  };
  /** Pluggable web localStorage — used when `platformOS === 'web'`. */
  localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void };
}

/** Resolve the dependency bundle for a single call. */
function resolveDeps(deps: MicPermissionsDeps | undefined): Required<MicPermissionsDeps> {
  return {
    platformOS: deps?.platformOS ?? Platform.OS,
    permissionsAndroid: deps?.permissionsAndroid ?? PermissionsAndroid,
    webNavigator:
      deps?.webNavigator ??
      (typeof globalThis !== 'undefined'
        ? ((globalThis as unknown as { navigator?: MicPermissionsDeps['webNavigator'] })
            .navigator ?? {})
        : {}),
    secureStore: deps?.secureStore ?? SecureStore,
    localStorage:
      deps?.localStorage ??
      (typeof globalThis !== 'undefined'
        ? ((globalThis as unknown as { localStorage?: MicPermissionsDeps['localStorage'] })
            .localStorage ?? { getItem: () => null, setItem: () => undefined })
        : { getItem: () => null, setItem: () => undefined }),
  };
}

/** Best-effort persist. Errors are swallowed; callers don't care. */
async function persistStatus(
  deps: Required<MicPermissionsDeps>,
  status: MicPermissionStatus,
): Promise<void> {
  try {
    if (deps.platformOS === 'web') {
      deps.localStorage.setItem(MIC_PERMISSION_STATE_KEY, status);
      return;
    }
    await deps.secureStore.setItemAsync(MIC_PERMISSION_STATE_KEY, status);
  } catch {
    /* persistence is best-effort; the UI re-derives next launch */
  }
}

/** Read the last persisted status. Falls back to `"unknown"` on miss. */
async function readStoredStatus(deps: Required<MicPermissionsDeps>): Promise<MicPermissionStatus> {
  try {
    const raw =
      deps.platformOS === 'web'
        ? deps.localStorage.getItem(MIC_PERMISSION_STATE_KEY)
        : await deps.secureStore.getItemAsync(MIC_PERMISSION_STATE_KEY);
    if (
      raw === 'granted' ||
      raw === 'denied' ||
      raw === 'blocked' ||
      raw === 'unavailable' ||
      raw === 'unknown'
    ) {
      return raw;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Non-blocking peek at the persisted permission outcome. The UI calls this
 * on mount to decide whether to render the rationale, the PTT button, or
 * the "open Settings" CTA — without waiting on a runtime IPC.
 */
export async function getMicPermissionStatus(
  deps?: MicPermissionsDeps,
): Promise<MicPermissionStatus> {
  const resolved = resolveDeps(deps);
  // Web's `navigator` is the source of truth — `permissions.query` would be
  // more precise but isn't universally supported in RN web yet.
  if (resolved.platformOS === 'web') {
    if (!resolved.webNavigator?.mediaDevices?.getUserMedia) return 'unavailable';
    return readStoredStatus(resolved);
  }
  return readStoredStatus(resolved);
}

/**
 * Request the microphone permission. On native this fires the runtime OS
 * prompt; on web it triggers the browser permission UI via
 * `navigator.mediaDevices.getUserMedia({ audio: true })` (and immediately
 * stops the returned tracks — we only wanted the prompt outcome).
 *
 * The returned status is also persisted so the next launch's
 * `getMicPermissionStatus()` can short-circuit.
 */
export async function requestMicPermission(
  options: RequestMicPermissionOptions = {},
  deps?: MicPermissionsDeps,
): Promise<MicPermissionStatus> {
  const resolved = resolveDeps(deps);
  const os = resolved.platformOS;

  if (os === 'android') {
    const rationale = options.rationale
      ? {
          title: options.rationale.title,
          message: options.rationale.message,
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        }
      : undefined;
    const result = await resolved.permissionsAndroid.request(
      resolved.permissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      rationale,
    );
    let status: MicPermissionStatus;
    if (result === resolved.permissionsAndroid.RESULTS.GRANTED) {
      status = 'granted';
    } else if (result === resolved.permissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
      status = 'blocked';
    } else {
      status = 'denied';
    }
    await persistStatus(resolved, status);
    return status;
  }

  if (os === 'ios') {
    // iOS doesn't expose a synchronous permission API in pure JS. The
    // canonical path is to call `mediaDevices.getUserMedia({ audio: true })`
    // via `react-native-webrtc` — the first call surfaces the OS prompt and
    // the resolution maps cleanly onto our status. We don't import
    // `react-native-webrtc` here to keep the permissions module portable
    // (tests don't need the native module loaded just to assert status
    // bookkeeping); the caller in `webrtc.ts` is expected to invoke
    // `getUserMedia` separately after `requestMicPermission` resolves.
    //
    // For now, optimistically persist `granted` on iOS and let the WebRTC
    // open call surface a `denied` outcome via its error handler. A
    // follow-up can wire `react-native-webrtc`'s native permission helper
    // directly when it exists in this RN version.
    await persistStatus(resolved, 'granted');
    return 'granted';
  }

  if (os === 'web') {
    const getUserMedia = resolved.webNavigator?.mediaDevices?.getUserMedia;
    if (!getUserMedia) {
      await persistStatus(resolved, 'unavailable');
      return 'unavailable';
    }
    try {
      const stream = await getUserMedia({ audio: true });
      // Stop the tracks immediately — we only wanted the prompt outcome.
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      await persistStatus(resolved, 'granted');
      return 'granted';
    } catch {
      // The web API doesn't distinguish "deny" from "deny-permanent" — we
      // mark as `denied` and let the UI re-prompt next visit. The user
      // can manually escalate via the browser's address-bar permission UI.
      await persistStatus(resolved, 'denied');
      return 'denied';
    }
  }

  // Unknown platform — treat as unavailable so the UI degrades gracefully.
  await persistStatus(resolved, 'unavailable');
  return 'unavailable';
}

/**
 * Friendly rationale copy reused by the voice screen and the runtime
 * prompt. Lifted out of the screen so multiple call sites (the screen, a
 * future "permissions" settings page) can share the same string.
 */
export const MIC_PERMISSION_RATIONALE = {
  title: 'Allow OpenClaw to use the microphone',
  message:
    'OpenClaw streams your voice to your agent on the Mac only while you hold the push-to-talk button. Audio is not recorded otherwise.',
} as const;

/**
 * Test-only helper: forget the persisted state so a subsequent
 * `getMicPermissionStatus` returns `"unknown"`. Production code never
 * invokes this — exported so the unit tests can keep a stable baseline.
 */
export async function _clearMicPermissionState(deps?: MicPermissionsDeps): Promise<void> {
  const resolved = resolveDeps(deps);
  try {
    if (resolved.platformOS === 'web') {
      // No web `removeItem` shim in our minimal contract — we overwrite
      // with `unknown` instead, which `readStoredStatus` normalizes.
      resolved.localStorage.setItem(MIC_PERMISSION_STATE_KEY, 'unknown');
      return;
    }
    await resolved.secureStore.deleteItemAsync(MIC_PERMISSION_STATE_KEY);
  } catch {
    /* ignore */
  }
}
