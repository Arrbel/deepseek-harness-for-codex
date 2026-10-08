import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  clean: true,
  dts: false,
  format: ["esm"],
  minify: false,
  outDir: "dist",
  platform: "node",
  target: "node22",
  // Bundle runtime dependencies into the single published entry so the built
  // plugin directory is self-contained: Codex copies plugin files into its own
  // cache, where the checkout's node_modules is not reachable.
  deps: { alwaysBundle: (id: string) => !id.startsWith("node:") },
});
