import { BUILDER_REFUSAL_CODES } from '@indx-workspace/contracts/builder';
import { EvalExpectSchema } from '@indx-workspace/contracts/evaluations';

import type { Executor } from './types';

const EXPECT_KINDS: ReadonlySet<string> = new Set(Object.keys(EvalExpectSchema.unwrap().shape));
const BARE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * One failure as a short code. A failure sentence (`contains: "..." is not in the answer`,
 * `judge: <the judge's reason>`) quotes the case's expectation or the judge model, so only its kind
 * is kept; a bare code (`deadline_exceeded`, `run_failed`) is kept as it is; anything else is `failed`.
 */
function failureCode(failure: string): string {
  const kind = failure.split(': ', 1)[0] ?? '';
  if (failure.includes(': ') && EXPECT_KINDS.has(kind)) return kind;
  return BARE_CODE.test(failure) ? failure : 'failed';
}

/**
 * Scores a saved version as the caller through the console's evaluation, one run per case, each
 * under the trial budget. The cases are the model's own, so the shell asks the person first and
 * the approval covers this one call. A case's answer is untrusted data: only names, pass/fail and
 * short codes leave this function, and nothing here logs a result.
 */
export const evalsRun: Executor<'evals_run'> = async (call, ctx, ports) => {
  const { agentId, version, cases } = call.input;
  const result = await ports.runner.evaluate(ctx, agentId, version, cases);
  if (!result.ok) {
    const { code, message } = result;
    // The route's own code is never a Builder code such as `approval_required`.
    return Object.hasOwn(BUILDER_REFUSAL_CODES, code)
      ? { ok: false, code: 'evals_refused', message }
      : { ok: false, code, message };
  }
  const { score, total, passed, results } = result.evaluation;
  return {
    ok: true,
    score,
    total,
    passed,
    failed: total - passed,
    failures: results
      .filter((entry) => !entry.passed)
      .map(({ name, failures }) => ({
        name,
        reason: [...new Set(failures.map(failureCode))].join(', ') || 'failed',
      })),
    cases: results.map(({ name, passed: ok }) => ({ name, passed: ok })),
    awCommand: 'aw eval run',
  };
};
