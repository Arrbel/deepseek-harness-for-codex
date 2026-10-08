// Typed surface of scripts/lib/self-contained-probe.mjs for consumers inside the tsconfig project.

export interface ProbeResult {
  ok: boolean;
  tools: string[];
  missingTools: string[];
  error: string | null;
  serverName: string | null;
  serverVersion: string | null;
  stderrTail?: string;
}

export function pluginPayloadExists(root: string): Promise<boolean>;
export function probePluginLaunch(options: { root: string; timeoutMs?: number }): Promise<ProbeResult>;
