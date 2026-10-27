import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { BUILDER_EVAL_PASS_SCORE } from '@indx-workspace/contracts/builder';
import {
  EvaluationResourceSchema,
  type EvalCaseFile,
  type EvaluationResource,
} from '@indx-workspace/contracts/evaluations';
import { readEvalCaseFile } from '@indx-workspace/sdk/project';

const INJECTION_TAG = 'injection';

export interface BuilderEvalVerdict {
  readonly ok: boolean;
  readonly score: number;
  readonly failedInjection: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * The Builder's promotion gate (design §07) over an `aw eval` report: the score must reach
 * `BUILDER_EVAL_PASS_SCORE`, and every case tagged `injection` must have passed. The report's own
 * per-case results are the only scorer; the tag joins them to the case file by exact name.
 */
export function builderEvalVerdict(
  report: EvaluationResource,
  cases: EvalCaseFile,
): BuilderEvalVerdict {
  const score = report.passed / report.total;
  const passedByName = new Map(report.results.map((result) => [result.name, result.passed]));
  const injection = cases.cases.filter((c) => c.tags?.includes(INJECTION_TAG)).map((c) => c.name);
  const failedInjection = injection.filter((name) => passedByName.get(name) !== true);
  const reasons = [
    ...(!(score >= BUILDER_EVAL_PASS_SCORE)
      ? [`score ${score.toFixed(4)} is below the bar ${BUILDER_EVAL_PASS_SCORE}`]
      : []),
    ...(injection.length === 0 ? [`no case is tagged ${INJECTION_TAG}`] : []),
    ...failedInjection.map((name) => `injection case did not pass: ${name}`),
  ];
  return { ok: reasons.length === 0, score, failedInjection, reasons };
}

if (import.meta.main) {
  const [reportPath, casesPath = fileURLToPath(new URL('builder.yaml', import.meta.url))] =
    process.argv.slice(2);
  if (reportPath === undefined) {
    process.stderr.write('usage: node gate.ts <report.json> [builder.yaml]\n');
    process.exit(2);
  }
  const report = EvaluationResourceSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
  const verdict = builderEvalVerdict(
    report,
    readEvalCaseFile(readFileSync(casesPath, 'utf8'), casesPath),
  );
  process.stdout.write(
    `Builder evals: ${report.passed}/${report.total} passed, score ${verdict.score}\n`,
  );
  for (const reason of verdict.reasons) {
    process.stderr.write(`::error title=Builder eval gate::${reason}\n`);
  }
  process.exit(verdict.ok ? 0 : 1);
}
