/* global console */
/**
 * Reproducible quality baseline (engineering audit W0-3).
 *
 *   node scripts/metrics/baseline.mjs [--out <file>]   measure, write JSON (default
 *                                                      docs/metrics/baseline-<YYYY-MM-DD>.json)
 *   node scripts/metrics/baseline.mjs --check          re-measure, validate the newest committed
 *                                                      docs/metrics/baseline-*.json, print drift
 *
 * `--check` is informational: it exits non-zero only when the measurement throws, or the newest
 * committed baseline is missing or malformed. Metric drift is printed, never a failure.
 * Node stdlib plus the ESLint already in the repo; counts are over git-tracked files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const metricsDir = path.join(root, 'docs', 'metrics');

const SOURCE = /\.(ts|tsx|mts|mjs)$/;
const TEST_PATH = /(\.test\.|\.spec\.|\/__tests__\/|\/testing\/|\/tests?\/|\/e2e\/|\/acceptance\/)/;

/** @param {string} file repo-relative, forward slashes */
export function isSource(file) {
  return SOURCE.test(file) && !file.endsWith('.d.ts');
}

/** @param {string} file */
export function isTestFile(file) {
  return TEST_PATH.test(`/${file}`);
}

/** @param {string} text */
export function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** The workspace a file belongs to: `apps/web`, `packages/core`, or its top-level directory. */
export function workspaceOf(/** @type {string} */ file) {
  const [a, b] = file.split('/');
  if (a === 'apps' || a === 'packages') return `${a}/${b}`;
  return b === undefined ? '(root files)' : (a ?? '');
}

/**
 * @param {Record<string, string>} files repo-relative path to content
 * @returns {Record<string, { productionLines: number, testLines: number, productionFiles: number, testFiles: number }>}
 */
export function sizesByWorkspace(files) {
  /** @type {Record<string, { productionLines: number, testLines: number, productionFiles: number, testFiles: number }>} */
  const out = {};
  for (const [file, text] of Object.entries(files)) {
    if (!isSource(file)) continue;
    const ws = workspaceOf(file);
    const row = (out[ws] ??= {
      productionLines: 0,
      testLines: 0,
      productionFiles: 0,
      testFiles: 0,
    });
    if (isTestFile(file)) {
      row.testLines += countLines(text);
      row.testFiles += 1;
    } else {
      row.productionLines += countLines(text);
      row.productionFiles += 1;
    }
  }
  return out;
}

/** Import, re-export and dynamic-import specifiers of `core/db` (and subpaths) in `text`. */
export function countCoreDbSpecifiers(/** @type {string} */ text) {
  return (text.match(/['"]@agent-workspace\/core\/db(?:\/[^'"]*)?['"]/g) ?? []).length;
}

