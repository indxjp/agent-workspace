export const DEFAULT_PNPM_CLI: string;
export const DEFAULT_PATH: string;
export const PNPM_TMP_ROOT: string;
export const RUN_BIN: string;
export class UnsupportedNpxUsage extends Error {}
export function dlxPackageSpec(spec: string, cwd: string): string;
export function npxToPnpmDlx(
  argv: readonly string[],
  runner?: { node: string; runBin: string },
  cwd?: string,
): string[];
export function pnpmInvocation(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): { cli: string; args: string[]; env: Record<string, string> };
