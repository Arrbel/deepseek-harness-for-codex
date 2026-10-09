// Fidelity tests for the local YAML reader used by the release-workflow assertions.
//
// The point is not to re-test YAML; it is to prove the reader produces the *structure* the
// workflow tests depend on — against ground truth that can be checked by eye in the real files,
// and against synthetic documents for the constructs GitHub workflows actually use.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { asMapping, asSequence, parseYaml, YamlError, type YamlMapping, type YamlValue } from "./yaml.js";
import { loadWorkflow } from "./workflow.js";
import "../support/isolation.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowDir = join(repoRoot, ".github", "workflows");

function mappingOf(text: string): YamlMapping {
  return asMapping(parseYaml(text), "the document");
}

function pick(value: YamlValue | undefined, where: string): YamlMapping {
  return asMapping(value, where);
}

describe("tests/release/yaml (block-subset reader)", () => {
  it("reads nested mappings, block sequences and flow sequences", () => {
    const document = mappingOf([
      "name: check",
      "on:",
      "  push:",
      "  pull_request:",
      "matrix:",
      "  include:",
      "    - os: windows-latest",
      '      node: "22.x"',
      "    - os: macos-latest",
      '      node: "22.x"',
      "tags:",
      '  - "v*"',
      'flow: ["v*", 1, true, null]',
      "",
    ].join("\n"));

    expect(document["name"]).toBe("check");
    expect(Object.keys(pick(document["on"], "on"))).toEqual(["push", "pull_request"]);
    const include = asSequence(pick(document["matrix"], "matrix")["include"], "include");
    expect(include).toHaveLength(2);
    expect(pick(include[0], "include[0]")).toEqual({ os: "windows-latest", node: "22.x" });
    expect(pick(include[1], "include[1]")["os"]).toBe("macos-latest");
    expect(document["tags"]).toEqual(["v*"]);
    expect(document["flow"]).toEqual(["v*", 1, true, null]);
  });

  it("keeps block-scalar scripts (blank lines and internal indentation included)", () => {
    const document = mappingOf([
      "run: |",
      "  set -e",
      "",
      '  node -e "console.log(1)"',
      "    indented: line",
      "after: value",
      "",
    ].join("\n"));

    expect(document["run"]).toBe('set -e\n\nnode -e "console.log(1)"\n  indented: line\n');
    expect(document["after"]).toBe("value");
  });

  it("ignores comments and the document start, and keeps `#` inside quotes", () => {
    const document = mappingOf([
      "---",
      "# a full-line comment",
      'url: "https://example.test/#fragment"',
      "value: 12  # trailing comment",
      "quoted: 'it''s fine'",
      "empty:",
      "",
    ].join("\n"));

    expect(document["url"]).toBe("https://example.test/#fragment");
    expect(document["value"]).toBe(12);
    expect(document["quoted"]).toBe("it's fine");
    expect(document["empty"]).toBeNull();
  });

  it("reads a sequence of mappings that continue over several lines", () => {
    const document = mappingOf([
      "steps:",
      "  - name: first",
      "    uses: actions/checkout@v4",
      "  - name: second",
      "    run: |",
      "      npm ci",
      "    env:",
      "      CI: true",
      "",
    ].join("\n"));

    const steps = asSequence(document["steps"], "steps").map((step, index) => pick(step, `steps[${String(index)}]`));
    expect(steps[0]).toEqual({ name: "first", uses: "actions/checkout@v4" });
    expect(steps[1]?.["run"]).toBe("npm ci\n");
    expect(pick(steps[1]?.["env"], "steps[1].env")).toEqual({ CI: true });
  });

  it("refuses constructs it does not implement instead of guessing", () => {
    expect(() => parseYaml("key: &anchor value")).toThrow(YamlError);
    expect(() => parseYaml("key: *alias")).toThrow(YamlError);
    expect(() => parseYaml("key: [unterminated")).toThrow(YamlError);
    expect(() => parseYaml("\tkey: value")).toThrow(/tabs/u);
    expect(() => parseYaml("just a scalar with no colon")).toThrow(/key: value/u);
  });

  it("parses the real check.yml exactly as written", () => {
    const workflow = loadWorkflow(join(workflowDir, "check.yml"));
    const check = workflow.jobs.find((job) => job.id === "check");
    const supplyChain = workflow.jobs.find((job) => job.id === "supply-chain");

    expect(workflow.name).toBe("check");
    expect(Object.keys(workflow.triggers).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(check?.runsOn).toBe("${{ matrix.os }}");
    const matrix = pick(pick(check?.raw["strategy"], "check.strategy")["matrix"], "check.matrix");
    const rendered = asSequence(matrix["include"], "include").map((entry, index) =>
      pick(entry, `include[${String(index)}]`));
    expect(rendered.map((entry) => `${String(entry["os"])}/${String(entry["node"])}`)).toEqual([
      "windows-latest/22.x",
      "ubuntu-latest/22.x",
      "ubuntu-latest/24.x",
      "macos-latest/22.x",
    ]);
    expect(supplyChain?.steps.some((step) => (step.run ?? "").includes("npm audit"))).toBe(true);
    expect(supplyChain?.steps.some((step) => (step.run ?? "").includes("npm sbom"))).toBe(true);
  });

  it("parses the real live-smoke.yml inputs and job-level env", () => {
    const workflow = loadWorkflow(join(workflowDir, "live-smoke.yml"));
    const inputs = pick(pick(workflow.triggers["workflow_dispatch"], "workflow_dispatch")["inputs"], "inputs");
    expect(pick(inputs["dsh_package"], "dsh_package")["default"]).toBe("@deepseek-ai/dsh@0.2.1-alpha.1");
    const live = workflow.jobs.find((job) => job.id === "live");
    expect(live?.runsOn).toBe("windows-latest");
    expect(live?.steps.some((step) => (step.run ?? "").includes("npm run check:live"))).toBe(true);
    expect(pick(live?.raw["env"], "live.env")["DSH_LIVE"]).toBe("1");
  });
});
