/**
 * The handwritten budget of a use case (SSOT §4, `use-cases/README.md`): its archetype, declared
 * by the generator's `project:<archetype>` entry in `aw-generated.json`, sets the most lines it may
 * write by hand, and the counter shared with the apps benchmark (`tests/apps/handwritten.ts`)
 * measures them.
 *
 * Every file counts except an explicit list of what is not code: Markdown, the eval YAML under
 * `evals/`, `data/`, tests and test support, and the files the generator wrote that are still
 * exactly what the archetype's template makes for this slug (recomputed from `templates/`, never
 * read from the entry's own manifest). Every file a production file imports counts too, wherever
 * it is (a `.d.ts` or JSON aside), so moving code elsewhere does not dodge the budget.
 *
 * What the budget refuses outright, as problems: a manifest the generator cannot have written, a
 * relative import that does not resolve, a subpath (`#…`) or absolute import, a production import
 * of anything under `data/` but JSON (which is data, and may be imported) or test support, and a
 * script the coverage gate cannot measure (`.py`, `.sh`, …).
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GENERATED_MANIFEST_FILE,
  parseGeneratedManifest,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';

import { moduleSpecifiers } from '../../tests/apps/benchmark.ts';
import {
  countedLines,
  countHandwritten,
  filesOf,
  type HandwrittenFile,
} from '../../tests/apps/handwritten.ts';
import {
  ARCHETYPE_BUDGETS,
  ARCHETYPES,
  sha256,
  templateFiles,
  type Archetype,
} from './archetypes.ts';

/** The generator's entry for the copied template: `project:<archetype in lower case>`. */
const PROJECT_ENTRY = /^project:([a-z]+)$/u;

const isArchetype = (value: string): value is Archetype => Object.hasOwn(ARCHETYPE_BUDGETS, value);

/**
 * The archetype `manifest` declares: its one `project:<code>` entry. `null` when there is none,
 * more than one, or one that names no archetype.
 */
export function archetypeOf(manifest: GeneratedManifest): Archetype | null {
  const codes = Object.keys(manifest.entries).flatMap((key) => {
    const code = PROJECT_ENTRY.exec(key)?.[1]?.toUpperCase();
    return code === undefined ? [] : [code];
  });
  const [code] = codes;
  return codes.length === 1 && code !== undefined && isArchetype(code) ? code : null;
}

/** What is not code and so never counts (SSOT §4). */
const NOT_CODE = [
  /\.mdx?$/u,
  /^evals\/[^/]+\.ya?ml$/u,
  /(?:^|\/)data\//u,
  /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u,
  /(?:^|\/)(?:node_modules|coverage)\//u,
];

/** Whether a use case's file (relative to its folder, `/` separators) is outside the count. */
export function isSkippedInUseCase(file: string): boolean {
  return NOT_CODE.some((pattern) => pattern.test(file));
}

/** Code the coverage gate measures (`./coverage.ts`); a declaration file runs nothing. */
export const MEASURED_CODE = /(?<!\.d)\.(?:ts|tsx|mts|mjs|cjs|js|jsx)$/u;
/**
 * Scripts the coverage gate cannot measure, so a use case may not carry them (SSOT §5.2): other
 * languages, and `.cts`, whose TypeScript Vitest 5's v8 provider fails to parse when no test loads
 * it and so leaves out of the report instead of failing it.
 */
const UNMEASURED_SCRIPT = /(?<!\.d)\.(?:cts|py|sh|bash|zsh|ps1|rb|pl|php|lua)$/u;

const SKILL_SCRIPT = /(?:^|\/)skills\/[^/]+\/scripts\//u;

/**
 * Why a production file is a script the coverage gate cannot measure: anything under
 * `skills/<name>/scripts/` that is not JavaScript or TypeScript (an extensionless file included),
 * and a script in another language anywhere. `undefined` when it is not.
 */
