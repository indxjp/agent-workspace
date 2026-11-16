import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Compare real paths on both sides so workspace symlinks cannot hide a database edge.
export function memoised<T>(answer: (key: string) => T): (key: string) => T {
  const known = new Map<string, { readonly value: T }>();
  return (key) => {
    const cached = known.get(key);
    if (cached !== undefined) return cached.value;
    const value = answer(key);
    known.set(key, { value });
    return value;
  };
}

export const repoRoot = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
);

/** Repository-relative, forward slashes, so a comparison means the same thing on either OS. */
export const posix = (value: string): string => value.split(path.sep).join('/');

const realRepoRoot = realpathSync(repoRoot);

/**
 * One absolute path, resolved through any symlinks, as a repository-relative posix path.
 *
 * Remembered per path: the tree does not change while this file runs, and the same few thousand
 * paths are asked about once per project and once per specifier.
 */
export const repoRelativeReal = memoised(resolveRepoRelativeReal);

function resolveRepoRelativeReal(absolute: string): string {
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // A path that is not on disk cannot be resolved through links, and is compared as written.
    // Nothing inside the layer reaches this branch: the layer roots are asserted to exist below.
  }
  return posix(path.relative(realRepoRoot, real));
}

export const OWNING_PACKAGE = 'packages/core/';

/** The package whose subpaths this gate is about. */
export const PACKAGE = '@agent-workspace/core';

/** The manifest this gate derives every path in it from. */
export const MANIFEST = 'packages/core/package.json';

/**
 * Extensions Node and `tsc` resolve as modules. A tracked file with one of these is parsed, and an
 * import edge can only come from one of them.
 */
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

/** One condition of one declared subpath, with the repository-relative file it names. */
export interface DeclaredTarget {
  /** The manifest key: `./db`, `./db/unscoped`, … */
  readonly subpath: string;
  /** The `exports` condition: `types`, `default`, … */
  readonly condition: string;
  /** Repository-relative path of the file that condition names. */
  readonly target: string;
}

/** Every condition of every key in the manifest's `exports`, flattened, in declaration order. */
function declaredTargets(): readonly DeclaredTarget[] {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, MANIFEST), 'utf8')) as {
    exports?: Record<string, Record<string, string> | string>;
  };
  const exportsMap = manifest.exports;
  if (exportsMap === undefined) {
    throw new Error(`${MANIFEST} declares no "exports"; this gate cannot run.`);
  }
  const flat: DeclaredTarget[] = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const conditions = typeof value === 'string' ? { default: value } : value;
    for (const [condition, specifier] of Object.entries(conditions)) {
      if (typeof specifier !== 'string') {
        throw new Error(
          `${MANIFEST} exports "${subpath}" with a "${condition}" condition that is not a string, ` +
            'so this gate cannot tell which file it names.',
        );
      }
      flat.push({
        subpath,
        condition,
        target: posix(path.posix.normalize(`packages/core/${specifier.replace(/^\.\//u, '')}`)),
      });
    }
  }
  return flat;
}

export const allTargets = declaredTargets();

/**
 * The public subpath's own targets, one per condition. `types` names the source barrel and every
 * other condition names a compiled one, so this is where both halves of the layer are found.
 */
export const publicTargets = allTargets.filter((row) => row.subpath === './db');
if (publicTargets.length === 0) {
  throw new Error(
    `${MANIFEST} declares no "./db" export. Either the manifest changed shape or this gate is ` +
      'reading the wrong file; either way it cannot run, so it fails (ADR-0015).',
  );
}

/**
 * The layer's roots, derived: the real directory of each condition of `./db`.
 *
 * `types: "./src/db/index.ts"` gives `packages/core/src/db/`; `default: "./dist/db/index.js"` gives
 * `packages/core/dist/db/`. Nothing here is written down as a path.
 */
