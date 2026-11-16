import { applicationContext } from '../application-context';
import type { BuiltinAgentOperation } from '../../contracts/agents';
import type { OwnershipResolver } from '../identity';
import { agentNotFound, refuseBuiltinWriteFor } from './handlers';
import { isUuid } from './contract';

/**
 * Issue #117: load the agent within the caller's workspace, answer an indistinguishable 404 when
 * it is absent, and only then let `decide()` compare `created_by` against the caller. Built as a
 * bare {@link OwnershipResolver} rather than through `resources/item-ownership.ts`'s
 * `resolverForRow`: `GET`/`PUT /api/agents/:id/resources` call `requireResourceAccess` before any
 * workspace-scoped store is resolved, so the id is looked up straight from the installed agents
 * runtime once the resolver is handed the verified `principal`'s workspace. The home chat's
 * "+ Files" picker (RF-502) asks the same question, so the agent's files are listed only to a
 * caller the resources route would answer.
 */
export function agentResourcesOwnership(
  id: unknown,
  operation: BuiltinAgentOperation,
): OwnershipResolver {
  return async (principal) => {
    const runtime = applicationContext()?.agents ?? null;
    if (runtime === null || !isUuid(id)) {
      return { kind: 'refuse', result: agentNotFound() };
    }
    const row = await runtime.agents.forWorkspace(principal.workspaceId).get(id);
    if (row === null) return { kind: 'refuse', result: agentNotFound() };
    const readOnly = refuseBuiltinWriteFor(principal, row, operation);
    if (readOnly !== null) return { kind: 'refuse', result: readOnly };
    return {
      kind: 'ownership',
      ownership: principal.ownerPrincipalId === row.ownerPrincipalId ? 'own' : 'other',
    };
  };
}
