/* global console */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import prettier from 'prettier';

import { renderDriverMatrix } from '../../tests/driver-matrix/renderer.mjs';
import { renderCompatibilityMatrixWithScenarios } from '../../tests/providers/renderer.mjs';

const root = new URL('../../', import.meta.url);
const paths = {
  providerDocument: new URL('docs/compatibility/providers.md', root),
  runtimeDocument: new URL('docs/runtime-driver-matrix.md', root),
  matrixCheck: new URL('docs/compatibility/matrix-check.md', root),
  unverified: new URL('docs/compatibility/unverified.json', root),
  notDerivable: new URL('docs/compatibility/not-derivable.json', root),
};

/** @typedef {{ id: string, default: string, basis: string, overrides?: Record<string, string> }} ProviderEntry */

/** @param {string} spec */
function providerScenarios(spec) {
  const sectionStart = spec.search(/^# 41\.\s/mu);
  const section = spec.slice(sectionStart, spec.indexOf('\n# 42.', sectionStart));
  const fences = [...section.matchAll(/```text\s*\r?\n([\s\S]*?)```/gu)];
  if (fences.length < 2)
    throw new Error('spec §41 required and optional scenario fences are missing');
  const normalize = (/** @type {string} */ value) =>
    value.replace(/^✓\s*/u, '').trim().replaceAll(' ', '-');
  return fences
    .slice(0, 2)
    .flatMap((match) => (match[1] ?? '').trim().split(/\r?\n/u).map(normalize));
}

function trackedDocuments() {
  return execFileSync(
    'git',
    ['ls-files', 'docs/compatibility/providers.md', 'docs/runtime-driver-matrix.md'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean);
}

/**
 * Validates the parsed classification JSON, which is untyped until these checks pass.
 * @param {any[]} unverified @param {any[]} notDerivable
 */
function validateClassifications(unverified, notDerivable) {
  const cells = (/** @type {any} */ entry) => {
    if (!Array.isArray(entry.columns) || !Array.isArray(entry.rows)) {
      throw new Error(`classification in ${entry.matrix} lacks columns or rows`);
    }
    return entry.columns.flatMap((/** @type {unknown} */ column) =>
      entry.rows.map((/** @type {unknown} */ row) => `${entry.matrix}:${column}:${row}`),
    );
  };
  const leftList = unverified.flatMap(cells);
  const rightList = notDerivable.flatMap(cells);
  const left = new Set(leftList);
  const right = new Set(rightList);
  if (left.size !== leftList.length || right.size !== rightList.length) {
    throw new Error('a compatibility classification is duplicated');
  }
  const overlap = [...left].filter((entry) => right.has(entry));
  if (overlap.length > 0) throw new Error(`cells classified twice: ${overlap.join(', ')}`);
  for (const entry of unverified) {
    for (const field of ['missingResource', 'command', 'output', 'achievedWithoutIt']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        throw new Error(`unverified classification in ${entry.matrix} lacks ${field}`);
      }
    }
  }
  for (const entry of notDerivable) {
    if (entry.cause !== 'no-scenario' && entry.cause !== 'out-of-scope') {
      throw new Error(`not-derivable classification in ${entry.matrix} has no valid cause`);
    }
    if (entry.cause === 'out-of-scope' && (!entry.decision || !entry.default)) {
      throw new Error(
        `out-of-scope classification in ${entry.matrix} lacks its decision and default`,
      );
    }
    if ('missingResource' in entry || 'command' in entry) {
      throw new Error(
        `not-derivable classification in ${entry.matrix} invents a missing resource or command`,
      );
    }
  }
  return { unverifiedCells: left.size, notDerivableCells: right.size };
}

const tracked = trackedDocuments();
for (const required of ['docs/compatibility/providers.md', 'docs/runtime-driver-matrix.md']) {
  if (!tracked.includes(required)) {
    throw new Error(
      `required owning-wave document is not tracked: ${required}; git ls-files printed ${tracked.join(', ')}`,
    );
  }
}

const [providerInput, driverResults, spec, unverified, notDerivable] = await Promise.all([
  readFile(new URL('./providers.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../../tests/driver-matrix/results.json', import.meta.url), 'utf8').then(
    JSON.parse,
  ),
  readFile(new URL('../../docs/spec.md', import.meta.url), 'utf8'),
  readFile(paths.unverified, 'utf8').then(JSON.parse),
  readFile(paths.notDerivable, 'utf8').then(JSON.parse),
]);
const classificationCounts = validateClassifications(unverified, notDerivable);

const scenarios = providerScenarios(spec);
const reports = providerInput.providers.map((/** @type {ProviderEntry} */ provider) => ({
  providerId: provider.id,
  ok: provider.default !== 'failed',
  outcomes: scenarios.map((id) => ({
    id,
    verdict: provider.overrides?.[id] ?? provider.default,
    detail: provider.basis,
  })),
}));
const providerBase = renderCompatibilityMatrixWithScenarios(reports, scenarios);
const providerExpected = await prettier.format(
  `${providerBase}\nFixture basis:\n\n${providerInput.providers.map((/** @type {ProviderEntry} */ provider) => `- ${provider.id}: ${provider.basis}.`).join('\n')}\n`,
  { parser: 'markdown' },
);
const runtimeExpected = await renderDriverMatrix(spec, driverResults);
const [providerActual, runtimeActual] = await Promise.all([
  readFile(paths.providerDocument, 'utf8'),
  readFile(paths.runtimeDocument, 'utf8'),
]);
const providerMatches = providerActual === providerExpected;
const runtimeMatches = runtimeActual === runtimeExpected;
const summary = `# Compatibility matrix check\n\n- Provider matrix: ${providerMatches ? 'matches its W4 renderer' : 'DIFFERS from its W4 renderer'}\n- Runtime matrix: ${runtimeMatches ? 'matches its W6 renderer' : 'DIFFERS from its W6 renderer'}\n- Unverified cells: ${String(classificationCounts.unverifiedCells)}\n- Not-derivable cells: ${String(classificationCounts.notDerivableCells)}\n`;

if (process.argv.includes('--check')) {
  if (!providerMatches || !runtimeMatches) {
    console.error(summary);
    process.exit(1);
  }
  console.log(summary.trim());
} else {
  await writeFile(paths.providerDocument, providerExpected, 'utf8');
  await writeFile(
    paths.matrixCheck,
    summary.replace('DIFFERS from', 'will match after regeneration by'),
    'utf8',
  );
  console.log(
    'wrote the provider matrix and the cross-wave matrix check; the A.10 document was not written',
  );
}
