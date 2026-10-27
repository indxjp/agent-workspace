import { BUILDER_CHECK_FIXES, BUILDER_REFUSAL_CODES } from '@indx-workspace/contracts/builder';

import type { CheckResult } from '../../ports';

type Failed = Extract<CheckResult, { ok: false }>;

/** A failed check with the model-facing hint for its code; the code itself is the pipeline's, never renamed. */
export function failedCheck(code: string, message: string, details: readonly string[]): Failed {
  const fix =
    code === 'agent_definition_references_missing'
      ? BUILDER_CHECK_FIXES.missingReferences
      : BUILDER_CHECK_FIXES.default;
  return { ok: false, code, message, details, fix };
}

/** There is no principal to check as, and a system principal is never used instead. */
export const NO_CALLER: Failed = {
  ok: false,
  code: 'no_caller',
  message: 'This run has no person behind it, so a draft cannot be checked.',
  details: [],
  fix: BUILDER_REFUSAL_CODES.no_caller.fix,
};

/**
 * The lineage the store was handed is not one it may write, so nothing is written. The only part
 * that can be wrong is a run id over 128 characters, a broken server invariant: the internal-error
 * refusal, with nothing the caller could fix.
 */
export const LINEAGE_REFUSED: Failed = {
  ok: false,
  code: 'internal_error',
  message: 'The tool failed. Try again or stop.',
  details: [],
  fix: 'This is a server fault the draft cannot fix; stop and tell the person.',
};

/** The workspace's daily creation quota is spent; the answer is the Builder's own refusal, not a pipeline check. */
export const QUOTA_EXCEEDED: Failed = {
  ok: false,
  code: 'quota_exceeded',
  message: BUILDER_REFUSAL_CODES.quota_exceeded.fix,
  details: [],
  fix: BUILDER_REFUSAL_CODES.quota_exceeded.fix,
};

/** RBAC refuses the console call the dry run stands for, so the pipeline is never reached. */
export const FORBIDDEN: Failed = {
  ok: false,
  code: 'forbidden',
  message: 'The person may not change this agent, so a draft of it cannot be checked.',
  details: [],
  fix: BUILDER_REFUSAL_CODES.forbidden.fix,
};
