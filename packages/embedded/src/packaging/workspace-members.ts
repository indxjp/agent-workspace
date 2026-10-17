import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { isMissingPath } from './errors.ts';

const memberManifestSchema = z.looseObject({ name: z.string().min(1) });

/**
 * The package names of every workspace member (`apps/*` and `packages/*`, as `pnpm-workspace.yaml`
 * lists them). The bundle inlines a bare specifier exactly when its package is one of these.
 */
export async function readWorkspaceMembers(root: string): Promise<ReadonlySet<string>> {
  const names = new Set<string>();
  for (const parent of ['apps', 'packages']) {
    const entries = await readdir(path.join(root, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(root, parent, entry.name, 'package.json');
      let text: string;
      try {
        text = await readFile(manifestPath, 'utf8');
      } catch (error) {
        // A directory without a manifest (an emptied clone leftover) is not a member.
        if (isMissingPath(error)) continue;
        throw error;
      }
      names.add(memberManifestSchema.parse(JSON.parse(text)).name);
    }
  }
  return names;
}
