import type { EvaluationResource } from '@indx-workspace/contracts/evaluations';

import { UsageError } from '../io.js';

/** `--min-score`: a fraction from 0 to 1, as the stored `score` is (issue #799). */
export function parseMinScore(raw: string): number {
  const parsed = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new UsageError(`--min-score must be a number from 0 to 1 (got ${JSON.stringify(raw)})`);
  }
  return parsed;
}

/** `passed / total`, not the stored `score`, which is rounded to four places. */
export function scoreOf(evaluation: EvaluationResource): number {
  return evaluation.passed / evaluation.total;
}

export interface BaselineDiff {
  readonly baseline: string;
  readonly baselineVersion: number;
  readonly baselinePassed: number;
  readonly baselineTotal: number;
  /** Cases that passed in the baseline and fail now. */
  readonly regressed: readonly string[];
  /** Cases that failed in the baseline and pass now. */
  readonly fixed: readonly string[];
  /** Cases the baseline does not have. */
  readonly added: readonly string[];
  /** Cases only the baseline has. */
  readonly removed: readonly string[];
}

/** The per-case difference of `current` from `baseline`, matched by case name (issue #799). */
export function diffAgainst(
  baseline: EvaluationResource,
  current: EvaluationResource,
): BaselineDiff {
  const before = new Map(baseline.results.map((result) => [result.name, result.passed]));
  const after = new Map(current.results.map((result) => [result.name, result.passed]));
  const names = (keep: (name: string, passed: boolean) => boolean) =>
    [...after].filter(([name, passed]) => keep(name, passed)).map(([name]) => name);
  return {
    baseline: baseline.id,
    baselineVersion: baseline.version,
    baselinePassed: baseline.passed,
    baselineTotal: baseline.total,
    regressed: names((name, passed) => !passed && before.get(name) === true),
    fixed: names((name, passed) => passed && before.get(name) === false),
    added: names((name) => !before.has(name)),
    removed: [...before.keys()].filter((name) => !after.has(name)),
  };
}

export function diffLines(diff: BaselineDiff, current: EvaluationResource): string[] {
  const rows = [
    ...diff.regressed.map((name) => `  regressed  ${name}`),
    ...diff.fixed.map((name) => `  fixed      ${name}`),
    ...diff.added.map((name) => `  added      ${name}`),
    ...diff.removed.map((name) => `  removed    ${name}`),
  ];
  return [
    `baseline ${diff.baseline} · v${String(diff.baselineVersion)} · ` +
      `${String(diff.baselinePassed)}/${String(diff.baselineTotal)} passed → ` +
      `${String(current.passed)}/${String(current.total)}`,
    ...(rows.length === 0 ? ['  no case changed'] : rows),
    '',
  ];
}

/** XML 1.0 carries no control character but tab, newline and carriage return. */
function withoutControls(text: string): string {
  return [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
    })
    .join('');
}

function escapeXml(text: string): string {
  return withoutControls(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** A JUnit report: a `testsuite` per agent, a `testcase` per case, a `failure` for each failed one. */
export function junit(
  suites: readonly { readonly name: string; readonly evaluation: EvaluationResource }[],
): string {
  const failures = suites.reduce(
    (sum, suite) => sum + suite.evaluation.total - suite.evaluation.passed,
    0,
  );
  const tests = suites.reduce((sum, suite) => sum + suite.evaluation.total, 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="aw eval" tests="${String(tests)}" failures="${String(failures)}">`,
    ...suites.flatMap(({ name, evaluation }) => [
      `  <testsuite name="${escapeXml(name)}" tests="${String(evaluation.total)}" ` +
        `failures="${String(evaluation.total - evaluation.passed)}" timestamp="${evaluation.createdAt}">`,
      ...evaluation.results.map((result) => {
        const open = `    <testcase classname="${escapeXml(name)}" name="${escapeXml(result.name)}"`;
        return result.passed
          ? `${open}/>`
          : `${open}>\n      <failure message="${escapeXml(result.failures.join('; '))}">${escapeXml(result.failures.join('\n'))}</failure>\n    </testcase>`;
      }),
      '  </testsuite>',
    ]),
    '</testsuites>',
    '',
  ].join('\n');
}
