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
// - `android.permissions` — `INTERNET` is implicit but listed for clarity;
//   `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE` are what the
//   `react-native-zeroconf` README calls out as required for multicast
//   discovery on Android. The library acquires a multicast lock at runtime;
//   without `CHANGE_WIFI_MULTICAST_STATE` the lock attempt is a no-op and
//   discovery silently fails on Wi-Fi.
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
    },
  },
  android: {
    package: 'com.openclaw.mobile',
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    // `INTERNET` is implicit but listing it documents intent. The two Wi-Fi
    // entries are what react-native-zeroconf needs to acquire a multicast
    // lock for mDNS browse on Wi-Fi.
    permissions: ['INTERNET', 'ACCESS_WIFI_STATE', 'CHANGE_WIFI_MULTICAST_STATE'],
  },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  plugins: ['expo-router'],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
