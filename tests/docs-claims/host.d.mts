import type { Machine } from './run.d.mts';

export const SHELL_NAMES: string[];
export function createHostMachine(options: {
  shell: 'sh' | 'bash' | 'pwsh';
  work: string;
  registry: string;
  env: Readonly<Record<string, string>>;
  commandMs: number;
  logs: string;
}): Machine;
