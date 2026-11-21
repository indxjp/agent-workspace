/**
 * The layout of `use-cases/` (README.md): every folder is one use case, named by its catalog slug
 * and holding its project file, except the folders the workspace itself keeps. That a folder's
 * slug is a catalog entry, and a live entry's folder exists, is `tests/store/catalog.test.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/** Folders that are not a use case: test machinery, the generator's templates, installs. */
const WORKSPACE_FOLDERS = new Set(['kit', 'templates', 'node_modules', 'coverage']);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Why `root` is not a valid `use-cases/` tree; empty when it is. */
function layoutProblems(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && !entry.name.startsWith('.') && !WORKSPACE_FOLDERS.has(entry.name),
    )
    .flatMap(({ name }) => {
      if (!SLUG.test(name)) return [`${name}: not a catalog slug (kebab-case)`];
      return existsSync(path.join(root, name, 'agent-workspace.yaml'))
        ? []
        : [`${name}: no agent-workspace.yaml`];
    });
}

describe('the use-cases workspace', () => {
  let fixture = '';

  afterEach(() => {
    if (fixture !== '') rmSync(fixture, { recursive: true, force: true });
    fixture = '';
  });

  it('holds only use cases named by their slug, beside its own folders', () => {
    expect(layoutProblems(import.meta.dirname)).toEqual([]);
  });

  it('refuses a folder that is not a slug or has no project file', () => {
    fixture = mkdtempSync(path.join(tmpdir(), 'use-cases-layout-'));
    for (const folder of ['nda', 'Bad_Name', 'no-project', 'kit', 'templates', '.cache']) {
      mkdirSync(path.join(fixture, folder));
    }
    writeFileSync(path.join(fixture, 'nda', 'agent-workspace.yaml'), 'name: nda\n');
    writeFileSync(path.join(fixture, 'README.md'), '# use cases\n');
    expect(layoutProblems(fixture).sort()).toEqual([
      'Bad_Name: not a catalog slug (kebab-case)',
      'no-project: no agent-workspace.yaml',
    ]);
  });
});
