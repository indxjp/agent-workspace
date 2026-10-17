import type { Claim } from './extract.mjs';

export interface Row {
  where: string;
  state: string;
  what: string;
  result: string;
  seconds?: number;
  detail?: string;
}
export interface Block {
  claim: Claim;
  commands: string[];
  fresh?: boolean;
  sameAsLine?: number;
}
export interface PagePlan {
  page: string;
  slug: string;
  blocks: Block[];
  sameAsPage?: string;
}

export function parseArguments(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): {
  registry: string | null;
  live: boolean;
  apiKey: string;
  staticOnly: boolean;
  machine: 'container' | 'host';
  shell: string;
  shard: { index: number; count: number };
};
export function shardPlans(
  plans: readonly PagePlan[],
  shard: { index: number; count: number },
): PagePlan[];
export function exitCodeOf(rows: readonly Row[]): 0 | 1;
export function runPlans(claims: readonly Claim[]): PagePlan[];
export function compileSources(
  claims: readonly Claim[],
): { claim: Claim; name: string; text: string }[];
export function tscDiagnostics(output: string): Map<string, { line: number; message: string }[]>;
export function summaryMarkdown(
  rows: readonly Row[],
  notes: readonly string[],
  title?: string,
): string;
export function staticRows(claims: readonly Claim[], questionFlags: readonly string[]): Row[];
export interface Machine {
  kind: 'container' | 'host';
  shell: 'posix' | 'powershell';
  fifo: boolean;
  env: Readonly<Record<string, string>>;
  commandMs: number;
  logs: string;
  claims: string;
  compile: string;
  resolve: (cwd: string, to: string) => string;
  mkdir: (dir: string) => Promise<unknown>;
  project: (dir: string) => Promise<unknown>;
  remove: (dir: string) => Promise<unknown>;
  list: (dir: string) => Promise<string[]>;
  stageCompile: (stage: string) => Promise<string>;
  exec: (
    command: string,
    run: { cwd: string; env?: Readonly<Record<string, string>>; timeoutMs: number },
  ) => Promise<{ status: number | null; output: string; stdout: string }>;
  startDev: (cwd: string, env?: Readonly<Record<string, string>>) => unknown;
}
export function runPage(
  machine: Machine,
  plan: PagePlan,
  done: Map<string, Row[]>,
  modelMissing: boolean,
): Promise<Row[]>;
export function save(rows: readonly Row[], notes: string[], work: string): string;
