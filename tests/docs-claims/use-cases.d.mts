export const PROJECTS: readonly string[];
export function serverCommands(
  projectYaml: string,
  secret: () => string,
  overrides?: Readonly<Record<string, string>>,
): { env: Record<string, string>; script: string; port: number }[];
export function devEnvironment(projectYaml: string, secret: () => string): Record<string, string>;
export function firstPrompt(evalYaml: string): string | undefined;
export const MAX_TRACED_RUNS: number;
export function failedRuns(
  evalStdout: string,
): { name: string; runId: string; failures: string[] }[];
export function chatFailedRunId(chatOutput: string): string | undefined;
export function fileSetupCommands(dir: string): string[];
export function pointApisAtLoopback(dir: string, port: number): void;
export function sharedSkills(dir: string): string[];
export function parseArguments(argv: readonly string[]): { version: string; registry: string };
export function installSteps(
  version: string,
): readonly (readonly [what: string, command: string])[];
