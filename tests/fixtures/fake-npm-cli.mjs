// Deterministic stand-in for `npm-cli.js` used by tests/unit/runtime-package.test.ts.
//
// It is invoked exactly like the real CLI
//   node fake-npm-cli.mjs install --prefix <dir> --no-save --no-audit --no-fund <spec>
// and either materialises the package tree the runtime-package module expects, or fails
// with a requested npm error signature. Every invocation is appended to
// FAKE_NPM_COUNTER, which is how the idempotency assertions count npm calls.
//
//   FAKE_NPM_MODE       ok (default) | etarget | e404 | enotcached | network |
//                       unknown-failure | no-bin | missing-bin-file | wrong-version
//   FAKE_NPM_COUNTER    file the invocation log is appended to
//   FAKE_NPM_DELAY_MS   artificial install delay (concurrency tests)

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
const prefix = prefixIndex === -1 ? null : args[prefixIndex + 1] ?? null;
const spec = args[args.length - 1] ?? "";
const counter = process.env.FAKE_NPM_COUNTER;
const mode = process.env.FAKE_NPM_MODE ?? "ok";
const delayMs = Number.parseInt(process.env.FAKE_NPM_DELAY_MS ?? "0", 10);

if (counter !== undefined && counter !== "") {
  // argv[0] is this script, mirroring the real spawn shape `node <npm-cli.js> install ...`.
  appendFileSync(counter, `${JSON.stringify({ argv: process.argv.slice(1), prefix, spec })}\n`, "utf8");
}

if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));

function npmError(code, lines) {
  process.stderr.write(`npm error code ${code}\n`);
  for (const line of lines) process.stderr.write(`npm error ${line}\n`);
  process.exit(1);
}

if (mode === "etarget") {
  npmError("ETARGET", [`notarget No matching version found for ${spec}.`, "notarget In most cases you or one of your dependencies are requesting"]);
}
if (mode === "e404") {
  npmError("E404", ["404 No match found for version", `404 '${spec}' is not in this registry.`]);
}
if (mode === "enotcached") {
  npmError("ENOTCACHED", ["request to https://registry.example.com/@deepseek-ai%2fdsh failed: cache mode is 'only-if-cached' but no cached response is available."]);
}
if (mode === "network") {
  npmError("ECONNRESET", ["request to https://registry.example.com/ failed, reason: socket hang up"]);
}
if (mode === "unknown-failure") {
  npmError("EUNKNOWN", ["something nobody classified happened"]);
}

// mode=chatty keeps printing progress well past a short install budget: the budget must
// reset on every line instead of failing a progressing install.
if (mode === "chatty") {
  for (let index = 0; index < 10; index += 1) {
    process.stdout.write(`npm http fetch GET 200 https://registry.example.com/step-${String(index)} 12ms\n`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 300));
  }
}

if (prefix === null) {
  process.stderr.write("npm error usage: fake-npm-cli.mjs install --prefix <dir> <spec>\n");
  process.exit(1);
}

const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const version = mode === "wrong-version" ? "0.0.0-other" : spec.slice(at + 1);
const packageDir = join(prefix, "node_modules", ...name.split("/"));
mkdirSync(join(packageDir, "lib"), { recursive: true });

const manifest = { name, version, type: "module" };
if (mode !== "no-bin") manifest.bin = { dsh: "lib/bin.js" };
writeFileSync(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
if (mode !== "missing-bin-file") {
  writeFileSync(join(packageDir, "lib", "bin.js"), "#!/usr/bin/env node\nprocess.stdout.write('fake dsh\\n');\n", "utf8");
}
process.stdout.write("added 558 packages in 1s\n");
