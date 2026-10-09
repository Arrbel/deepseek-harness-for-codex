// R5-3: the "publish surface" net — what it can see, and what it honestly cannot.
//
// ── Capability (what this module *does* detect) ─────────────────────────────────────────────
//
// It is a **static text/structure scanner**, not a sandbox and not a shell interpreter. Given a
// workflow (already parsed, see `./yaml.ts`), `package.json#scripts`, `.npmrc` and the contents
// of `scripts/**`, it reports:
//
//   1. registry-mutating commands in any workflow `run:` script, tolerant of the shapes that
//      defeated the R4-1 detector: flags between the manager and the subcommand
//      (`npm --prefix . publish`), quote/shell concatenation (`npm p''ublish`), `npm.cmd`, and
//      `npm stage publish`;
//   2. **transitive script indirection**: `npm run <name>` is resolved through
//      `package.json#scripts` (cycle-safe, depth-limited) so `npm run release` where `release`
//      invokes a publish command is caught;
//   3. **file indirection one level deep**: `node <path>` targets that resolve to a file under
//      the scanned root are read and re-scanned, so `node scripts/publish.mjs` is caught *if*
//      the file is among the scanned files and its contents betray it;
//   4. **dormant** publish commands anywhere in `package.json#scripts` (not only the ones a
//      workflow happens to call);
//   5. `scripts/**` contents (the same command patterns plus the literal net), with JavaScript
//      comments removed first — prose that *describes* the rule (as this repository's own
//      docstrings do) is not executable, so it must not trip the net;
//   6. `.npmrc` credentials/endpoint overrides that a publication would need: `_authToken`,
//      `_auth`, `always-auth`, client certificates, `email`, and a non-default `registry=`
//      override;
//   7. workflow-level wiring: `secrets.*` references, registry tokens in `env:`, `registry-url`
//      style inputs, publishing actions in `uses:`, and `git push/commit/tag`.
//
// ── Blind spots (what it *cannot* detect — verified by the R5-3 adversarial pass) ────────────
//
// Any of these can publish from CI without a single finding here:
//
//   a. **dynamic construction**: `node -e '...'`, `bash -c "$CMD"`, base64/obfuscated payloads,
//      or reading the command from a file/env at runtime;
//   b. a publish performed by a third-party GitHub Action whose name and inputs contain neither
//      "publish" nor "registry" (a generic HTTP uploader, a release action with an `npm` mode);
//   c. network egress from an installed dependency's own install script — nothing in this
//      repository's files reveals it; mitigated by the root lifecycle-hook gate (R5-2) and, if
//      adopted, `npm ci --ignore-scripts`;
//   d. credentials that arrive from outside the tree (organisation/repository secrets injected
//      by the runner, a self-hosted runner's own `.npmrc`, machine-level env) — a workflow that
//      never mentions a token can still have one;
//   e. a *different* workflow file on another branch, in another repository, or in a
//      `workflow_run`/reusable-workflow chain that this tree does not contain;
//   f. YAML constructs the parser refuses (anchors/aliases/tags) — these fail the suite loudly
//      rather than scanning silently, which is fail-closed, not a blind spot;
//   g. any publish executed *by hand* on a machine with credentials — outside CI, outside this
//      net's reach by construction.
//
// The docstrings above are the contract: claims here must not outrun the code. The regression
// suite (`tests/release/publish-surface.test.ts`) pins both halves — the detected shapes as
// positive cases and the real repository as finding-free.

/** Where something was found, and why it counts as publication surface. */
export interface SurfaceFinding {
  readonly location: string;
  /**
   * `publish` reaches a registry; `credential` is a token a publication would need;
   * `endpoint` is a registry override, reported for review but not by itself a publication.
   */
  readonly kind: "publish" | "credential" | "endpoint";
  readonly reason: string;
  readonly text: string;
}

/**
 * Registry-mutating commands, in the grammar npm actually accepts: only *flags* may sit between
 * the manager and the subcommand (`npm --prefix . publish`), which is why this pattern is
 * flag-aware instead of "any text within N characters". That precision matters: prose such as
 * "npm runs it on pack/publish" (a legitimate message in this repository) must not match, while
 * every shape the R5-3 adversarial pass used as a bypass must.
 */
