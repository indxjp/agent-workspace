export const LOCKFILE: string;
export function copyExample(id: string, copy: string): void;
export function lockArguments(registry: string): string[];
export function parseArguments(argv: readonly string[]): {
  app: string;
  work: string;
  build: string[];
};
