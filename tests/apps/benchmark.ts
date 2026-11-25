/**
 * The apps benchmark (issue #1531): the six cells every example app under `examples/` is scored on,
 * and the offline measures behind three of them.
 *
 * The programme's completion criterion is binary, so a cell is `ok` or a `gap`, and each names its
 * evidence:
 *
 * - `computed` — worked out by `./benchmark.test.ts` from the app's files: Handwritten budget
 *   ({@link countHandwritten}), No fork ({@link importOffenders}) and the manifest half of
 *   Generated ({@link generatedFileStates}; the other half is `regenerate.mjs --check`).
 * - `contract` — a test in the app, named by its quoted title (Agent on data).
 * - `lane` — a Playwright title or a step of the apps-e2e lane (Journeys, Self-host), which needs an
 *   installed app and Docker and so does not run in `pnpm test`.
 *
 * Pure apart from reading the app's files.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { GeneratedManifest } from '@indx-workspace/sdk/project';
import ts from 'typescript';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';
import {
  countHandwritten as countShared,
  filesOf,
  type GeneratedFileState,
  type HandwrittenCount,
} from './handwritten.ts';

export {
  countedLines,
  generatedFileStates,
  isBinary,
  type HandwrittenCount,
} from './handwritten.ts';

/** The six cells, in the scoreboard's column order. */
export const APP_CELLS = [
  'generated',
  'handwritten',
  'journeys',
  'agentOnData',
  'selfHost',
  'noFork',
] as const;
export type AppCell = (typeof APP_CELLS)[number];

export const APP_CELL_TITLES: Readonly<Record<AppCell, string>> = {
  generated: 'Generated',
  handwritten: 'Handwritten budget',
  journeys: 'Journeys',
  agentOnData: 'Agent on data',
  selfHost: 'Self-host',
  noFork: 'No fork',
};

/** `ok`: the app meets the cell. `gap`: it does not, and the note says why. */
export type Verdict = 'ok' | 'gap';
export type EvidenceKind = 'computed' | 'contract' | 'lane';

/** A cell the app declares, with the evidence that backs it. */
interface DeclaredCell<Kind extends EvidenceKind> {
  readonly verdict: Verdict;
  readonly evidence: Kind;
  /** The repository path of the file holding the evidence: a test, an e2e spec or the lane. */
  readonly file: string;
  /** The exact title of the test, or the lane step's id, quoted in `file`. */
  readonly ref: string;
  /** One sentence the scoreboard shows beside a gap. */
  readonly note: string;
}

/** A cell a test in the app proves. */
export type ContractRef = DeclaredCell<'contract'>;
/** A cell the apps-e2e lane proves. */
export type LaneRef = DeclaredCell<'lane'>;

/**
 * The Journeys cell. A gap's `ref` names the journey it excuses; when the note says more than one
 * journey is not met, `alsoExcused` names each other one by its exact title in `file`, so the lane
 * excuses those failures too and still fails on any journey nobody named. Only a gap may name any.
 */
export interface JourneysRef extends LaneRef {
  readonly alsoExcused?: readonly string[];
}

/** What `examples/<id>/benchmark.ts` default-exports, as a plain object that imports nothing. */
export interface AppBenchmark {
  /** The app's directory under `examples/`. */
  readonly id: string;
  /** Its row in the scoreboard. */
  readonly order: number;
  readonly title: string;
  /** Whether it counts towards the criterion: the four reference apps do, the other apps do not. */
  readonly reference: boolean;
  /** The most handwritten lines it may have. */
  readonly budget: number;
  /**
   * Generated files the app has made its own code, such as a recipe's body or a resource's
   * `agents.write`: the Generated comparison leaves them out, and Handwritten counts each in full.
   * Any other edit of a generated file is a Generated gap.
   */
  readonly takenOver?: readonly string[];
  readonly cells: {
    readonly journeys: JourneysRef;
    readonly agentOnData: ContractRef;
    readonly selfHost: LaneRef;
  };
}

/** Declare an app's benchmark: the identity, so a registry type-checks the plain object. */
export function defineAppBenchmark(benchmark: AppBenchmark): AppBenchmark {
  return benchmark;
}

/**
 * The paths the handwritten count leaves out: the benchmark's own files, tests and specs, what an
 * install or a build writes, the migration journal's snapshots (the generator's journal lives at
 * `db/migrations/meta/`), and checked-in generated output, a file whose name ends in
 * `.generated.ts` (a script writes it and a test checks it is current; nobody writes it by hand).
 */
