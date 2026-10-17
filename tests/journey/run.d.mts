export const VERDACCIO_IMAGE: string;
export const PLAYWRIGHT_IMAGE: string;
export const FAKE_KEY_PREFIX: string;
export const HOME: string;
export const SECRETS: Set<string>;
export function scrub(text: string): string;
export function say(text: string): void;
export function waitForRegistry(url: string, deadline: number): Promise<void>;
export function startRegistry(name: string, port: number, deadline: number): Promise<void>;
export function publishPackages(
  work: string,
  secrets: string,
  registryUrl: string,
  deadline: number,
): Promise<void>;
export interface ExecOptions {
  workdir?: string;
  user?: string;
  env?: Readonly<Record<string, string>>;
  input?: string;
  timeoutMs: number;
  quiet?: boolean;
}
export interface ExecResult {
  status: number | null;
  output: string;
  stdout: string;
}
export function exec(
  container: string,
  command: readonly string[],
  options: ExecOptions,
): Promise<ExecResult>;
export function execOk(
  container: string,
  command: readonly string[],
  options: ExecOptions,
): Promise<ExecResult>;
export function removeContainer(name: string): void;
export function pinnedVersion(manifestDir: string, name: string): string;
export function startFakeProvider(
  requests: unknown[],
  toolRequests: unknown[],
  bodies: string[],
): Promise<{ port: number; close: () => void }>;
export function startMachine(name: string, registryUrl: string, deadline: number): Promise<void>;
export interface DevRun {
  untilWidget(timeoutMs: number): Promise<{ ready: string; widget: string }>;
  stop(limit: (capMs: number) => number): Promise<void>;
  kill(): void;
  state: { log: string };
}
export function startDev(
  machine: string,
  workdir: string,
  env: Readonly<Record<string, string>>,
): DevRun;
export function watchDev(
  child: import('node:child_process').ChildProcessByStdio<
    null,
    import('node:stream').Readable,
    import('node:stream').Readable
  >,
  how: {
    interrupt: (limit: (capMs: number) => number) => Promise<void>;
    survivors: () => Promise<string>;
    cleanExits: readonly (number | null)[] | null;
  },
): DevRun;