/** Raw `fetch('/api...')` calls (single, double or template literal). */
export function countRawApiFetches(/** @type {string} */ text) {
  return (text.match(/\bfetch\(\s*['"`]\/api/g) ?? []).length;
}

/** `console.<method>(` calls outside comment lines. */
export function countConsoleCalls(/** @type {string} */ text) {
  return countOutsideComments(text, /\bconsole\.[a-z]+\(/g);
}

/** Every `fetch(` call (any URL) outside comment lines. */
export function countFetchCalls(/** @type {string} */ text) {
  return countOutsideComments(text, /\bfetch\(/g);
}

function countOutsideComments(/** @type {string} */ text, /** @type {RegExp} */ re) {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    n += (line.match(re) ?? []).length;
  }
  return n;
}

/**
 * Closed vocabularies exported from contracts: `export const X_STATUSES|X_ROLES = [...] as const`.
 * @param {Record<string, string>} files
 * @returns {Record<string, string[]>}
 */
export function contractVocabularies(files) {
  /** @type {Record<string, string[]>} */
  const out = {};
  const re = /export const ([A-Z][A-Z0-9_]*_(?:STATUSES|ROLES))\s*=\s*\[([^\]]*)\]\s*as const/g;
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith('packages/contracts/src/') || isTestFile(file)) continue;
    for (const m of text.matchAll(re)) {
      const members = [...(m[2] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '');
      if (members.length >= 2) out[m[1] ?? ''] = members;
    }
  }
  return out;
}

/** Quoted-string runs such as `'a' | 'b'` or `['a', 'b']`, as member sets. */
function stringRuns(/** @type {string} */ text) {
  /** @type {Set<string>[]} */
  const runs = [];
  for (const m of text.matchAll(/'[^'\n]+'(?:\s*[,|]\s*'[^'\n]+')+/g)) {
    runs.push(new Set([...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '')));
  }
  return runs;
}

/**
 * Production files outside contracts that re-declare a contracts vocabulary: a literal run that
 * contains every member (heuristic, grep-based; F-12 asks for the AST version as a test).
 * @param {Record<string, string>} files
 * @returns {Record<string, string[]>} vocabulary name to files
 */
export function duplicateVocabularies(files) {
  const vocabs = contractVocabularies(files);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [file, text] of Object.entries(files)) {
    if (!isSource(file) || isTestFile(file) || file.startsWith('packages/contracts/')) continue;
    const runs = stringRuns(text);
    for (const [name, members] of Object.entries(vocabs)) {
      if (runs.some((run) => members.every((member) => run.has(member)))) {
        (out[name] ??= []).push(file);
      }
    }
  }
  return out;
}

/** Counts of functions per complexity bucket (input: complexities above 10). */
export function complexityBuckets(/** @type {number[]} */ values) {
  const b = { '11-15': 0, '16-20': 0, '21-33': 0, '>33': 0 };
  for (const v of values) {
    if (v > 33) b['>33'] += 1;
    else if (v > 20) b['21-33'] += 1;
    else if (v > 15) b['16-20'] += 1;
    else if (v > 10) b['11-15'] += 1;
  }
  return { ...b, max: values.reduce((m, v) => Math.max(m, v), 0), above10: values.length };
}

/** @param {unknown} data @returns {string[]} problems; empty when well-formed */
export function validateBaseline(data) {
  if (typeof data !== 'object' || data === null) return ['not an object'];
  const d = /** @type {Record<string, unknown>} */ (data);
  const problems = [];
  if (d['schemaVersion'] !== SCHEMA_VERSION)
    problems.push(`schemaVersion is not ${SCHEMA_VERSION}`);
  for (const key of ['commit', 'measuredAt']) {
    if (typeof d[key] !== 'string') problems.push(`${key} missing`);
  }
  for (const key of [
    'sizes',
    'complexity',
    'coreDbImports',
    'rawApiFetches',
    'consoleCalls',
    'duplicateVocabularies',
  ]) {
    if (typeof d[key] !== 'object' || d[key] === null) problems.push(`${key} missing`);
  }
  return problems;
}

/** Flat numeric view for drift output. @returns {Record<string, number>} */
function flatten(/** @type {unknown} */ value, prefix = '', out = {}) {
  if (typeof value === 'number') /** @type {Record<string, number>} */ (out)[prefix] = value;
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function git(/** @type {string[]} */ ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
}

function readTracked() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const f of git('ls-files', '-z').split('\0')) {
    if (f && isSource(f)) files[f] = readFileSync(path.join(root, f), 'utf8');
  }
  return files;
}

async function measureComplexity(/** @type {Record<string, string>} */ files) {
  const { ESLint } = await import('eslint');
  const { default: tseslint } = await import('typescript-eslint');
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx,mts}'],
        languageOptions: { parser: tseslint.parser },
        linterOptions: { noInlineConfig: true },
        rules: {
          complexity: ['warn', { max: 10 }],
          'max-lines-per-function': ['warn', { max: 80 }],
          'max-depth': ['warn', 4],
          'max-params': ['warn', 5],
        },
      },
    ],
  });
  const targets = Object.keys(files).filter(
    (f) =>
      /^(apps|packages)\//.test(f) &&
      /\.(ts|tsx|mts)$/.test(f) &&
      !isTestFile(f) &&
      !f.includes('/dist/') &&
      !f.includes('generated'),
  );
  /** @type {number[]} */
  const complexity = [];
  const counts = { functionsOver80Lines: 0, functionsOver5Params: 0, depthOver4: 0 };
  for (let i = 0; i < targets.length; i += 200) {
    for (const r of await eslint.lintFiles(targets.slice(i, i + 200))) {
      for (const m of r.messages) {
        if (m.ruleId === 'complexity') {
          complexity.push(Number(/complexity of (\d+)/.exec(m.message)?.[1] ?? 0));
        } else if (m.ruleId === 'max-lines-per-function') counts.functionsOver80Lines += 1;
        else if (m.ruleId === 'max-params') counts.functionsOver5Params += 1;
        else if (m.ruleId === 'max-depth') counts.depthOver4 += 1;
      }
    }
  }
  return { filesMeasured: targets.length, ...complexityBuckets(complexity), ...counts };
}

