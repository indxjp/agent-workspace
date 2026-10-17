export const EXPORT_MODEL: string;
export const PLATFORM_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>>;
export function platformsBlock(ids: readonly string[]): string;
export function withPlatforms(yaml: string, ids: readonly string[]): string;
export interface AwOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** `aw` of one project; each call is logged, scrubbed of the run's secrets, to `evidence/commands.log`. */
export function awOf(options: {
  project: string;
  userEnv: NodeJS.ProcessEnv;
  evidence: string;
}): (args: readonly string[], env?: NodeJS.ProcessEnv) => AwOutcome;
/** Copies the export to `importDir` with its agent renamed; returns the original agent file text. */
export function renameExportedAgent(options: {
  exported: string;
  importDir: string;
  from: string;
  to: string;
}): string;
