import { defineConfig } from "tsup";

// tsup synthesizes a virtual ts project for its DTS build that doesn't
// inherit `composite`-mode file lists from `tsconfig.json`. Pointing it at a
// build-only tsconfig (no `composite`, no test-file glob) sidesteps the
// TS6307 "file is not listed within the file list of project ''" error.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  tsconfig: "tsconfig.build.json",
  clean: true,
  sourcemap: true,
  target: "es2022",
});
