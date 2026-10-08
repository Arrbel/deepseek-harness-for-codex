// Vitest configuration.
//
// The only thing configured here is **coverage**, and coverage is deliberately NOT part of
// `npm run check`: `npm run coverage` is a separate, non-gating diagnostic command. There are
// no thresholds and no reporters that fail a build — a coverage number that fails CI
// pressure-tests the tests into "run the line once" filler.
//
// `test.include` is intentionally left at vitest's default so this file cannot change which
// suites are discovered.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // `text` for the console baseline, `json-summary` so the report can quote exact
      // per-directory numbers without re-running the suite.
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      // A diagnostic must still report its numbers when a test is red: the coverage of everything
      // that did run is exactly what you need to interpret the failure. `reportOnFailure` does not
      // change any exit code, so this stays non-gating.
      reportOnFailure: true,
      // Count every source file, including ones no test currently imports: an unexecuted
      // module is exactly the kind of gap a baseline must make visible.
      include: ["src/**/*.ts"],
      exclude: ["src/version.ts", "**/*.d.ts"],
    },
  },
});