const EXCLUDED: readonly RegExp[] = [
  /^commands\.sh$/u,
  /^benchmark\.ts$/u,
  /^README\.md$/u,
  /^e2e\//u,
  /^tests\//u,
  /^\.aw\//u,
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json)$/u,
  /(?:^|\/)node_modules\//u,
  /(?:^|\/)\.next\//u,
  /^(?:db\/)?migrations\/meta\//u,
  /\.generated\.ts$/u,
];

/** Whether the handwritten count leaves `file` (relative, `/` separators) out. */
export function isExcludedFromCount(file: string): boolean {
  return EXCLUDED.some((pattern) => pattern.test(file));
}

/**
 * The store app's landing copy (Owner decision, 2026-11-21): each entry's page prose lives in
 * `catalog/landing/<slug>.md`, JA then EN, and a generator turns it into `landing.generated.ts`.
 * SSOT §4 (the maintainers' plan, `use-cases-100-plan.md`) counts no Markdown: it is knowledge,
 * reviewed as prose. Exactly those files of exactly the store app are left out; any other `.md`
 * under `catalog/`, and every other app's files, still count.
 */
export const STORE_APP_ID = 'store';
const STORE_LANDING_COPY = /^catalog\/landing\/[a-z0-9-]+\.md$/u;

/**
 * The store app's per-entry catalog files (Owner decision, 2026-11-21, SSOT §4 and §11):
 * `catalog/<slug>.ts` is one entry's pure `defineEntry` data, like its landing copy, and is not
 * counted. A file is an entry file only when `<slug>` is an actual catalog entry: a default import of
 * `catalog/index.ts`, the catalog's one list of entries (tests/store/catalog.test.ts keeps it equal
 * to the entries). The catalog's own modules (`define.ts`, `index.ts`, `recording.ts`,
 * `verification.ts`) and any helper beside them are no entry and still count.
 */
const STORE_CATALOG_INDEX = 'catalog/index.ts';
const STORE_ENTRY_IMPORT = /^import [A-Za-z0-9_$]+ from '\.\/([a-z0-9]+(?:-[a-z0-9]+)*)\.ts';$/gmu;
const STORE_CATALOG_FILE = /^catalog\/([a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/u;

/** The entry slugs `catalog/index.ts` (its text) imports, one default import per entry file. */
export function storeEntrySlugs(indexText: string): ReadonlySet<string> {
  return new Set([...indexText.matchAll(STORE_ENTRY_IMPORT)].map((match) => match[1] ?? ''));
}

/** Why `node` is not plain data: a literal, an array of them or an object literal of them. */
function dataProblem(node: ts.Expression): string | null {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return null;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      const problem = dataProblem(element);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        return `${ts.SyntaxKind[property.kind]} where only a literal key and value may be`;
      }
      const problem = dataProblem(property.initializer);
      if (problem !== null) return problem;
    }
    return null;
  }
  return `${ts.SyntaxKind[node.kind]} where only data may be`;
}

/**
 * Why the text of a store entry file is not pure `defineEntry` data, or `null` when it is: exactly
 * `import { defineEntry } from './define.ts';` and `export default defineEntry({...});`, the object
 * holding only literal keys and literal, array and object values (no spread, identifier, call,
 * function or `${}` template). This keeps the Owner's exception to data: code in an entry file
 * fails the benchmark instead of leaving the count.
 */
export function storeEntryFileProblem(text: string): string | null {
  const source = ts.createSourceFile('entry.ts', text, ts.ScriptTarget.Latest, false);
  const [first, second, ...rest] = source.statements;
  const imports =
    first !== undefined &&
    ts.isImportDeclaration(first) &&
    ts.isStringLiteral(first.moduleSpecifier) &&
    first.moduleSpecifier.text === './define.ts' &&
    first.importClause?.name === undefined &&
    first.importClause?.isTypeOnly === false &&
    first.importClause.namedBindings !== undefined &&
    ts.isNamedImports(first.importClause.namedBindings) &&
    first.importClause.namedBindings.elements.length === 1 &&
    first.importClause.namedBindings.elements[0]?.propertyName === undefined &&
    first.importClause.namedBindings.elements[0]?.name.text === 'defineEntry';
  if (!imports) return "the first statement is not import { defineEntry } from './define.ts'";
  const call =
    second !== undefined &&
    ts.isExportAssignment(second) &&
    second.isExportEquals !== true &&
    ts.isCallExpression(second.expression) &&
    ts.isIdentifier(second.expression.expression) &&
    second.expression.expression.text === 'defineEntry' &&
    second.expression.typeArguments === undefined &&
    second.expression.arguments.length === 1
      ? second.expression.arguments[0]
      : undefined;
  if (call === undefined || !ts.isObjectLiteralExpression(call)) {
    return 'the second statement is not export default defineEntry({...})';
  }
  if (rest.length > 0) return 'it has statements beyond the import and the default export';
  return dataProblem(call);
}

