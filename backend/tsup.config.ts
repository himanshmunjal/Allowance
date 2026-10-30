import { defineConfig } from "tsup";

// Bundles src/ into dist/server.js; npm dependencies (incl. the native better-sqlite3) stay external.
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
});
