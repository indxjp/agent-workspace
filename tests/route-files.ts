import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  APP_PREFIX,
  REPO_ROOT,
  pageExtensions,
  trackedFiles,
  underPrivateFolder,
  urlPathOf,
} from './inventory-support.js';
import { classifyAppFile } from './route-declaration-reader.js';
import { exportedMethods } from './route-source-reader.js';

export interface RouteFile {
  /** Repo-relative and forward-slashed, e.g. `apps/web/app/api/agents/route.ts`. */
  readonly repoPath: string;
  readonly source: string;
}

export function filterRouteFiles(
  paths: readonly string[],
  extensions: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const file of paths) {
    if (!file.startsWith(`${APP_PREFIX}/`)) continue;
    const relative = file.slice(APP_PREFIX.length + 1);
    const segments = relative.split('/');
    const name = segments[segments.length - 1] ?? '';
    // Next.js ignores a folder whose name starts with `_`, so a route file under one serves
    // nothing and must not appear in the inventory. The rule is `underPrivateFolder` in
    // `tests/inventory-support.ts` rather than a test of its own here, because the screen
    // inventory asks it of the same tree and two answers to one question is one answer too many.
    if (underPrivateFolder(segments)) continue;
    if (classifyAppFile(name, extensions, file) === 'ignore') continue;
    out.push(file);
  }
  return out.sort();
}

export function routeSurface(files: readonly RouteFile[]): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of files) {
    const relative = file.repoPath.slice(APP_PREFIX.length + 1);
    const dir = relative.split('/').slice(0, -1).join('/');
    const urlPath = urlPathOf(dir, file.repoPath);
    for (const method of exportedMethods(file.source, file.repoPath)) {
      found.add(`${method} ${urlPath}`);
    }
  }
  return found;
}

export function trackedRouteFiles(): RouteFile[] {
  const extensions = pageExtensions();
  return filterRouteFiles(trackedFiles(APP_PREFIX), extensions).map((repoPath) => {
    const absolute = path.join(REPO_ROOT, repoPath);
    if (!existsSync(absolute)) {
      throw new Error(
        `${repoPath} is tracked by git but absent from the working tree, so this gate could not ` +
          `read the route it declares.`,
      );
    }
    return { repoPath, source: readFileSync(absolute, 'utf8') };
  });
}
