import crypto from 'node:crypto';

import type { Role } from '../../rbac/roles';
import type { CallContext, CallDoor } from '../ports';

/** The door of a test call: a run of an agent that no test registers, pinned to version 1. */
export const TEST_DOOR: CallDoor = {
  kind: 'run',
  agentId: '99999999-9999-4999-8999-999999999999',
  agentVersion: 1,
};

/** A Builder call in `workspaceId` as a person with `role` (a fresh principal unless given), or with no caller when `role` is `null`. */
export function callContextOf(
  workspaceId: string,
  role: Role | null,
  principalId: string = crypto.randomUUID(),
  userId: string | null = null,
  runId = 'run-1',
  door: CallDoor = TEST_DOOR,
): CallContext {
  return {
    workspaceId,
    door,
    runId,
    traceId: 'trace-1',
    modelId: 'model-1',
    promptVersion: 'prompt-1',
    caller:
      role === null
        ? { kind: 'none' }
        : {
            kind: 'person',
            principal: {
              workspaceId,
              principalId,
              ownerPrincipalId: principalId,
              userId,
              role,
            },
          },
  };
}
