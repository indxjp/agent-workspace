import { ApiProblemError, ContractViolationError } from '@indx-workspace/sdk';

import type { RequestProblem } from '../components/agents/model';

/** What a screen shows for one SDK call: the value, or the problem it renders. */
export type RequestOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: RequestProblem };

/**
 * A refusal as the server worded it; a contract violation as `contractReason`; anything else as a
 * transport problem that `failed` names.
 */
function requestProblem(error: unknown, failed: string, contractReason: string): RequestProblem {
  if (error instanceof ApiProblemError) {
    return error.code === 'unrecognised_error_body'
      ? {
          kind: 'transport',
          reason: `The server answered ${String(error.status)} without the usual error envelope.`,
        }
      : { kind: 'api', status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof ContractViolationError) {
    return { kind: 'transport', reason: contractReason };
  }
  return {
    kind: 'transport',
    reason: `${failed}: ${error instanceof Error ? error.message : String(error)}`,
  };
}

/** Await an SDK call into a {@link RequestOutcome}. */
export async function requestOutcome<T>(
  request: Promise<T>,
  failed: string,
  contractReason: string,
): Promise<RequestOutcome<T>> {
  try {
    return { ok: true, value: await request };
  } catch (error) {
    return { ok: false, problem: requestProblem(error, failed, contractReason) };
  }
}