/**
 * Whether the handwritten count of the app `appId` leaves `file` out. `entrySlugs` are the store's
 * catalog entries ({@link storeEntrySlugs}); no other app has any.
 */
export function isExcludedFromAppCount(
  appId: string,
  file: string,
  entrySlugs: ReadonlySet<string> = new Set(),
): boolean {
  if (isExcludedFromCount(file)) return true;
  if (appId !== STORE_APP_ID) return false;
  const entry = STORE_CATALOG_FILE.exec(file)?.[1];
  return STORE_LANDING_COPY.test(file) || (entry !== undefined && entrySlugs.has(entry));
}

/**
 * The handwritten code of an app: every file the generators did not write, and every one they did
 * that has been edited since (counted in full), except the paths {@link isExcludedFromAppCount}
 * leaves out. `aw-generated.json` is the generators' record and never counts. The counting rule is
 * `./handwritten.ts`, which the use cases' benchmark shares.
 */
export async function countHandwritten(
  appDir: string,
  manifest: GeneratedManifest,
): Promise<HandwrittenCount> {
  const appId = path.basename(appDir);
  const index = path.join(appDir, STORE_CATALOG_INDEX);
  const entrySlugs =
    appId === STORE_APP_ID && existsSync(index)
      ? storeEntrySlugs(await readFile(index, 'utf8'))
      : new Set<string>();
  for (const slug of entrySlugs) {
    const file = path.join(appDir, 'catalog', `${slug}.ts`);
    const problem = storeEntryFileProblem(await readFile(file, 'utf8'));
    if (problem !== null) {
      throw new Error(`catalog/${slug}.ts is not pure defineEntry data: ${problem}`);
    }
  }
  return countShared(appDir, manifest, (file) => isExcludedFromAppCount(appId, file, entrySlugs));
}

/** Files whose module specifiers {@link importOffenders} reads. */
const MODULE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;

/** Every string a file names as a module: imports, re-exports, `import()` and `require()`. */
export function moduleSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [first] = node.arguments;
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first.text);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        found.push(argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const PLATFORM_SCOPE = '@agent-workspace/';
const PUBLISHED_SCOPE = '@indx-workspace/';
const PUBLISHED: ReadonlySet<string> = new Set(
  PUBLISHED_PACKAGES.map((name) => `${PUBLISHED_SCOPE}${name}`),
);

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageOf(specifier: string): string {
  const [first = '', second = ''] = specifier.split('/');
  return first.startsWith('@') ? `${first}/${second}` : first;
}

/** Why `specifier`, named by `file` of the app at `appDir`, is a fork; `undefined` when it is not. */
function specifierOffence(appDir: string, file: string, specifier: string): string | undefined {
  if (specifier.startsWith(PLATFORM_SCOPE)) return 'is the platform, not a published package';
  if (specifier.startsWith('.')) {
    const target = path.resolve(path.dirname(path.join(appDir, file)), specifier);
    const relative = path.relative(appDir, target);
    return relative.startsWith('..') || path.isAbsolute(relative)
      ? 'reaches outside the app'
      : undefined;
  }
  if (path.isAbsolute(specifier)) return 'is an absolute path';
  if (specifier.startsWith(PUBLISHED_SCOPE) && !PUBLISHED.has(packageOf(specifier))) {
    return 'is not a published package';
  }
  return undefined;
}

/** Why one `package.json` dependency is a fork; `undefined` when it is not. */
function dependencyOffence(name: string, spec: string): string | undefined {
  if (name.startsWith(PLATFORM_SCOPE)) return 'is the platform, not a published package';
  if (name.startsWith(PUBLISHED_SCOPE) && !PUBLISHED.has(name)) return 'is not a published package';
  if (/^(?:workspace|link|file|portal):/u.test(spec)) return `is installed from ${spec}`;
  return undefined;
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Everything in the app that is not a published package (the No fork cell): a platform
 * (`@agent-workspace/*`) specifier, a relative one that resolves outside the app, an
 * `@indx-workspace/*` package that is not published, and a `package.json` dependency that names
 * either or is installed from a path or a workspace. Each is `file: specifier — reason`.
 */
export async function importOffenders(appDir: string): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await filesOf(appDir)) {
    const text = await readFile(path.join(appDir, file), 'utf8');
    if (MODULE_FILE.test(file)) {
      for (const specifier of moduleSpecifiers(file, text)) {
        const offence = specifierOffence(appDir, file, specifier);
        if (offence !== undefined) offenders.push(`${file}: ${specifier} ${offence}`);
      }
    } else if (path.posix.basename(file) === 'package.json') {
      const manifest = JSON.parse(text) as Record<string, unknown>;
      for (const section of DEPENDENCY_SECTIONS) {
        const pins = manifest[section];
        if (typeof pins !== 'object' || pins === null) continue;
        for (const [name, spec] of Object.entries(pins)) {
          const offence = dependencyOffence(name, String(spec));
          if (offence !== undefined) offenders.push(`${file}: ${section}.${name} ${offence}`);
        }
      }
    }
  }
  return offenders;
}

