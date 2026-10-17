export interface Lane {
  id: string;
  host: 'vercel' | 'cloudflare';
  sandbox: 'vercel-sandbox' | 'cloudflare-sandbox' | 'e2b';
  key: string;
  deploy: 'aw' | 'profile';
  credentials: string[];
  refusal?: string;
  pushRefusal?: string;
}
export interface Chapter {
  id: string;
  title: string;
}
export const CLOUDFLARE_SANDBOX_REFUSAL: string;
export const CODE_TOOL_NEEDS_HOST_REFUSAL: string;
export const LANES: Lane[];
export const CHAPTERS: Chapter[];
export function missingVariables(
  names: readonly string[],
  env: Record<string, string | undefined>,
): string[];
export function resourceNames(
  lane: { key: string },
  runId: string,
): {
  project: string;
  neonBranch: string;
  vercelProjects: string[];
  workers: string[];
  fakeProvider: string;
  bridgeWorker: string;
};
export const LEFTOVER_AGE_MS: number;
export function isLeftover(
  lane: { key: string },
  runId: string,
  now?: number,
): (name: unknown, item: unknown) => boolean;
export function runChapters(
  lane: { id: string; credentials: readonly string[] },
  env: Record<string, string | undefined>,
  steps: Record<string, () => Promise<void | string>>,
  record: (id: string, outcome: string, detail?: string) => void,
  secretsMade?: () => readonly string[],
): Promise<void>;
export function resultsWriter(
  lane: string,
  write: (file: string, text: string) => void,
  file: string,
): (id: string, outcome: string, detail?: string) => void;
