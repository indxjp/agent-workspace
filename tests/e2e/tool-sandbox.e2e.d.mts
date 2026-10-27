export const DECLARED_SECRET: string;
export const DECLARATION: string;
export const OFFLINE_DECLARATION: string;
export const OFFLINE_RUN_FILE: string;
export const TOOL_NAME: string;
export function bundledStorageUrl(root?: string): string;
export function stackEnv(options: {
  adminEmail: string;
  adminPassword: string;
  webPort: number;
  dockerGid: number;
  storageUrl: string;
}): string;
