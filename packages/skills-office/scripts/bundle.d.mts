export interface BundledFile {
  path: string;
  content: string;
}

export function bundleSkills(packageDir?: string): Record<string, BundledFile[]>;
export function bundleText(packageDir?: string): string;
