// Structural model of a GitHub workflow, built on the local YAML reader (`./yaml.ts`).
//
// The release workflow cannot be executed locally, so its *structure* is what the suite can
// hold to account: which triggers it has, which permissions each job effectively runs with,
// and whether a step performs a publishing action. Every query below returns findings with the
// job/step that produced them, so a failure message names the offending step instead of just
// "the file changed".
//
// **What this module can and cannot see (R5-3)**: the command matching here is a *static text
// scan* that tolerates flags between the manager and the subcommand (`npm --prefix . publish`),
// quote concatenation (`npm p''ublish`), `npm.cmd`, and direct registry HTTP — but it cannot see
// dynamically built commands (`node -e`, `bash -c "$CMD"`, base64), a publish performed by a
// third-party action whose name does not contain "publish", credentials injected from outside
// the tree, install scripts of third-party dependencies, or a publish run by hand. The full,
// authoritative list lives in the module header of `./publish-surface.ts` (which owns the
// patterns) and in `reports/r5-publish-surface.md`; keep the three in sync.

import { readFileSync } from "node:fs";
import { asMapping, asSequence, asString, parseYaml, type YamlMapping, type YamlValue } from "./yaml.js";
import { findPublishCommands, findRegistryCredentials } from "./publish-surface.js";

/** One workflow step, flattened with its owning job. */
export interface WorkflowStep {
  readonly job: string;
  readonly index: number;
  readonly label: string;
  readonly name: string | null;
  readonly uses: string | null;
  readonly run: string | null;
  readonly id: string | null;
  readonly condition: string | null;
  readonly with: YamlMapping;
  readonly env: YamlMapping;
}

/** One workflow job. */
export interface WorkflowJob {
  readonly id: string;
  readonly name: string | null;
  readonly runsOn: string | null;
  readonly permissions: YamlMapping;
  readonly needs: readonly string[];
  readonly steps: readonly WorkflowStep[];
  /** The job's own mapping, for assertions that need a field this model does not surface. */
  readonly raw: YamlMapping;
}

/** A parsed workflow. */
export interface Workflow {
  readonly path: string;
  readonly name: string | null;
  readonly triggers: YamlMapping;
  readonly permissions: YamlMapping;
  readonly jobs: readonly WorkflowJob[];
  readonly document: YamlValue;
}

/** Something that would reach a package registry. */
export interface WorkflowFinding {
  readonly job: string;
  readonly step: string;
  readonly reason: string;
}

// Command/credential patterns live in `./publish-surface.ts` so the workflow-level and
// repository-level scans cannot drift apart (R5-3 replaced the stricter local regex that missed
// `npm --prefix . publish`). Only the two key-shaped checks remain here.
/** Actions that upload a package to a registry. */
const PUBLISH_ACTION = /publish/u;
/** Registry authentication wiring: the token a publication needs. */
const REGISTRY_AUTH_ENV = /^(NODE_AUTH_TOKEN|NPM_TOKEN|NPM_CONFIG__AUTH|YARN_NPM_AUTH_TOKEN)$/u;

function parseSteps(jobId: string, value: YamlValue | undefined): WorkflowStep[] {
  const steps = asSequence(value, `jobs.${jobId}.steps`);
  return steps.map((entry, index) => {
    const step = asMapping(entry, `jobs.${jobId}.steps[${String(index)}]`);
    const uses = asString(step["uses"]);
    const name = asString(step["name"]);
    const run = asString(step["run"]);
    return {
      job: jobId,
      index,
      label: `jobs.${jobId}.steps[${String(index)}] (${name ?? uses ?? run ?? "unnamed"})`,
      name,
      uses,
      run,
      id: asString(step["id"]),
      condition: asString(step["if"]),
      with: step["with"] === undefined || step["with"] === null ? {} : asMapping(step["with"], `jobs.${jobId}.steps[${String(index)}].with`),
      env: step["env"] === undefined || step["env"] === null ? {} : asMapping(step["env"], `jobs.${jobId}.steps[${String(index)}].env`),
    };
  });
}

function asStringList(value: YamlValue | undefined, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  return asSequence(value, where).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
}

/** Reads and structurally validates a workflow file. */
export function loadWorkflow(path: string): Workflow {
  const document = parseYaml(readFileSync(path, "utf8"));
  const root = asMapping(document, "the workflow document");
  const jobsMapping = asMapping(root["jobs"], "jobs");
  const jobs: WorkflowJob[] = Object.entries(jobsMapping).map(([id, value]) => {
    const job = asMapping(value, `jobs.${id}`);
    const rawPermissions = job["permissions"];
    const runsOn = job["runs-on"];
    return {
      id,
      name: asString(job["name"]),
      runsOn: typeof runsOn === "string" ? runsOn : null,
      permissions: rawPermissions === undefined || rawPermissions === null
        ? {}
        : asMapping(rawPermissions, `jobs.${id}.permissions`),
      needs: asStringList(job["needs"], `jobs.${id}.needs`),
      steps: job["steps"] === undefined || job["steps"] === null ? [] : parseSteps(id, job["steps"]),
      raw: job,
    };
  });
  return {
    path,
    name: asString(root["name"]),
    triggers: asMapping(root["on"], "on"),
    permissions: root["permissions"] === undefined || root["permissions"] === null
      ? {}
      : asMapping(root["permissions"], "permissions"),
    jobs,
    document,
  };
}

/** Every step of every job, in file order. */
export function allSteps(workflow: Workflow): WorkflowStep[] {
  return workflow.jobs.flatMap((job) => [...job.steps]);
}

