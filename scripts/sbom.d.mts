// Typed surface of scripts/sbom.mjs for consumers inside the tsconfig project
// (tests/release/sbom.test.ts). The runtime implementation is plain ESM; this file declares the
// one pure helper the tests pin, so the rule cannot drift from what `npm run sbom` enforces.

export interface SbomManifest {
  name: string;
  version: string;
}

export interface ValidateDocumentOptions {
  manifest: SbomManifest;
  /** The checkout directory name, which npm uses for the root component's `name`. */
  directoryName: string;
  /** Defaults to `cyclonedx`. */
  format?: string;
}

/** Returns one message per problem with `document`; an empty array means it is acceptable. */
export function validateDocument(document: unknown, options: ValidateDocumentOptions): string[];
