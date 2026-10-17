export function killLaneSandboxes(options: {
  apiKey: string;
  workspaceId: string;
  request?: typeof fetch;
  log?: (line: string) => void;
  polls?: number;
  pollMs?: number;
}): Promise<{ before: number; after: number }>;