const MANAGED_PUBLISH = /\b(npm|pnpm|yarn)(\.cmd|\.exe)?\b(?:\s+-{1,2}[A-Za-z][\w-]*(?:[= ]\S+)?)*\s+(?:stage\s+)?(publish|unpublish|deprecate)\b/u;
/** npm's two-word staging command, which the `publish` pattern above also reaches. */
const PROVENANCE_FLAG = /--provenance\b/u;
/** Registry credentials, by environment variable or config key. */
const REGISTRY_CREDENTIAL = /\b(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG__AUTH|YARN_NPM_AUTH_TOKEN|NPM_CONFIG_OTP)\b|_authToken|_auth\b|always-auth/u;
/** Interactive/administrative registry authentication. */
const REGISTRY_AUTH_COMMAND = /\bnpm\s+(login|token|adduser|access|owner|profile|hook)\b/u;
/** A registry endpoint configured for publish, or a direct HTTP conversation with one. */
const DIRECT_REGISTRY_HTTP = /(curl|wget|Invoke-WebRequest|Invoke-RestMethod|http\.request|https\.request|fetch)\b[^\n]{0,200}?(registry\.npmjs\.(org|com)|registry\.yarnpkg\.com|https?:\/\/[^\s"'`]+\/-\/)/iu;
const REGISTRY_METHOD = /\b(PUT|POST|PATCH)\b[^\n]{0,120}?(registry\.|\/-\/)|(registry\.|\/-\/)[^\n]{0,120}?\b(PUT|POST|PATCH)\b/iu;
/** `.npmrc` keys that make a publication possible (or point it somewhere else). */
const NPMRC_CREDENTIAL_KEY = /^\s*(?:\/\/[^\s=]+\/?:)?(?:_authToken|_auth|_password|always-auth|email|certfile|keyfile|cafile)\s*=/iu;
const NPMRC_REGISTRY_KEY = /^\s*registry\s*=/iu;

/** Removes quote characters so shell concatenation (`npm p''ublish`) cannot hide a command. */
function normalizeShellText(text: string): string {
  return text.replace(/['"`]/gu, "").replace(/\\\r?\n/gu, " ").replace(/[ \t]+/gu, " ");
}

/**
 * Removes JavaScript comments from a source file (quote-aware), so that *prose* describing the
 * rule — which this repository is full of — cannot trip the net, while executable text is kept
 * verbatim. Shell scripts are intentionally not stripped: `#` has several meanings there, and a
 * false positive inside a workflow `run:` is loud and reviewable, whereas a silently skipped
 * command would not be.
 */
export function stripJsComments(text: string): string {
  let result = "";
  let quote: string | null = null;
  let inBlockComment = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index] ?? "";
    const next = text[index + 1];
    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index++;
      } else if (character === "\n") {
        result += "\n";
      }
      continue;
    }
    if (quote !== null) {
      result += character;
      if (character === "\\") {
        result += next ?? "";
        index++;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index++;
      result += "\n";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
    result += character;
  }
  return result;
}

/** Command-shape findings for one blob of text (a `run:` script, a package script, a file). */
export function findPublishCommands(text: string, location: string): SurfaceFinding[] {
  const normalized = normalizeShellText(text);
  const findings: SurfaceFinding[] = [];
  const managed = MANAGED_PUBLISH.exec(normalized);
  if (managed !== null) {
    findings.push({
      location,
      kind: "publish",
      reason: `registry-mutating command (${managed[3] ?? "publish"})`,
      text: managed[0].trim(),
    });
  }
  if (PROVENANCE_FLAG.test(normalized)) {
    findings.push({
      location,
      kind: "publish",
      reason: "--provenance is a publication flag",
      text: normalized.match(PROVENANCE_FLAG)?.[0] ?? "",
    });
  }
  if (REGISTRY_AUTH_COMMAND.test(normalized)) {
    findings.push({
      location,
      kind: "credential",
      reason: "authenticates against a registry",
      text: REGISTRY_AUTH_COMMAND.exec(normalized)?.[0] ?? "",
    });
  }
  if (DIRECT_REGISTRY_HTTP.test(normalized) || REGISTRY_METHOD.test(normalized)) {
    findings.push({
      location,
      kind: "publish",
      reason: "talks to a registry over HTTP without npm",
      text: normalized.slice(0, 120),
    });
  }
  return findings;
}

/** Credential-shape findings for one blob of text. */
export function findRegistryCredentials(text: string, location: string): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  const credential = REGISTRY_CREDENTIAL.exec(text);
  if (credential !== null) {
    findings.push({ location, kind: "credential", reason: `registry credential (${credential[0]})`, text: credential[0] });
  }
  const secret = /secrets\.[A-Za-z0-9_]+/u.exec(text);
  if (secret !== null) {
    findings.push({ location, kind: "credential", reason: "reads a repository secret", text: secret[0] });
  }
  return findings;
}

/** `npm run <name>` / `npm run-script <name>` references in a script body (flags tolerated). */
export function extractScriptReferences(text: string): string[] {
  const references: string[] = [];
  const pattern = /\bnpm\s+run(?:-script)?\s+((?:--?[A-Za-z-]+(?:=\S+)?\s+)*)([A-Za-z0-9:@._/-]+)/gu;
  for (const match of normalizeShellText(text).matchAll(pattern)) {
    const name = match[2];
    if (typeof name === "string" && name !== "") references.push(name);
  }
  return references;
}

/** `node <path>.mjs|cjs|js|ts` targets in a script body (flags and `--` tolerated). */
export function extractNodeScripts(text: string): string[] {
  const targets: string[] = [];
  const pattern = /\bnode\s+((?:--?[A-Za-z-]+(?:=\S+)?\s+)*)([A-Za-z0-9@._/-]+\.(?:mjs|cjs|js|ts))/gu;
  for (const match of normalizeShellText(text).matchAll(pattern)) {
    const target = match[2];
    if (typeof target === "string" && target !== "") targets.push(target.split("\\").join("/"));
  }
  return targets;
}

/**
 * Every script body reachable from `entry` through `npm run` (inclusive), cycle-safe.
 *
 * This is the fix for the "`npm run <script>`" blind spot: what a workflow runs is only half the
 * story, because the script it names can itself run something else.
 */
export function resolveScriptClosure(
  scripts: Record<string, string>,
  entry: string,
  limit = 16,
): { name: string; body: string }[] {
  const queue = [entry];
  const seen = new Set<string>();
  const closure: { name: string; body: string }[] = [];
  while (queue.length > 0 && closure.length < limit) {
    const name = queue.shift();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    const body = scripts[name];
    if (typeof body !== "string") continue;
    closure.push({ name, body });
    for (const reference of extractScriptReferences(body)) {
      if (!seen.has(reference)) queue.push(reference);
    }
  }
  return closure;
}

/** Findings for every `package.json#scripts` entry, including indirection through `npm run`. */
export function scanPackageScripts(scripts: Record<string, string>): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  for (const name of Object.keys(scripts)) {
    for (const entry of resolveScriptClosure(scripts, name)) {
      findings.push(...findPublishCommands(entry.body, `package.json#scripts["${entry.name}"]`));
      findings.push(...findRegistryCredentials(entry.body, `package.json#scripts["${entry.name}"]`));
    }
  }
  return findings;
}

