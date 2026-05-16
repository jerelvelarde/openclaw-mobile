// Expo dynamic config.
//
// Replaces the previous static `app.json` so we can declaratively configure
// the native iOS `Info.plist` entries and Android permissions that
// `react-native-zeroconf` requires once the project moves to a custom dev
// client (see `.chalk/plans/P04A-mobile-transport.md` §steps and §notes).
//
// Concretely:
//
// - `ios.infoPlist.NSLocalNetworkUsageDescription` — required since iOS 14 for
//   any app that uses Bonjour / multicast on the local network. Without this
//   key (and the matching purpose string), Apple's mDNS APIs return no
//   results and the App Store rejects the build.
// - `ios.infoPlist.NSBonjourServices` — explicit allow-list of service types
//   we plan to browse / advertise. We only need `_openclaw._tcp` since we're
//   never browsing for anything else.
// - `ios.infoPlist.NSMicrophoneUsageDescription` — required by Apple for any
//   app that records audio. Without it, the OS denies the permission silently
//   and `react-native-webrtc` can't open the mic. P07A adds the friendly
//   rationale string; the runtime permission prompt is fired by `permissions.ts`.
// - `ios.infoPlist.UIBackgroundModes: ["audio"]` — keeps audio capture +
//   playback alive while the screen locks during a voice turn (P07A). Full
//   CallKit/PushKit interop is post-v1; this entitlement covers the common
//   "phone goes to sleep mid-turn" case.
// - `android.permissions` — `INTERNET` is implicit but listed for clarity;
//   `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE` are what the
//   `react-native-zeroconf` README calls out as required for multicast
//   discovery on Android. The library acquires a multicast lock at runtime;
//   without `CHANGE_WIFI_MULTICAST_STATE` the lock attempt is a no-op and
//   discovery silently fails on Wi-Fi. P07A adds `RECORD_AUDIO` (mic), plus
//   `MODIFY_AUDIO_SETTINGS` + `BLUETOOTH` so `react-native-webrtc` can route
//   audio through the loudspeaker and Bluetooth headsets. Foreground service
//   for an active voice call (so Android won't kill the mic when the screen
//   sleeps) is a stub for v1 — we declare the `FOREGROUND_SERVICE` permission
//   here and the runtime hook in `usePushToTalk.ts` is a no-op until a
//   proper notification service ships post-v1. P08A adds `POST_NOTIFICATIONS`
//   so Android 13+ can prompt for the runtime notification permission that
//   `expo-notifications` requests when we register for an Expo push token.
//
// - `ios.entitlements["aps-environment"] = "development"` — P08A adds the
//   APNs entitlement required for push notifications. Apple gates push
//   token issuance behind this entitlement; the production build flips
//   the value to `"production"` (handled at EAS time, post-v1). Without
//   the entitlement, `Notifications.getDevicePushTokenAsync()` fails on
//   real hardware with a misleading "no valid 'aps-environment' entitlement"
//   error.
//
// - `plugins: ['expo-notifications', ...]` — registers the Expo notifications
//   config plugin so the prebuild step wires the iOS + Android native modules
//   without us hand-editing `Info.plist` / `AndroidManifest.xml`. We don't
//   pass options today; if we later want a custom notification icon /
//   sound for Android we'd thread that through here.
//
// We keep all other settings identical to the prior `app.json` so the
// switch is purely additive — `expo prebuild` will regenerate the native
// projects from this config.

import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'OpenClaw',
  slug: 'openclaw-mobile',
  version: '0.0.0',
  orientation: 'portrait',
  scheme: 'openclaw',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.openclaw.mobile',
    infoPlist: {
      // Shown in the OS prompt the first time we hit the local network.
      // Keep the copy honest about *why* we want it (Bonjour discovery for
      // the OpenClaw desktop pairing flow) — generic strings cause review
      // friction on the App Store.
      NSLocalNetworkUsageDescription:
        'OpenClaw discovers your Mac on the local Wi-Fi network so you can pair without typing an address.',
      NSBonjourServices: ['_openclaw._tcp'],
      // P07A — mic + background audio.
      NSMicrophoneUsageDescription:
        'OpenClaw uses your microphone to send voice to your agent on the Mac. Audio leaves your phone only while you hold the push-to-talk button.',
      UIBackgroundModes: ['audio'],
    },
    // P08A — APNs entitlement required for push notifications. EAS / a
    // production build will overwrite this to "production"; "development"
    // is the right value while we're driving from a dev client + Expo's
    // push service against the sandbox APNs gateway.
    entitlements: {
      'aps-environment': 'development',
    },
  },
  android: {
    package: 'com.openclaw.mobile',
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    // `INTERNET` is implicit but listing it documents intent. The two Wi-Fi
    // entries are what react-native-zeroconf needs to acquire a multicast
    // lock for mDNS browse on Wi-Fi. `RECORD_AUDIO` + audio-routing + BT
    // entries are required by `react-native-webrtc` for the mic capture and
    // speaker/headset switching in P07A. `FOREGROUND_SERVICE` is declared
    // ahead of the post-v1 active-call service (stub today).
    permissions: [
      'INTERNET',
      'ACCESS_WIFI_STATE',
      'CHANGE_WIFI_MULTICAST_STATE',
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'BLUETOOTH',
      'BLUETOOTH_ADMIN',
      'FOREGROUND_SERVICE',
      // P08A — Android 13+ runtime permission. `expo-notifications` requests
      // this when we call `requestPermissionsAsync()` during push registration.
      'POST_NOTIFICATIONS',
    ],
  },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  plugins: ['expo-router', '@config-plugins/react-native-webrtc', 'expo-notifications'],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
