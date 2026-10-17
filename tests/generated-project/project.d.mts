export const FAKE_PROVIDER_HOST: 'api.anthropic.com';
export const FIXTURE_DIRECTORY: '.e2e';

export function parseCreateOutput(output: string): {
  adminEmail: string;
  adminPassword: string;
  nextStep: string;
};
export function parseDotEnv(contents: string): Record<string, string>;
export function withTarballOverrides(
  workspaceYaml: string,
  tarballs: Readonly<Record<string, string>>,
): string;
export function composeOverride(options: { nodeImage: string; controlPort: number }): string;
export function writeFakeProviderFixture(projectDirectory: string, fakeScript: string): void;
export function run(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
): string;
export function runStreaming(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; output: string }>;

export type Leftover = {
  id: string;
  name: string;
  labels: Record<string, string>;
  networks: string[];
};
export type Leftovers = { containers: Leftover[]; networks: string[] };

export function leftoversOf(
  projectName: string,
  psListing: string,
  networkListing: string,
): Leftovers;
export function projectLeftovers(projectName: string): Leftovers;
export function removeProject(projectDirectory: string, projectName: string): void;
export function readEnvironmentFile(file: string): Record<string, string>;
