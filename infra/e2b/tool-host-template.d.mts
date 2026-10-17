export const DOCKERFILE: string;
export const APP_DIR: string;
export const CONTEXT_PATHS: readonly string[];
export const INSTALL_COMMAND: string;
export const BUILD_COMMANDS: readonly string[];
export const PRUNE_COMMAND: string;
export const STRIP_COMMAND: string;
export const BUILD_ENV: readonly string[];
export const RUN_ENV: readonly string[];
export function toolHostBuild(root?: string): {
  image: string;
  steps: readonly { type: string; args: readonly string[]; filesHash?: string }[];
  uploads: readonly { hash: string; archive: Uint8Array }[];
};
export function contextArchive(
  root: string,
  paths: readonly string[],
  destination: string,
): { hash: string; archive: Uint8Array };