function scriptProblem(file: string): string | undefined {
  if (SKILL_SCRIPT.test(file) && !MEASURED_CODE.test(file)) {
    return `${file}: a skill script must be JavaScript or TypeScript the coverage gate measures`;
  }
  return UNMEASURED_SCRIPT.test(file)
    ? `${file}: the coverage gate cannot measure this script; write it in JavaScript or TypeScript`
    : undefined;
}

/**
 * Every symbolic link in the use case (`lstat`, not followed): a link would let a file be counted
 * and covered as something other than what runs, so a use case holds its own files.
 */
async function symbolicLinks(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) =>
      path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .filter((file) => !/(?:^|\/)node_modules(?:\/|$)/u.test(file))
    .sort()
    .map((file) => `${file}: a symbolic link; a use case holds its own files`);
}

const MODULE_FILE = /\.[cm]?[jt]sx?$/u;
const DECLARATION_OR_JSON = /(?:\.d\.[cm]?ts|\.json)$/u;
/**
 * What production code may not import: anything under `data/` but a `.json` file (it is
 * uncounted, so code, a native addon or WebAssembly there would dodge the budget) and test
 * support. A JSON file under `data/` is data: a project may import it (such as a public-source
 * snapshot, ADR-0170), and it stays uncounted like the rest of `data/`.
 */
const FORBIDDEN_TARGET = [
  /(?:^|\/)data\/.*(?<!\.json)$/u,
  /\.(?:test|spec|test-support)\.[cm]?[jt]sx?$/u,
];

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const SWAPS: readonly (readonly [string, readonly string[]])[] = [
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
];

const isFile = (candidate: string): boolean =>
  existsSync(candidate) && statSync(candidate).isFile();

/** Resolve a relative specifier the way TypeScript does; `null` when nothing matches. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const swapped = SWAPS.flatMap(([from, to]) =>
    base.endsWith(from) ? to.map((ext) => `${base.slice(0, -from.length)}${ext}`) : [],
  );
  const candidates = [
    base,
    ...swapped,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find(isFile) ?? null;
}

interface Followed {
  readonly files: HandwrittenFile[];
  readonly problems: string[];
}

/**
 * Follow the imports of the production files `roots` (absolute), transitively: every target not
 * already counted is counted (named relative to `dir`, `../shared/x.ts`), and every specifier the
 * budget cannot follow, or that reaches `data/` code or test support, is a problem.
 */
async function followImports(
  dir: string,
  roots: readonly string[],
  counted: ReadonlySet<string>,
): Promise<Followed> {
  const seen = new Set<string>(roots);
  const files: HandwrittenFile[] = [];
  const problems: string[] = [];
  const name = (file: string): string => path.relative(dir, file).split(path.sep).join('/');
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!MODULE_FILE.test(next)) continue;
    const from = name(next);
    for (const specifier of moduleSpecifiers(next, await readFile(next, 'utf8'))) {
      if (specifier.startsWith('#') || path.isAbsolute(specifier)) {
        problems.push(`${from}: imports ${specifier}, which the budget cannot follow`);
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const target = resolveRelative(next, specifier);
      if (target === null) {
        problems.push(`${from}: cannot resolve ${specifier}`);
        continue;
      }
      const file = name(target);
      if (FORBIDDEN_TARGET.some((pattern) => pattern.test(file))) {
        problems.push(
          `${from}: imports ${file}; production code may not import data/ code or tests`,
        );
      }
      if (DECLARATION_OR_JSON.test(target) || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
      if (!counted.has(file)) {
        files.push({ file, lines: countedLines(file, await readFile(target, 'utf8')) });
      }
    }
  }
  return { files, problems };
}

/** What {@link measureUseCase} found for one use case. */
export interface UseCaseMeasure {
  readonly slug: string;
  readonly archetype: Archetype | null;
  readonly budget: number | null;
  readonly lines: number;
  readonly files: readonly HandwrittenFile[];
  /** What the budget refuses whatever the count: see the module comment. */
  readonly problems: readonly string[];
}

