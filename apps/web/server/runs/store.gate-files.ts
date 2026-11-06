/**
 * The tracked files the in-memory store gate (`store.in-memory-gate.test.ts`) classifies: every
 * path `git ls-files` lists, split into the modules it parses and the files no import specifier can
 * resolve to.
 */
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const NON_MODULE_EXTENSIONS = new Set([
  '',
  '.avif',
  '.conf',
  '.css',
  '.csv',
  '.dockerfile',
  // A Word draft (tests/gallery/contract-review): a zip of XML parts a tool reads.
  '.docx',
  // A CAD drawing in ASCII DXF (tests/gallery/cad-drafting): group-code/value lines a tool reads.
  '.dxf',
  '.example',
  '.gif',
  '.gitkeep',
  '.html',
  '.hcl',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.jsonc',
  '.lean',
  '.lock',
  '.map',
  '.md',
  '.mdx',
  '.npmrc',
  // A manual a tool reads (tests/gallery/manual-search/data/manuals).
  '.pdf',
  '.png',
  '.ps1',
  '.sh',
  '.snap',
  '.sql',
  '.service',
  '.svg',
  '.tf',
  '.tftpl',
  // A Helm named-template partial (infra/helm/*/templates/_helpers.tpl).
  '.tpl',
  '.timer',
  '.toml',
  '.txt',
  // A WebVTT meeting transcript (tests/gallery/meeting-minutes).
  '.vtt',
  '.webp',
  '.woff',
  '.woff2',
  // An Excel workbook (tests/gallery/excel-consolidation): a zip of XML parts a tool reads.
  '.xlsx',
  '.yaml',
  '.yml',
]);

const toPosix = (value: string): string => value.split(path.sep).join('/');

/** `apps/web/server/runs/<this file>` → the repository root, five levels up. */
export const repositoryRoot = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const root = repositoryRoot;

/** The repository root as the filesystem spells it, so both sides of a comparison agree. */
const realRoot = realpathSync(root);

/** One absolute path, resolved through any symlinks, as a repository-relative posix path. */
export const relativeReal = (absolute: string): string => {
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // Not on disk, so there are no links to follow; compared as written.
  }
  return toPosix(path.relative(realRoot, real));
};

/** The in-memory store module, repository-relative — derived from this directory's own path. */
export const storeModule = relativeReal(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-store.ts'),
);

export interface TrackedFiles {
  readonly root: string;
  /** Every tracked path. */
  readonly tracked: readonly string[];
  /** The tracked paths this gate parses as modules. */
  readonly modules: readonly string[];
}

/**
 * The tracked paths (`git ls-files` at {@link repositoryRoot}, which the suite runs), with each
 * extension decided to be a module or a file no import reaches.
 */
export function classifyTrackedFiles(tracked: readonly string[]): TrackedFiles {
  const modules: string[] = [];
  for (const file of tracked) {
    const extension = path.posix.extname(file).toLowerCase();
    if (MODULE_EXTENSIONS.has(extension)) {
      modules.push(file);
      continue;
    }
    // Prose, data, configuration or an asset: no import specifier resolves to it.
    if (NON_MODULE_EXTENSIONS.has(extension)) continue;
    throw new Error(
      `${file} has the extension "${extension}", which this gate neither parses as a module ` +
        'nor recognises as a file no import specifier can resolve to. Decide which it is; do ' +
        'not leave it unclassified.',
    );
  }
  return { root, tracked, modules };
}