/** The lane file a `lane` ref may name a step of; any other lane file is an `.e2e.mjs` spec. */
export const LANE_FILE = 'tests/apps/lane.mjs';

/**
 * Why a declared cell's evidence does not exist in `text`, the content of its `file`; `undefined`
 * when it does. A `contract` names a quoted test title; a `lane` ref names a step of `steps` in
 * {@link LANE_FILE} (quoted there too), or the quoted title of a `test(…)` in an `.e2e.mjs` spec.
 */
export function evidenceProblem(
  declared: Pick<ContractRef | LaneRef, 'evidence' | 'file' | 'ref'>,
  text: string,
  steps: readonly string[],
): string | undefined {
  const quoted = `'${declared.ref}'`;
  if (declared.evidence === 'contract') {
    return text.includes(quoted) ? undefined : `no title ${quoted} in ${declared.file}`;
  }
  if (declared.file === LANE_FILE) {
    return steps.includes(declared.ref) && text.includes(quoted)
      ? undefined
      : `${quoted} is not a step of ${LANE_FILE}`;
  }
  if (!declared.file.endsWith('.e2e.mjs')) {
    return `${declared.file} is neither ${LANE_FILE} nor an .e2e.mjs spec`;
  }
  const title = new RegExp(`\\btest\\(\\s*${quoted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u');
  return title.test(text) ? undefined : `no journey titled ${quoted} in ${declared.file}`;
}

/** An app's six verdicts, the computed ones worked out, and its handwritten lines. */
export interface AppScore {
  readonly benchmark: AppBenchmark;
  readonly verdicts: Readonly<Record<AppCell, Verdict>>;
  readonly handwritten: number;
}

/** The computed verdicts beside the declared ones. */
export function scoreApp(
  benchmark: AppBenchmark,
  measured: {
    readonly handwritten: HandwrittenCount;
    readonly offenders: readonly string[];
    readonly states: ReadonlyMap<string, GeneratedFileState>;
  },
): AppScore {
  const takenOver = new Set(benchmark.takenOver ?? []);
  const unedited = [...measured.states].every(
    ([file, state]) => state === 'unedited' || (state === 'edited' && takenOver.has(file)),
  );
  return {
    benchmark,
    handwritten: measured.handwritten.lines,
    verdicts: {
      generated: unedited ? 'ok' : 'gap',
      handwritten: measured.handwritten.lines <= benchmark.budget ? 'ok' : 'gap',
      journeys: benchmark.cells.journeys.verdict,
      agentOnData: benchmark.cells.agentOnData.verdict,
      selfHost: benchmark.cells.selfHost.verdict,
      noFork: measured.offenders.length === 0 ? 'ok' : 'gap',
    },
  };
}

/** The share of an app's cells that are `ok`, from 0 to 1: the criterion is 1 for every reference app. */
export function scoreOf(score: AppScore): number {
  return APP_CELLS.filter((cell) => score.verdicts[cell] === 'ok').length / APP_CELLS.length;
}

const MARK: Readonly<Record<Verdict, string>> = { ok: '✅', gap: '❌' };

/**
 * The scoreboard `examples/README.md` shows: one row per app, one column per cell, the
 * handwritten lines against the budget, and the gaps the apps declare.
 */
export function renderScoreboard(scores: readonly AppScore[]): string {
  const header = [
    'App',
    'Reference',
    ...APP_CELLS.map((cell) => APP_CELL_TITLES[cell]),
    'Handwritten / budget',
  ];
  const rows = scores.map(({ benchmark, verdicts, handwritten }) => [
    `[${benchmark.title}](./${benchmark.id}/)`,
    benchmark.reference ? 'yes' : 'no',
    ...APP_CELLS.map((cell) => MARK[verdicts[cell]]),
    `${String(handwritten)} / ${String(benchmark.budget)}`,
  ]);
  const gaps = scores.flatMap(({ benchmark }) =>
    (['journeys', 'agentOnData', 'selfHost'] as const)
      .filter((cell) => benchmark.cells[cell].verdict === 'gap')
      .map((cell) => `- ${benchmark.id}, ${APP_CELL_TITLES[cell]}: ${benchmark.cells[cell].note}`),
  );
  const table = [header, header.map(() => '---'), ...rows]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n');
  return gaps.length === 0 ? table : `${table}\n\nDeclared gaps:\n\n${gaps.join('\n')}`;
}
