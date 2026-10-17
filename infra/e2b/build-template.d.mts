export const TEMPLATE_NAME: string;
export const TOOL_HOST_TEMPLATE_NAME: string;
export function defaultRuntimeImage(root?: string): string;
export function sanitizeLogLine(text: unknown, apiKey: string): string;
export function formatLogEntry(entry: unknown, apiKey: string): string | undefined;
export const DEFAULT_CPU_COUNT: number;
export const DEFAULT_MEMORY_MB: number;
export interface BuilderResources {
  cpuCount: number;
  memoryMB: number;
}
export function builderResources(env: Record<string, string | undefined>): BuilderResources;
export function describeResources(resources: BuilderResources): string;
export function failureSummary(
  kind: string,
  message: string,
  lines: readonly string[],
  resources?: BuilderResources,
): string;
export function templatePin(name: string, buildId: unknown): string;
export function buildTemplate(options: {
  apiKey: string;
  image: string;
  name?: string;
  steps?: readonly object[];
  uploads?: readonly { hash: string; archive: Uint8Array }[];
  cpuCount?: number;
  memoryMB?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onLog?: (line: string) => void;
}): Promise<string>;
