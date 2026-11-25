export const PROJECTS: readonly string[];
export const STAND_IN: RegExp;
export interface ServerCommand {
  env: Record<string, string>;
  script: string;
  port: number;
  identity?: { key: string; secret: string };
}
export function workspaceSecrets(projectYaml: string): string[];
export function serverCommands(
  projectYaml: string,
  secret: () => string,
  overrides?: Readonly<Record<string, string>>,
): ServerCommand[];
export interface ConsoleSignIn {
  url: string;
  email: string;
  passwordFile: string;
}
export function consoleSignIn(readyScreen: string): ConsoleSignIn;
export function signInFormFields(html: string): [string, string][];
export interface IdentityTarget {
  connectorId: string;
  workspaceId: string;
}
export function identityTargets(listJson: string): Map<string, IdentityTarget>;
export function identityEnvironment(
  server: ServerCommand,
  targets: ReadonlyMap<string, IdentityTarget>,
): Record<string, string>;
export function devEnvironment(projectYaml: string, secret: () => string): Record<string, string>;
export function firstPrompt(evalYaml: string): string | undefined;
export const MAX_TRACED_RUNS: number;
export function failedRuns(
  evalStdout: string,
): { name: string; runId: string; failures: string[] }[];
export function chatFailedRunId(chatOutput: string): string | undefined;
export function chatPausedRunId(chatOutput: string): string | undefined;
export function printedRun(stdout: string): { id: string; status: string; text: string };
export function fileSetupCommands(dir: string): string[];
export function skillPublishCommands(dir: string): string[];
export function pointApisAtLoopback(dir: string, port: number): void;
export function parseArguments(argv: readonly string[]): { version: string; registry: string };
export function installSteps(
  version: string,
): readonly (readonly [what: string, command: string])[];