const layerRoots: ReadonlyMap<string, string> = new Map(
  publicTargets.map((row) => {
    const directory = path.posix.dirname(row.target);
    const expected = row.subpath.slice('./'.length);
    if (path.posix.basename(directory) !== expected) {
      throw new Error(
        `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", whose ` +
          `directory is "${directory}". This gate takes that directory to be the database layer ` +
          `and expects it to be named "${expected}". It is not, so the derivation would widen ` +
          'past the layer rather than describe it.',
      );
    }
    // ADR-0015. The comparison this gate makes is between real paths, and a resolver answers
    // "no such module" for a path under a directory that is not on disk — so a missing build
    // output would turn every reach into the compiled half of the layer into a silent pass.
    const absolute = path.join(repoRoot, directory);
    if (!existsSync(absolute)) {
      throw new Error(
        `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", and ` +
          `"${directory}" does not exist. Run \`pnpm --filter @agent-workspace/core run build\` ` +
          'before `pnpm test`; CI does this in a step of its own. This gate compares resolved ' +
          'paths against that directory and cannot decide anything about it while it is absent.',
      );
    }
    return [row.condition, `${repoRelativeReal(absolute)}/`];
  }),
);

/** The half of the layer that is checked in. Reaching it from inside `packages/core` is that
 * package's own business; reaching any *other* root never is. */
const declaredSourceRoot = layerRoots.get('types');
if (declaredSourceRoot === undefined) {
  throw new Error(
    `${MANIFEST}'s "./db" export declares no "types" condition, so this gate cannot tell which ` +
      "directory holds the layer's source.",
  );
}
export const sourceRoot: string = declaredSourceRoot;

export const underRoot = (candidate: string, root: string): boolean =>
  candidate.startsWith(root) || candidate === root.slice(0, -1);

/** Is this repository-relative path inside any root of the database layer? */
export const insideLayer = (candidate: string): boolean =>
  [...layerRoots.values()].some((root) => underRoot(candidate, root));

export const databaseSubpaths = new Set<string>();
for (const row of allTargets) {
  const isDatabaseKey = row.subpath === './db' || row.subpath.startsWith('./db/');
  if (isDatabaseKey && insideLayer(row.target)) {
    databaseSubpaths.add(row.subpath);
  } else if (isDatabaseKey) {
    throw new Error(
      `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which is ` +
        `under none of the layer roots ${[...layerRoots.values()].join(', ')}. This gate ` +
        'classifies database entry points and cannot classify that one.',
    );
  } else if (insideLayer(row.target)) {
    throw new Error(
      `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which is ` +
        'inside the database layer under a key that is not a "./db" subpath. That is a second ' +
        'public door into the layer, and this gate would not have classified anything that went ' +
        'through it.',
    );
  }
  // The fourth arm: an export that names no file inside the layer. Its *surface* is still
  // classified, by the last describe block in this file.
}

/**
 * The declared database subpaths, partitioned: the public one, and — by definition, not by a list
 * — every other one, which is an escape. Written as a partition rather than as a `filter` so that
 * both halves are visibly accounted for and neither can be dropped.
 */
export const escapeSubpaths = new Set<string>();
export const publicSubpaths = new Set<string>();
for (const subpath of databaseSubpaths) {
  if (subpath === './db') publicSubpaths.add(subpath);
  else escapeSubpaths.add(subpath);
}
if (publicSubpaths.size !== 1) {
  throw new Error(
    `${MANIFEST} declares ${String(publicSubpaths.size)} public database subpaths; this gate is ` +
      'written for exactly one and would classify the others as neither public nor escape.',
  );
}

/** Every tracked path, with no pathspec at all. The narrowing happens in a classifier, below. */
export function trackedFiles(): readonly string[] {
  const listing = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return listing.split('\0').filter((file) => file !== '');
}

/**
 * Classify one tracked path by extension: a module this gate parses, or a file that can carry no
 * import edge. An extension in neither set is a hard failure naming the file (ADR-0027 clause 3).
 */
export function classifyTrackedFile(relative: string): 'module' | 'not-a-module' {
  const extension = path.posix.extname(relative).toLowerCase();
  if (MODULE_EXTENSIONS.has(extension)) return 'module';
  if (NON_MODULE_EXTENSIONS.has(extension)) return 'not-a-module';
  throw new Error(
    `${relative} has the extension "${extension}", which this gate neither parses as a module nor ` +
      'recognises as a file no import specifier can resolve to. Add it to MODULE_EXTENSIONS or to ' +
      'NON_MODULE_EXTENSIONS in this file; do not leave it unclassified.',
  );
}
