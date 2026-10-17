export function agentWithTool(source: string, model: string): string;
export function chatNonce(): string;
export function check(ok: boolean, message: string): void;
export function spawnChecked(
  command: string,
  args: readonly string[],
  options: import('node:child_process').SpawnSyncOptions,
  expected?: number,
): string;
export function journeyShell(options: { work: string; npmPort: number }): {
  npmUrl: string;
  home: string;
  evidence: string;
  userEnv: NodeJS.ProcessEnv;
};
export function preparePackages(options: {
  work: string;
  npmPort: number;
  npmUrl: string;
  deadline: number;
}): Promise<void>;
export function stopPackages(): void;
export interface CreatedProject {
  project: string;
  aw: (args: readonly string[], env?: NodeJS.ProcessEnv, expected?: number) => string;
  agentPath: string;
  rendered: string;
  agentName: string;
}
export function createSupportProject(options: {
  work: string;
  name: string;
  userEnv: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
}): CreatedProject;
export function evaluateScripted(options: {
  created: CreatedProject;
  userEnv: NodeJS.ProcessEnv;
  evidence: string;
  production: string;
  tool?: { declaration: string; runFile: string };
}): Promise<void>;
export function promotePastGate(options: {
  created: CreatedProject;
  remote: NodeJS.ProcessEnv;
  evidence: string;
  refusal: boolean;
}): void;
export function composeOverride(options: {
  project: string;
  nodeImage: string;
  controlPort: number;
  fixture: string;
  toolHost: string;
  egressProxy: string;
}): string;