/**
 * Why `manifest` is not one the use-case generator wrote for this slug: any entry but the one
 * `project:<archetype>`, any edit, or a recorded file the template does not make as recorded.
 */
function manifestProblems(manifest: GeneratedManifest, expected: ReadonlyMap<string, string>) {
  return Object.entries(manifest.entries).flatMap(([key, entry]) => {
    if (!PROJECT_ENTRY.test(key)) {
      return [`${GENERATED_MANIFEST_FILE} holds ${key}, which the use-case generator never writes`];
    }
    const edits = entry.edits.map(
      (edit) =>
        `${GENERATED_MANIFEST_FILE} records an edit of ${edit.path}, which the generator never makes`,
    );
    const files = Object.entries(entry.files).flatMap(([file, hash]) => {
      const text = expected.get(file);
      return text !== undefined && sha256(text) === hash
        ? []
        : [`${GENERATED_MANIFEST_FILE} records ${file}, which its template does not make so`];
    });
    return [...edits, ...files];
  });
}

/** Read `aw-generated.json` in `dir`; an absent one is an empty manifest. */
async function manifestIn(dir: string): Promise<GeneratedManifest> {
  const file = path.join(dir, GENERATED_MANIFEST_FILE);
  return parseGeneratedManifest(
    existsSync(file) ? await readFile(file, 'utf8') : '{"version":1,"entries":{}}',
  );
}

/** Measure the use case in `dir`, whose `use-cases/` folder is `useCasesDir` (its parent by default). */
export async function measureUseCase(
  dir: string,
  useCasesDir = path.dirname(dir),
): Promise<UseCaseMeasure> {
  const slug = path.basename(dir);
  const declared = await manifestIn(dir);
  const archetype = archetypeOf(declared);
  const expected =
    archetype === null
      ? new Map<string, string>()
      : await templateFiles(useCasesDir, archetype, slug);
  // Unedited means: what the template makes for this slug, as recomputed here.
  const trusted: GeneratedManifest = {
    version: 1,
    entries: {
      'project:template': {
        files: Object.fromEntries([...expected].map(([file, text]) => [file, sha256(text)])),
        edits: [],
      },
    },
  };
  const own = await countHandwritten(dir, trusted, isSkippedInUseCase);
  const production = (await filesOf(dir)).filter(
    (file) => file !== GENERATED_MANIFEST_FILE && !isSkippedInUseCase(file),
  );
  const followed = await followImports(
    dir,
    production.map((file) => path.join(dir, file)),
    new Set(own.files.map(({ file }) => file)),
  );
  const files = [...own.files, ...followed.files];
  const scripts = [...new Set([...production, ...followed.files.map(({ file }) => file)])].flatMap(
    (file) => scriptProblem(file) ?? [],
  );
  return {
    slug,
    archetype,
    budget: archetype === null ? null : ARCHETYPE_BUDGETS[archetype],
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    files,
    problems: [
      ...(await symbolicLinks(dir)),
      ...manifestProblems(declared, expected),
      ...followed.problems,
      ...scripts,
    ],
  };
}

/** Why `measure` fails the budget; empty when it is within it and nothing is refused. */
export function budgetProblems(measure: UseCaseMeasure): string[] {
  const refused = measure.problems.map((problem) => `${measure.slug}: ${problem}`);
  if (measure.archetype === null || measure.budget === null) {
    return [
      `${measure.slug}: ${GENERATED_MANIFEST_FILE} names no archetype (one project:<${ARCHETYPES.join('|').toLowerCase()}> entry)`,
      ...refused,
    ];
  }
  if (measure.lines <= measure.budget) return refused;
  const files = measure.files.map(({ file, lines }) => `${file} ${String(lines)}`).join(', ');
  return [
    `${measure.slug}: ${String(measure.lines)} handwritten lines, over the ${measure.archetype} budget of ${String(measure.budget)} (${files})`,
    ...refused,
  ];
}
