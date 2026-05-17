// Metro config for `apps/mobile` inside the pnpm-workspace monorepo.
//
// Mirrors the layout documented in Expo's official monorepo guide
// (https://docs.expo.dev/guides/monorepos/). The two non-default knobs are:
//
//   1. `watchFolders` — tell Metro to watch the entire repo root so changes
//      to `packages/protocol` (or any other workspace package) trigger
//      reloads inside the app.
//   2. `resolver.nodeModulesPaths` — explicit list covering both the app's
//      own `node_modules` *and* the repo root's `node_modules`, so hoisted
//      pnpm deps (e.g. `react`, `react-native`) resolve without falling
//      back to hierarchical lookup.
//
// `disableHierarchicalLookup` is left off because pnpm preserves the linker
// structure under each workspace's `node_modules/.pnpm` and Expo's default
// resolver handles symlinks correctly with the two settings above.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all files within the monorepo.
config.watchFolders = [workspaceRoot];

// 2. Resolve modules from both the app and the repo root.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// 3. Force Metro to follow symlinks (pnpm uses them heavily).
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