/** Every `run:` scalar of every job, in file order. */
export function allRunScripts(workflow: Workflow): { job: string; step: WorkflowStep; script: string }[] {
  return allSteps(workflow)
    .filter((step) => step.run !== null)
    .map((step) => ({ job: step.job, step, script: step.run ?? "" }));
}

/** The job that contains a given step. */
export function jobOf(workflow: Workflow, step: WorkflowStep): WorkflowJob {
  const job = workflow.jobs.find((candidate) => candidate.id === step.job);
  if (job === undefined) throw new Error(`no job ${step.job} in ${workflow.path}`);
  return job;
}

/**
 * The permissions a job effectively runs with.
 *
 * GitHub replaces the workflow-level `permissions` with the job-level block when a job declares
 * one (it does not merge), so the assertion below is about the permissions the runner really
 * has — not about where they were written.
 */
export function effectivePermissions(workflow: Workflow, job: WorkflowJob): YamlMapping {
  return Object.keys(job.permissions).length > 0 ? job.permissions : workflow.permissions;
}

/**
 * Every step that reaches a registry: a registry-mutating command in `run:` (with the tolerant
 * patterns described in the module header) or a publishing action in `uses:`.
 */
export function findPublishActions(workflow: Workflow): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const step of allSteps(workflow)) {
    if (step.run !== null) {
      for (const finding of findPublishCommands(step.run, step.label)) {
        if (finding.kind !== "publish") continue;
        findings.push({ job: step.job, step: step.label, reason: finding.reason });
      }
    }
    if (step.uses !== null && PUBLISH_ACTION.test(step.uses)) {
      findings.push({ job: step.job, step: step.label, reason: `uses: ${step.uses} looks like a publishing action` });
    }
  }
  return findings;
}

/**
 * Every place a registry credential or endpoint is wired in, which a publish would require:
 * `with`/`env` keys and values, and credential shapes in the `run:` text.
 */
export function findRegistryAuthWiring(workflow: Workflow): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const step of allSteps(workflow)) {
    for (const key of Object.keys(step.with)) {
      if (/registry(-url)?/iu.test(key)) {
        findings.push({ job: step.job, step: step.label, reason: `with.${key} configures a registry endpoint` });
      }
    }
    for (const key of Object.keys(step.env)) {
      if (REGISTRY_AUTH_ENV.test(key)) {
        findings.push({ job: step.job, step: step.label, reason: `env.${key} is a registry token` });
      }
    }
    for (const [key, value] of [...Object.entries(step.with), ...Object.entries(step.env)]) {
      if (typeof value !== "string") continue;
      for (const finding of findRegistryCredentials(value, `with/env.${key}`)) {
        findings.push({ job: step.job, step: step.label, reason: `${key}: ${finding.reason}` });
      }
    }
    if (step.run !== null) {
      for (const finding of findRegistryCredentials(step.run, step.label)) {
        findings.push({ job: step.job, step: step.label, reason: finding.reason });
      }
    }
  }
  return findings;
}

/** Every step that would write to the repository (a release job must not). */
export function findRepoWrites(workflow: Workflow): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const step of allSteps(workflow)) {
    const script = step.run ?? "";
    if (/\bgit\s+(push|commit|tag)\b/u.test(script)) {
      findings.push({ job: step.job, step: step.label, reason: "run: writes to the repository" });
    }
  }
  return findings;
}

/** Steps that use a given action (matched by prefix, so `@v4` tags are covered). */
export function stepsUsing(workflow: Workflow, action: string): WorkflowStep[] {
  return allSteps(workflow).filter((step) => (step.uses ?? "").startsWith(action));
}

/** A string found somewhere in the parsed document, with its path. */
export interface LocatedString {
  readonly path: string;
  readonly value: string;
}

/** Every string in the parsed document (keys included), with a dotted path. */
export function collectStrings(value: YamlValue, prefix = ""): LocatedString[] {
  if (typeof value === "string") return [{ path: prefix, value }];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectStrings(entry, `${prefix}[${String(index)}]`));
  }
  return Object.entries(value).flatMap(([key, entry]) => [
    { path: `${prefix}.${key}`, value: key },
    ...collectStrings(entry, `${prefix}.${key}`),
  ]);
}

/**
 * Anything in the whole document (keys and values alike) that could publish or authenticate,
 * using the same tolerant command patterns as the step-level scan (`./publish-surface.ts`).
 */
export function findSuspiciousStrings(workflow: Workflow): (LocatedString & { reason: string })[] {
  const findings: (LocatedString & { reason: string })[] = [];
  for (const { path, value } of collectStrings(workflow.document)) {
    for (const finding of findPublishCommands(value, path)) {
      findings.push({ path, value, reason: finding.reason });
    }
    for (const finding of findRegistryCredentials(value, path)) {
      findings.push({ path, value, reason: finding.reason });
    }
    if (/registry(-?url)?$/iu.test(path)) findings.push({ path, value, reason: "configures a registry endpoint" });
    if (REGISTRY_AUTH_ENV.test(value)) findings.push({ path, value, reason: "names a registry token" });
    if (/\.uses$/u.test(path) && PUBLISH_ACTION.test(value)) {
      findings.push({ path, value, reason: "references an action that publishes" });
    }
  }
  return findings;
}

/** The `path:` values of every `actions/upload-artifact` step. */
export function artifactPaths(workflow: Workflow): { step: WorkflowStep; path: string; name: string | null; ifNoFilesFound: string | null }[] {
  return stepsUsing(workflow, "actions/upload-artifact").map((step) => ({
    step,
    path: asString(step.with["path"]) ?? "",
    name: asString(step.with["name"]),
    ifNoFilesFound: asString(step.with["if-no-files-found"]),
  }));
}