/** Findings for `.npmrc` (missing file is not a finding). */
export function scanNpmrc(text: string | null): SurfaceFinding[] {
  if (text === null) return [];
  const findings: SurfaceFinding[] = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (NPMRC_CREDENTIAL_KEY.test(line)) {
      findings.push({
        location: `.npmrc:${String(index + 1)}`,
        kind: "credential",
        reason: "registry credential in .npmrc",
        text: trimmed,
      });
      continue;
    }
    if (NPMRC_REGISTRY_KEY.test(line)) {
      // A bare `registry=` only selects an endpoint; publishing still needs a credential, so it
      // is reported as an endpoint override (reviewed, not treated as a publication by itself).
      findings.push({
        location: `.npmrc:${String(index + 1)}`,
        kind: "endpoint",
        reason: "registry endpoint override",
        text: trimmed,
      });
    }
  }
  return findings;
}

/** Findings for the contents of `scripts/**` (the files that CI executes by path). */
export function scanScriptFiles(files: readonly { path: string; text: string }[]): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [];
  for (const file of files) {
    const text = /\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(file.path) ? stripJsComments(file.text) : file.text;
    findings.push(...findPublishCommands(text, file.path));
    findings.push(...findRegistryCredentials(text, file.path));
  }
  return findings;
}

/** The inputs the surface scan needs; everything except the workflow is optional. */
export interface PublishSurfaceInput {
  readonly packageScripts: Record<string, string>;
  readonly npmrc: string | null;
  readonly scriptFiles: readonly { path: string; text: string }[];
  /** `${relativePath}: ${reason}` for every workflow-level finding, plus `node <file>` targets. */
  readonly workflowFindings: readonly SurfaceFinding[];
  readonly workflowRunScripts: readonly { location: string; script: string }[];
}

/**
 * The whole surface: workflow scripts (with one level of `node <file>` indirection),
 * `package.json#scripts` (with transitive `npm run` indirection), `.npmrc`, and `scripts/**`.
 */
export function findPublishSurface(input: PublishSurfaceInput): SurfaceFinding[] {
  const findings: SurfaceFinding[] = [...input.workflowFindings];
  const byPath = new Map(input.scriptFiles.map((file) => [file.path.replace(/^\.\//u, ""), file]));

  for (const { location, script } of input.workflowRunScripts) {
    findings.push(...findPublishCommands(script, location));
    findings.push(...findRegistryCredentials(script, location));
    for (const reference of extractScriptReferences(script)) {
      for (const entry of resolveScriptClosure(input.packageScripts, reference)) {
        findings.push(...findPublishCommands(entry.body, `${location} -> package.json#scripts["${entry.name}"]`));
      }
    }
    for (const target of extractNodeScripts(script)) {
      const file = byPath.get(target) ?? byPath.get(target.replace(/^\.\//u, ""));
      if (file !== undefined) {
        const text = /\.(?:mjs|cjs|js|mts|cts|ts)$/u.test(file.path) ? stripJsComments(file.text) : file.text;
        findings.push(...findPublishCommands(text, `${location} -> ${file.path}`));
        findings.push(...findRegistryCredentials(text, `${location} -> ${file.path}`));
      }
    }
  }

  findings.push(...scanPackageScripts(input.packageScripts));
  findings.push(...scanNpmrc(input.npmrc));
  findings.push(...scanScriptFiles(input.scriptFiles));
  return findings;
}
