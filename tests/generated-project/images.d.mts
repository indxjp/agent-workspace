export const PINNED_FIELDS: readonly ['web', 'gateway', 'runner', 'runtime'];
export const LOCAL_TAG: 'e2e';

export type PinnedImageBuild = {
  field: 'web' | 'gateway' | 'runner' | 'runtime';
  variable: string;
  reference: string;
  dockerfile: string;
  target: string;
  buildArgs: Record<string, string>;
};

export function pinnedImageBuilds(registry: string, root?: string): PinnedImageBuild[];
export function remainingBefore(deadline: number, now?: number): number;
export function buildPinnedImages(options: {
  registry: string;
  revision: string;
  deadline: number;
  platform?: string;
  push?: boolean;
}): Record<string, string>;
export function checkoutRevision(): string;
