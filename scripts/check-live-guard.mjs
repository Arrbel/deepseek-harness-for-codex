// Precondition gate for `npm run check:live`.
//
// Why this exists: the live suite is gated by `describe.runIf(process.env.DSH_LIVE === "1")`.
// Without that variable Vitest collects the file, runs zero tests, and exits 0 — a green
// "live check" that proved nothing (the defect recorded in `reports/final-acceptance.md` §3).
// This guard turns that silent no-op into a loud, actionable failure.
//
// It deliberately does NOT execute the suite; `npm run check:live` chains it before Vitest.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const enabled = process.env.DSH_LIVE === "1";

if (!enabled) {
  const shown = process.env.DSH_LIVE === undefined ? "(unset)" : JSON.stringify(process.env.DSH_LIVE);
  process.stderr.write([
    "",
    `check:live refused to run: DSH_LIVE is ${shown}, but the live suite only runs when DSH_LIVE=1.`,
    "Running it anyway would execute zero tests and still exit 0, which proves nothing.",
    "",
    "To run the real smoke (needs network, about 60 s and ~486 MB of disk):",
    "  PowerShell:  $env:DSH_LIVE=1; $env:DSH_MCP_DATA_DIR='<scratch>\\data'; npm run check:live",
    "  bash:        DSH_LIVE=1 DSH_MCP_DATA_DIR=<scratch>/data npm run check:live",
    "",
    "DSH_MCP_DATA_DIR is optional: when it is unset the suite installs into a fresh temp directory.",
    "",
  ].join("\n"));
  process.exit(2);
}

const dataDirectory = process.env.DSH_MCP_DATA_DIR?.trim();
const effective = dataDirectory === undefined || dataDirectory === ""
  ? join(tmpdir(), `dsh-live-${randomUUID().slice(0, 8)}`, "data")
  : dataDirectory;

process.stdout.write(`check:live precondition OK: DSH_LIVE=1, data directory = ${effective}\n`);
