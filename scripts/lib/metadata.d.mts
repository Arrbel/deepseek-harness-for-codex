// Typed surface of scripts/lib/metadata.mjs for consumers inside the tsconfig project
// (tests/metadata.test.ts). The runtime implementation is plain ESM; this file only
// declares the API that tests and CLIs rely on.

export type ArtifactKind = "text" | "copy";

export interface Artifact {
  path: string;
  kind: ArtifactKind;
  text?: string;
  copyFrom?: string;
  sha256?: string;
}

export interface Finding {
  code: string;
  path: string;
  message: string;
}

export interface ManifestShape {
  name?: string;
  version?: string;
  files?: string[];
  scripts?: Record<string, string>;
}

export interface LockShape {
  version?: string;
  packages?: Record<string, { name?: string; version?: string }>;
}

export interface MarketplaceShape {
  plugins?: Array<{ name?: string; source?: { source?: string; path?: string } }>;
}

export interface MetadataSnapshot {
  manifest: ManifestShape;
  lock: LockShape | null;
  marketplace: MarketplaceShape | null;
  texts: Map<string, string | null>;
  hashes: Map<string, string | null>;
  sourceHashes: Map<string, string | null>;
  listings: Map<string, string[]>;
  distImports: Map<string, string[]>;
}

export const ROOT_MCP_REL: string;
export const ROOT_PLUGIN_REL: string;
export const VERSION_TS_REL: string;
export const MARKETPLACE_REL: string;
export const PLUGIN_DIR_REL: string;
export const PLUGIN_NAME: string;
export const MCP_SERVER_NAME: string;
export const PLUGIN_ENTRY_REL: string;
export const DIST_FILES: string[];
export const PLUGIN_COPY_SOURCES: string[];
export const GENERATED_HEADER: string;
export const SCANNED_TEXT_RELS: string[];
export const MCP_ENV_VARS: string[];
export const REQUIRED_PACKAGE_FILES: string[];
export const REQUIRED_SCRIPT_GATES: Record<string, string>;

export function sha256(text: string): string;
export function renderVersionTs(input: { name: string; version: string }): string;
export function renderMcpJson(input?: { serverName?: string; entry?: string }): string;
export function renderRootPluginJson(input: { name: string; version: string }): string;
export function renderEmbeddedPluginJson(input: { name?: string; version: string }): string;
export function expectedArtifacts(input: {
  name: string;
  version: string;
  pluginName?: string;
}): Artifact[];
export function textPathsFor(name: string, version: string, pluginName?: string): string[];
export function hashPathsFor(name: string, version: string, pluginName?: string): string[];
export function externalImports(text: string): string[];
export function evaluateMetadata(snapshot: MetadataSnapshot): Finding[];
export function formatFindings(findings: Finding[]): string;
