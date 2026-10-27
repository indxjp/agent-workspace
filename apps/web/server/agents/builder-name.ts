import { builderAllows } from '@indx-workspace/contracts/policy-ceiling';

import { BUILTIN_AGENT_PROBLEM_CODES, type BuiltinAgentProblemCode } from '../../contracts/agents';
import { problem, type ApiResult } from '../http/result';
import type { RequestCeiling } from '../policy-ceiling/ceiling';
import type { Role } from '../rbac/roles';

const RESERVED_CODE = 'builder_name_reserved' satisfies BuiltinAgentProblemCode;

/**
 * `403 builder_name_reserved` when `name` is one the deployment's `builder.allow` lists and `role`
 * is neither Owner nor Admin, else `null` (#1851). A name matches exactly, as `builderAllows` does.
 */
export function builderNameRefusal(
  ceiling: Pick<RequestCeiling, 'policy'> | null | undefined,
  role: Role | undefined,
  name: string,
): ApiResult | null {
  if (role === 'owner' || role === 'admin' || !builderAllows(ceiling?.policy ?? null, name)) {
    return null;
  }
  return problem(
    BUILTIN_AGENT_PROBLEM_CODES[RESERVED_CODE],
    RESERVED_CODE,
    'This name is reserved for agents a workspace Owner or Admin creates.',
  );
}
