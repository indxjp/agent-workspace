export const DOCKERFILE: string;
export const SRV_DIR: string;
export const WORKSPACE_DIR: string;
export const RUN_ENV: readonly string[];
export const STRIP_COMMAND: string;
export const OWNER_COMMAND: string;
export const pnpmInstallCommand: string;
export function contextPaths(engine: string): readonly string[];
export function installCommand(engine: string): string;
export function buildCommand(engine: string): string;
export function verifyLabelCommand(engine: string, version: string): string;
export function pruneCommand(engine: string): string;
export function linkCommand(engine: string): string;
export function pnpmFetchCommand(
  version: string,
  sha256: { readonly x64: string; readonly arm64: string },
): string;
export function runtimeBuild(root?: string): {
  image: string;
  steps: readonly { type: string; args: readonly string[]; filesHash?: string }[];
  uploads: readonly { hash: string; archive: Uint8Array }[];
};
