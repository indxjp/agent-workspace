export function wranglerConfig(workerName: string): string;
export function waitForFakeProvider(
  url: string,
  key: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void>;
export function deployFakeProvider(options: {
  workerName: string;
  key: string;
  run?: (command: string, args: readonly string[], options: object) => string;
  retry?: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<unknown> };
}): Promise<string>;
