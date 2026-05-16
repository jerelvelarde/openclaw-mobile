// Babel config for the Expo mobile app. `babel-preset-expo` ships with Expo
// Router support and the worklets/reanimated transforms; we don't need any
// extra plugins until per-feature plans introduce them.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
  };
};
