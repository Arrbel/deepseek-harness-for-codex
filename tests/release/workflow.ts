// Structural model of a GitHub workflow, built on the local YAML reader (`./yaml.ts`).
//
// The release workflow cannot be executed locally, so its *structure* is what the suite can
// hold to account: which triggers it has, which permissions each job effectively runs with,
// and — the point of R4-1 — whether any step in any job performs a publishing action. Every
// query below returns findings with the job/step that produced them, so a failure message names
// the offending step instead of just "the file changed".

import { readFileSync } from "node:fs";
import { asMapping, asSequence, asString, parseYaml, type YamlMapping, type YamlValue } from "./yaml.js";

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

/** Registry publication commands, in any of the three package managers plus npm's staging flow. */
const PUBLISH_COMMAND = /(^|[\s;&|()])(npm|yarn|pnpm)\s+(publish|stage\s+publish)\b/u;
/** The flag npm requires to attach provenance to a *publication*. */
const PUBLISH_PROVENANCE_FLAG = /--provenance\b/u;
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

/** Every step that would publish a package to a registry, or attach publish-provenance. */
export function findPublishActions(workflow: Workflow): WorkflowFinding[] {
  const findings: WorkflowFinding[] = [];
  for (const step of allSteps(workflow)) {
    if (step.run !== null) {
      if (PUBLISH_COMMAND.test(step.run)) findings.push({ job: step.job, step: step.label, reason: "run: a registry publish command" });
      if (PUBLISH_PROVENANCE_FLAG.test(step.run)) findings.push({ job: step.job, step: step.label, reason: "run: --provenance (publish flag)" });
    }
    if (step.uses !== null && PUBLISH_ACTION.test(step.uses)) {
      findings.push({ job: step.job, step: step.label, reason: `uses: ${step.uses} looks like a publishing action` });
    }
  }
  return findings;
}

/** Every place a registry credential or endpoint is wired in, which a publish would require. */
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
    const script = step.run ?? "";
    if (/NODE_AUTH_TOKEN|NPM_TOKEN|npm\s+login|npm\s+token\b/u.test(script)) {
      findings.push({ job: step.job, step: step.label, reason: "run: authenticates against a registry" });
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

/** Anything in the whole document (keys and values alike) that could publish or authenticate. */
export function findSuspiciousStrings(workflow: Workflow): (LocatedString & { reason: string })[] {
  const findings: (LocatedString & { reason: string })[] = [];
  for (const { path, value } of collectStrings(workflow.document)) {
    if (PUBLISH_COMMAND.test(value)) findings.push({ path, value, reason: "looks like a registry publish command" });
    if (PUBLISH_PROVENANCE_FLAG.test(value)) findings.push({ path, value, reason: "--provenance is a publish flag" });
    if (/registry(-?url)?$/iu.test(path)) findings.push({ path, value, reason: "configures a registry endpoint" });
    if (REGISTRY_AUTH_ENV.test(value)) findings.push({ path, value, reason: "names a registry token" });
    if (/secrets\.[A-Za-z0-9_]+/u.test(value)) findings.push({ path, value, reason: "reads a repository secret" });
    if (/\bnpm\s+(login|token|adduser)\b/u.test(value)) findings.push({ path, value, reason: "authenticates against a registry" });
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
