export const JOURNEY_DEPLOYMENT_POLICY: string;
export function storageEntries(
  laneKey: string,
  env: Readonly<Record<string, string | undefined>>,
): Record<
  'OBJECT_STORAGE_ACCESS_KEY_ID' | 'OBJECT_STORAGE_SECRET_ACCESS_KEY' | 'AW_STORAGE_URL',
  string
>;
export function setDotEnv(text: string, entries: Readonly<Record<string, string>>): string;
export function frontendFiles(): Record<'package.json' | 'build.mjs', string>;
export function awaitSetup(
  control: string,
  options?: {
    fetch?: typeof fetch;
    windowMs?: number;
    delayMs?: number;
    requestTimeoutMs?: number;
  },
): Promise<void>;
export function refusedRun(
  code: string,
  started: { status: number; text: string },
  framesOf: () => Promise<unknown[]>,
  report?: (ok: boolean, message: string) => void,
): Promise<string>;
export function frontendTurn(options: {
  control: string;
  origin: string;
  nonce: string;
  session: { token: string; sessionId: string; agentId: string };
  ask: (
    url: string,
    init: RequestInit,
  ) => Promise<{ status: number; text: string; headers: Headers; json: any }>;
  framesOf: (runId: string) => Promise<unknown[]>;
  detailOf?: (runId: string) => Promise<string>;
  report?: (ok: boolean, message: string) => void;
}): Promise<void>;
export function setupAnswered(
  refusal: string | undefined,
  setup: { status: number; text: string; json: unknown },
  report?: (ok: boolean, message: string) => void,
): void;
export function pushVercelSandboxImage(options: {
  reference: string;
  team: string;
  token: string;
  project: string;
  run?: (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number },
  ) => string;
  call?: (
    url: string,
    init?: RequestInit & { token?: string },
  ) => Promise<{ status: number; text: string; json: any }>;
  sleep?: (ms: number) => Promise<unknown>;
  polls?: number;
  pollMs?: number;
}): Promise<string>;
export function failedRunDetail(
  client: {
    request: (
      route: string,
      options?: { apiKey?: string },
    ) => Promise<{ status: number; json: unknown }>;
  },
  runId: string,
  secrets: readonly string[],
  apiKey?: string,
): Promise<string>;
export function refusedPush(
  code: string,
  output: string,
  report?: (ok: boolean, message: string) => void,
): string;
export function vercelLogExcerpt(options: {
  url: string;
  team: string;
  token: string;
  lines?: number;
  timeoutMs?: number;
  run?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ) => { stdout?: string | null; error?: Error };
}): string;
export function withVercelLogs(
  error: unknown,
  options: {
    targets: [string, string][];
    team: string;
    token: string;
    run?: (
      command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv; timeout: number },
    ) => { stdout?: string | null; error?: Error };
  },
): Error;
export function responseSecrets(value: unknown, named?: boolean): string[];
export function redactingCheck(
  hidden: () => readonly string[],
  print?: (ok: boolean, message: string) => void,
): (ok: boolean, message: string) => void;
