// Key derivation used to give every workspace its own persistent service home.
//
// The digest itself is computed by the caller (`service/supervisor.ts`); this function only
// defines the naming rule so the layout is testable without touching `node:crypto`.

/** Length of the workspace digest used in `<dataDir>/services/<hash>`. */
export const WORKSPACE_KEY_LENGTH = 24;

/** Truncates a hex digest to the workspace-key length used on disk. */
export function workspaceKey(hexDigest: string): string {
  return hexDigest.slice(0, WORKSPACE_KEY_LENGTH);
}
