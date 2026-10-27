import { decide, type Ownership } from '../../../rbac/decide';
import type { Role } from '../../../rbac/roles';

type Caller = { readonly role: Role; readonly ownerPrincipalId: string };
type Target = { readonly id: string; readonly ownerPrincipalId: string };

/**
 * Whether `role` may make the console calls the dry run and the save stand for: `POST /api/agents`
 * for a new agent; for an existing one `POST /api/agents/:id/versions` and `PUT
 * /api/agents/:id/pointers`, owned as the console route resolves it. The save moves the `local` pointer,
 * so a role that may only add versions never gets that far.
 */
export function mayCheck(caller: Caller, agent: Target | undefined): boolean {
  return (
    may('POST', caller, agent) && (agent === undefined || may('PUT', caller, agent, 'pointers'))
  );
}

/** Whether `role` may make the console call that reads the agent's versions: `GET /api/agents/:id/versions`. */
export function mayRead(caller: Caller, agent: Target): boolean {
  return may('GET', caller, agent);
}

/** Whether `role` may make the console call that evaluates a version: `POST /api/agents/:id/evaluations`. */
export function mayEvaluate(caller: Caller, agent: Target): boolean {
  return may('POST', caller, agent, 'evaluations');
}

/** Whether `role` may make the console call that starts a run: `POST /api/agents/:id/runs`, owned as `ownershipOf` resolves it. */
export function mayRun(
  caller: { readonly role: Role },
  agent: { readonly id: string },
  ownership: Ownership,
): boolean {
  const path = `/api/agents/${agent.id}/runs`;
  return (
    decide({ role: caller.role, method: 'POST', scope: null, path, ownership }).effect === 'allow'
  );
}

function may(
  method: 'GET' | 'POST' | 'PUT',
  caller: Caller,
  agent: Target | undefined,
  sub: 'versions' | 'evaluations' | 'pointers' = 'versions',
): boolean {
  const query =
    agent === undefined
      ? { path: '/api/agents', ownership: 'not-applicable' as const }
      : {
          path: `/api/agents/${agent.id}/${sub}`,
          ownership:
            caller.ownerPrincipalId === agent.ownerPrincipalId
              ? ('own' as const)
              : ('other' as const),
        };
  return decide({ role: caller.role, method, scope: null, ...query }).effect === 'allow';
}
