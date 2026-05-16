// Jest config for the mobile app. Uses the `jest-expo` preset so
// react-native, expo modules, and TS transforms all line up with the version
// of Expo SDK we depend on. `setupFilesAfterEach` (for matchers like
// `@testing-library/jest-native/extend-expect`) is left empty for now and
// wired in alongside the first feature that needs custom matchers.
module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|@openclaw/protocol))',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@openclaw/protocol$': '<rootDir>/../../packages/protocol/src/index.ts',
  },
};