export async function measure() {
  const files = readTracked();
  const prod = Object.entries(files).filter(([f]) => !isTestFile(f));
  /** Sum `fn` over production files matching `scope`. */
  const sum = (/** @type {(f: string, t: string) => number} */ fn, /** @type {RegExp} */ scope) =>
    prod.filter(([f]) => scope.test(f)).reduce((n, [f, t]) => n + fn(f, t), 0);

  const dbTotal = sum((_, t) => countCoreDbSpecifiers(t), /^apps\/web\//);
  const dbComposition = sum(
    (_, t) => countCoreDbSpecifiers(t),
    /^apps\/web\/server\/composition\//,
  );
  const dbStore = sum(
    (f, t) => (f.includes('/composition/') ? 0 : countCoreDbSpecifiers(t)),
    /^apps\/web\/.*store\.ts$/,
  );

  return {
    schemaVersion: SCHEMA_VERSION,
    commit: git('rev-parse', 'HEAD').trim(),
    measuredAt: new Date().toISOString().slice(0, 10),
    node: process.version,
    scope:
      'git-tracked .ts/.tsx/.mts/.mjs files; test = *.test.*, *.spec.*, tests/, testing/, e2e/, acceptance/',
    sizes: {
      byWorkspace: sizesByWorkspace(files),
      productionFilesOver500Lines: prod.filter(([, t]) => countLines(t) > 500).length,
      productionFilesOver1000Lines: prod.filter(([, t]) => countLines(t) > 1000).length,
    },
    complexity: await measureComplexity(files),
    coreDbImports: {
      webSpecifiersTotal: dbTotal,
      webSpecifiersInComposition: dbComposition,
      webSpecifiersInStoreFiles: dbStore,
      webSpecifiersElsewhere: dbTotal - dbComposition - dbStore,
      webFilesImporting: prod.filter(
        ([f, t]) => f.startsWith('apps/web/') && countCoreDbSpecifiers(t) > 0,
      ).length,
    },
    rawApiFetches: {
      webBrowserCode: sum(
        (_, t) => countRawApiFetches(t),
        /^apps\/web\/(components|app|lib)\/.*\.(ts|tsx)$/,
      ),
      webBrowserCodeAllFetchCalls: sum(
        (_, t) => countFetchCalls(t),
        /^apps\/web\/(components|app|lib)\/.*\.(ts|tsx)$/,
      ),
    },
    consoleCalls: {
      webServerAndApp: sum((_, t) => countConsoleCalls(t), /^apps\/web\/(server|app)\//),
      runner: sum((_, t) => countConsoleCalls(t), /^apps\/runner\/src\//),
      allAppsAndPackages: sum((_, t) => countConsoleCalls(t), /^(apps|packages)\//),
    },
    duplicateVocabularies: duplicateVocabularies(files),
  };
}

function latestCommitted() {
  const names = readdirSync(metricsDir)
    .filter((n) => /^baseline-.*\.json$/.test(n))
    .sort();
  const last = names[names.length - 1];
  return last ? path.join(metricsDir, last) : undefined;
}

async function main(/** @type {string[]} */ argv) {
  const check = argv.includes('--check');
  const outArg = argv.indexOf('--out');
  const result = await measure();
  if (!check) {
    const out =
      outArg >= 0
        ? path.resolve(argv[outArg + 1] ?? '')
        : path.join(metricsDir, `baseline-${result.measuredAt}.json`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${path.relative(root, out)}`);
    return 0;
  }
  const file = latestCommitted();
  if (!file) {
    console.error('no docs/metrics/baseline-*.json committed');
    return 1;
  }
  const rel = path.relative(root, file);
  let committed;
  try {
    committed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`${rel} is not valid JSON: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  const problems = validateBaseline(committed);
  if (problems.length > 0) {
    console.error(`${rel} is malformed: ${problems.join('; ')}`);
    return 1;
  }
  const before = flatten(committed);
  const after = flatten(result);
  const drift = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  console.log(
    `${rel} is well-formed; ${drift.length} metric(s) differ from the tree (informational)`,
  );
  for (const k of drift) console.log(`  ${k}: ${before[k]} -> ${after[k]}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
