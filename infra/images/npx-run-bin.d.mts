export class NpxBinError extends Error {}
export interface PackageManifest {
  name?: unknown;
  bin?: unknown;
  directories?: unknown;
}
export function installedPackageName(
  projectManifest: { dependencies?: unknown },
  spec: string,
): string;
export function realPath(location: string): string;
export function isInside(directory: string, target: string): boolean;
export function listBinDirectory(directory: string): string[];
export function packageBinNames(
  manifest: PackageManifest,
  name: string,
  packageDirectory: string,
  listFiles?: (directory: string) => readonly string[],
): string[];
export function selectPackageBin(
  manifest: PackageManifest,
  name: string,
  packageDirectory: string,
  listFiles?: (directory: string) => readonly string[],
): string;
export function resolveBin(request: {
  nodeModules: string;
  package?: string;
  command?: string;
}): { script: string } | { command: string };
export function dlxNodeModules(searchPath: string | undefined): string;
export function binProcess(
  target: { script: string } | { command: string },
  args: readonly string[],
  shell?: string,
): [string, string[]];
export function runInherited(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): void;
