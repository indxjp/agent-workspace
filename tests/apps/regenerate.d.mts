export const PACKED_OVERRIDES_MARK: string;
export function parseRegenerateArgs(argv: readonly string[]): {
  mode: 'check' | 'write';
  id: string;
};
export function withPackedOverrides(
  workspaceYaml: string,
  tarballs: Readonly<Record<string, string>>,
): string;
export function withoutPackedOverrides(text: string): string;
export function withScopeVersion(text: string, from: string, to: string): string;
export function scopeVersionOf(packageJson: string | undefined): string | undefined;
export function atScopeVersion(
  files: ReadonlyMap<string, string>,
  from: string,
  to: string | undefined,
): Map<string, string>;
export function recordedPaths(manifestText: string): string[];
export function differingFiles(
  generated: ReadonlyMap<string, string>,
  exampleDir: string,
  takenOver?: readonly string[],
): string[];
export function regenerate(
  id: string,
  work: string,
  tarballs?: Record<string, string>,
): { files: Map<string, string>; version: string };
export function differingFromExample(
  id: string,
  generated: { readonly files: ReadonlyMap<string, string>; readonly version: string },
  takenOver?: readonly string[],
): string[];
