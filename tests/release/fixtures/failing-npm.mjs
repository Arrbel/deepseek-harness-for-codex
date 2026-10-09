// Stands in for `npm-cli.js` in the failure-path test: it reproduces the diagnostics npm emits
// when `package-lock.json` describes packages that are not installed (`ESBOMPROBLEMS`).
process.stderr.write("npm error code ESBOMPROBLEMS\n");
process.stderr.write("npm error missing: zod@4.4.3, required by deepseek-harness-for-codex@0.4.0\n");
process.exit(1);
