export const UPSTREAM_REGISTRY: string;
export function packumentOf(
  manifest: Record<string, unknown>,
  bytes: Uint8Array,
  tarballUrl: string,
): {
  name: unknown;
  'dist-tags': { latest: unknown };
  versions: Record<
    string,
    Record<string, unknown> & {
      dist: { tarball: string; integrity: string; shasum: string };
    }
  >;
};
export function requestOf(
  pathname: string,
):
  | { kind: 'packument'; name: string }
  | { kind: 'tarball'; name: string; file: string }
  | { kind: 'other' };
export function startPackageServer(
  tarballs: Readonly<Record<string, string>>,
): Promise<{ url: string; close: () => Promise<void> }>;
export function spawnPackageServer(
  tarballs: Readonly<Record<string, string>>,
  work: string,
): Promise<{ url: string; close: () => void }>;
