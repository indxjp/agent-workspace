import path from 'node:path';

import { REPO_ROOT } from './boundaries.js';
import { sdkOwns } from './packages.js';
import { resolveSpecifier } from './resolve.js';
import { scanModuleSource } from './scan.js';

/** Does this source, written in this file, reach the SDK? The whole pipeline, for fixtures. */
export function sourceReachesSdk(containingFile: string, source: string): boolean {
  const absolute = path.join(REPO_ROOT, containingFile);
  return scanModuleSource(containingFile, source).references.some((reference) => {
    const resolution = resolveSpecifier(absolute, reference.specifier);
    return resolution.kind === 'resolved' && sdkOwns(resolution.file);
  });
}
