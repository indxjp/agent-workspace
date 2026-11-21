/**
 * The gallery's handwritten lines (the Agent Store 100-use-case plan, §4): each project counted by
 * the counter the apps and the use cases share (`tests/apps/handwritten.ts`), against the 150-line
 * ceiling of the largest archetype. Report-only for now: `benchmark.test.ts` writes the table in
 * `README.md` and keeps it current; nothing fails for being over the ceiling yet.
 *
 * What is left out is the use cases' rule (`use-cases/kit/budget.ts`: Markdown, the eval YAML,
 * `data/`, tests and test support) plus what only the gallery has: its `benchmark.ts` (the
 * gallery's bookkeeping, as the apps benchmark leaves out its own), `sample-data/` (data, like
 * `data/`), and the fake external systems (`<system>/fake-<system>.mjs` and its declaration), which
 * stand in for the customer's own CRM, ERP or tracker so the tutorial runs offline; a deployment
 * calls the real one. Everything else counts, and so does every file outside the project a counted
 * file imports (`../shared/…`), so moving code there does not hide it.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { moduleSpecifiers } from '../../apps/benchmark.ts';
import { countedLines, countHandwritten, type HandwrittenFile } from '../../apps/handwritten.ts';
import { isSkippedInUseCase } from '../../../use-cases/kit/budget.ts';

/** The most handwritten lines a gallery project should have: the AN archetype's budget (§4). */
export const GALLERY_CEILING = 150;

const GALLERY_ONLY = [
  /^benchmark\.ts$/u,
  /^sample-data\//u,
  /^([a-z-]+)\/fake-\1\.(?:mjs|d\.mts)$/u,
];

/** Whether the gallery's count leaves out `file` (relative to the project, `/` separators). */
function isSkippedInGallery(file: string): boolean {
  return isSkippedInUseCase(file) || GALLERY_ONLY.some((pattern) => pattern.test(file));
}

const MODULE_FILE = /\.[cm]?[jt]sx?$/u;
const DECLARATION = /\.d\.[cm]?ts$/u;

/** One gallery project's count. */
export interface GalleryLineCount {
  readonly id: string;
  readonly lines: number;
  readonly files: readonly HandwrittenFile[];
}

/** Count the project in `dir`. The gallery has no generated files, so no manifest is trusted. */
export async function countGalleryProject(dir: string): Promise<GalleryLineCount> {
  const own = await countHandwritten(dir, { version: 1, entries: {} }, isSkippedInGallery);
  const name = (file: string): string => path.relative(dir, file).split(path.sep).join('/');
  const seen = new Set(own.files.map(({ file }) => path.join(dir, file)));
  const queue = [...seen].filter((file) => MODULE_FILE.test(file) && !DECLARATION.test(file));
  const imported: HandwrittenFile[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const specifier of moduleSpecifiers(next, await readFile(next, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(next), specifier);
      if (seen.has(target) || !existsSync(target) || !statSync(target).isFile()) continue;
      seen.add(target);
      if (target.startsWith(`${dir}${path.sep}`)) continue;
      imported.push({
        file: name(target),
        lines: countedLines(target, await readFile(target, 'utf8')),
      });
      if (MODULE_FILE.test(target) && !DECLARATION.test(target)) queue.push(target);
    }
  }
  const files = [...own.files, ...imported];
  return {
    id: path.basename(dir),
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    files,
  };
}

/** The README's table: one row per project, in gallery order. */
export function renderLineCountTable(counts: readonly GalleryLineCount[]): string {
  const rows = counts.map(({ id, lines, files }) => {
    const largest = [...files].sort((left, right) => right.lines - left.lines).slice(0, 3);
    const over = lines - GALLERY_CEILING;
    return `| ${id} | ${String(lines)} | ${over > 0 ? `+${String(over)}` : '—'} | ${largest
      .map(({ file, lines: count }) => `\`${file}\` ${String(count)}`)
      .join(', ')} |`;
  });
  return [
    `| Use case | Handwritten lines | Over ${String(GALLERY_CEILING)} | Largest files |`,
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
