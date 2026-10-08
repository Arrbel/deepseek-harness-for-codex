// Typed surface of scripts/lib/repo-snapshot.mjs for consumers inside the tsconfig project.

import type { MetadataSnapshot } from "./metadata.mjs";

export interface RepoSnapshot extends MetadataSnapshot {
  root: string;
}

export function defaultRepoRoot(): string;
export function readRepoSnapshot(root?: string): Promise<RepoSnapshot>;
