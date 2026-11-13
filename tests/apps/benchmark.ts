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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  revertGeneratedEdit,
  type GeneratedEdit,
  type GeneratedManifest,
} from '@indx-workspace/sdk/project';
import ts from 'typescript';

import { PUBLISHED_PACKAGES } from '../../scripts/release/pack-packages.mjs';

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
  /** Whether it counts towards the criterion: the four reference apps do, fixtures do not. */
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
 * install or a build writes, and the migration journal's snapshots (the generator's journal lives
 * at `db/migrations/meta/`).
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
];

/** Whether the handwritten count leaves `file` (relative, `/` separators) out. */
export function isExcludedFromCount(file: string): boolean {
  return EXCLUDED.some((pattern) => pattern.test(file));
}

/** Files whose comments start with `#`, not `//`. */
const HASH_COMMENTS = /\.(?:sh|ya?ml)$/u;

/**
 * The lines of `text` that count: not blank, and not only a comment (`//`, a `/* … *\/` block and
 * its `*` lines, or `#` in a shell or YAML file).
 */
export function countedLines(file: string, text: string): number {
  const hash = HASH_COMMENTS.test(file);
  let inBlock = false;
  let counted = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) {
        inBlock = false;
        if (line.slice(line.indexOf('*/') + 2).trim() !== '') counted += 1;
      }
      continue;
    }
    if (line === '' || (hash && line.startsWith('#')) || (!hash && line.startsWith('//'))) continue;
    if (!hash && line.startsWith('/*')) {
      inBlock = !line.includes('*/');
      if (!inBlock && line.slice(line.indexOf('*/') + 2).trim() !== '') counted += 1;
      continue;
    }
    counted += 1;
  }
  return counted;
}

/** Every file under `appDir`, relative, with `/` separators, sorted; `node_modules` and `.next` aside. */
export async function filesOf(appDir: string): Promise<string[]> {
  const entries = await readdir(appDir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(appDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .filter((file) => !/(?:^|\/)(?:node_modules|\.next)\//u.test(file))
    .sort();
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Each recorded file, its sha256 and the recorded edits that target it, newest kind first. */
interface RecordedFile {
  readonly sha256: string;
  readonly edits: readonly GeneratedEdit[];
}

/**
 * The entries in the order they were generated, as far as the manifest says: the project and the
 * app first (create writes them), then everything generated over them. The manifest keeps no
 * time, so entries of one kind are in key order.
 */
function generationRank(key: string): number {
  if (key.startsWith('project:')) return 0;
  if (key.startsWith('app:')) return 1;
  return 2;
}

function recordedFiles(manifest: GeneratedManifest): Map<string, RecordedFile> {
  const entries = Object.entries(manifest.entries).sort(
    ([left], [right]) => generationRank(right) - generationRank(left),
  );
  const edits = entries.flatMap(([, entry]) => entry.edits);
  const recorded = new Map<string, RecordedFile>();
  for (const [, entry] of entries) {
    for (const [file, hash] of Object.entries(entry.files)) {
      recorded.set(file, { sha256: hash, edits: edits.filter((edit) => edit.path === file) });
    }
  }
  return recorded;
}

/**
 * Whether `text` is what the generator recorded: its sha256 matches as it is, or once the edits
 * recorded for it are reverted, newest entry first. A revert that cannot apply yet (a journal entry
 * a later one follows) is tried again after the others, until none applies.
 */
export function isUnedited(text: string, recorded: RecordedFile): boolean {
  let current = text;
  if (sha256(current) === recorded.sha256) return true;
  let pending = [...recorded.edits];
  for (let progressed = true; progressed && pending.length > 0;) {
    progressed = false;
    const next: GeneratedEdit[] = [];
    for (const edit of pending) {
      const outcome = revertGeneratedEdit(current, edit);
      if (outcome.kind !== 'reverted') {
        next.push(edit);
        continue;
      }
      current = outcome.text;
      progressed = true;
      if (sha256(current) === recorded.sha256) return true;
    }
    pending = next;
  }
  return false;
}

export type GeneratedFileState = 'unedited' | 'edited' | 'missing';

/** Each file the manifest records, and whether the app still holds it as generated. */
export async function generatedFileStates(
  appDir: string,
  manifest: GeneratedManifest,
): Promise<Map<string, GeneratedFileState>> {
  const states = new Map<string, GeneratedFileState>();
  for (const [file, recorded] of recordedFiles(manifest)) {
    const target = path.join(appDir, file);
    if (!existsSync(target)) {
      states.set(file, 'missing');
      continue;
    }
    states.set(file, isUnedited(await readFile(target, 'utf8'), recorded) ? 'unedited' : 'edited');
  }
  return new Map([...states].sort(([left], [right]) => left.localeCompare(right)));
}

/** One file counted as handwritten, and its counted lines. */
export interface HandwrittenFile {
  readonly file: string;
  readonly lines: number;
}

/** What {@link countHandwritten} found. */
export interface HandwrittenCount {
  readonly lines: number;
  readonly files: readonly HandwrittenFile[];
}

/**
 * The handwritten code of an app: every file the generators did not write, and every one they did
 * that has been edited since (counted in full), except the paths {@link isExcludedFromCount}
 * leaves out. `aw-generated.json` is the generators' record and never counts.
 */
export async function countHandwritten(
  appDir: string,
  manifest: GeneratedManifest,
): Promise<HandwrittenCount> {
  const states = await generatedFileStates(appDir, manifest);
  const files: HandwrittenFile[] = [];
  for (const file of await filesOf(appDir)) {
    if (file === 'aw-generated.json' || isExcludedFromCount(file)) continue;
    if (states.get(file) === 'unedited') continue;
    files.push({
      file,
      lines: countedLines(file, await readFile(path.join(appDir, file), 'utf8')),
    });
  }
  return { lines: files.reduce((sum, file) => sum + file.lines, 0), files };
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
    benchmark.reference ? 'yes' : 'no (fixture)',
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
