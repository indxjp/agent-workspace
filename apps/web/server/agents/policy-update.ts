/**
 * The `GET`/`PUT /api/agents/:id/policy` use cases (S-13; moved out of the route by W2-4, F-05):
 * read an agent's effective policy, and update it through the engine-switch carry, the skill
 * allowlist, the engine capability check, the deployment ceiling and a console-edit version.
 */
import { applicationContext } from '../application-context';
import type { AgentPolicy, BuiltinAgentOperation } from '../../contracts/agents';
import { agentNotFound, refuseBuiltinWriteFor } from './handlers';
import { problem, type ApiResult } from '../http/result';
import { isUuid } from './contract';
import { readAgentIdParam, readJsonBody, withWorkspaceStore } from './http';
import {
  assignedEnabledSkillNames,
  assignedSkillNames,
  carryEngineSwitch,
  demandsConnectors,
  demandsSkills,
  engineCapabilityRefusal,
  firstUnassignedSkillName,
  parsePolicyBody,
  policyFor,
  policySourceOf,
} from './policy';
import { policyConnectorNames, saveConsoleEdit } from '../agent-versions/http';
import { judgeAgent } from '../policy-ceiling/ceiling';
import { requireResourceAccess } from '../resources/authorise';
import type { OwnershipResolver } from '../rbac/http';

/**
 * Who may read or update the policy. Follows `app/api/agents/[id]/resources/route.ts`'s shape: the
 * ownership resolver loads the agent within the caller's workspace and answers an indistinguishable
 * 404 for a foreign or malformed id before `decide()` ever compares `created_by` against the
 * caller — see that file's own comment on why this is a bare {@link OwnershipResolver} rather than
 * `resources/item-ownership.ts`'s `resolverForRow`.
 */
function ownershipOf(id: unknown, operation: BuiltinAgentOperation): OwnershipResolver {
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

/** The display-only `connectorNames` field of the response, or nothing when it would be empty. */
async function withConnectorNames(
  workspaceId: string,
  policy: AgentPolicy,
): Promise<{ connectorNames?: Record<string, string> }> {
  const connectorNames = await policyConnectorNames(workspaceId, policy);
  return Object.keys(connectorNames).length === 0 ? {} : { connectorNames };
}

/** `GET /api/agents/:id/policy` — the agent's effective policy and where it came from. */
export async function getAgentPolicy(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<ApiResult | Response> {
  const id = await readAgentIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id, 'read'));
  if (!access.ok) return access.response;
  return withWorkspaceStore(
    request,
    async (store, installed, workspaceId) => {
      if (typeof id !== 'string')
        return problem(400, 'invalid_agent_id', 'The agent id is missing.');
      if (installed.agentResources === undefined || installed.skillCatalog === undefined) {
        return problem(
          503,
          'agent_policy_not_configured',
          'Agent policy is not configured for this deployment.',
        );
      }
      const agent = await store.get(id);
      if (agent === null) return agentNotFound();
      const skillNames = await assignedEnabledSkillNames(
        workspaceId,
        id,
        installed.agentResources,
        installed.skillCatalog,
      );
      const policy = policyFor(agent, skillNames);
      return {
        status: 200,
        body: {
          policy,
          source: policySourceOf(agent),
          ...(await withConnectorNames(workspaceId, policy)),
        },
      };
    },
    access.principal.workspaceId,
  );
}

/**
 * `PUT /api/agents/:id/policy` — replace the agent's policy. Every check decides against the policy
 * carried across an engine switch; the write is a console-edit version (`via: 'ui'`).
 */
export async function updateAgentPolicy(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<ApiResult | Response> {
  const id = await readAgentIdParam(context);
  const access = await requireResourceAccess(request, ownershipOf(id, 'update-policy'));
  if (!access.ok) return access.response;
  return withWorkspaceStore(
    request,
    async (store, installed, workspaceId) => {
      if (typeof id !== 'string')
        return problem(400, 'invalid_agent_id', 'The agent id is missing.');
      if (installed.agentResources === undefined || installed.skillCatalog === undefined) {
        return problem(
          503,
          'agent_policy_not_configured',
          'Agent policy is not configured for this deployment.',
        );
      }
      const parsedBody = await readJsonBody(request);
      if (!parsedBody.ok) return parsedBody.result;
      const parsed = parsePolicyBody(parsedBody.value);
      if (!parsed.ok) return parsed.result;

      // ADR-0074 D12: a switch of engine carries the stored arm's narrowing into the new arm, or is
      // refused when it cannot; every check below decides against the carried policy.
      const current = await store.get(id);
      if (current === null) return agentNotFound();
      let carried = carryEngineSwitch(current.policy, parsed.policy);
      // The names only label a refusal's message, so they are read only for one.
      if (!carried.ok && current.policy !== null) {
        carried = carryEngineSwitch(
          current.policy,
          parsed.policy,
          await policyConnectorNames(workspaceId, current.policy),
        );
      }
      if (!carried.ok) return carried.result;
      const policy = carried.policy;

      // One read of the assignment row, so the allowlist check and the capability check below
      // decide against the same assignments.
      const assignments = await installed.agentResources.forWorkspace(workspaceId).get(id);
      const assigned = await assignedSkillNames(workspaceId, assignments, installed.skillCatalog);
      const unassigned = firstUnassignedSkillName(policy, assigned);
      if (unassigned !== null) {
        return problem(
          409,
          'skill_not_assigned',
          `The policy allowlists the skill ${JSON.stringify(unassigned)}, which this agent has no assignment for.`,
        );
      }

      // ADR-0065 D3: the engine is registered and the body is well formed, and this agent's
      // assignments are still something this engine cannot honour. Checked after the allowlist
      // above, so the skill demand below is one the agent really has.
      const unsupported = engineCapabilityRefusal(policy.engine, {
        connectors: demandsConnectors(assignments),
        skills: demandsSkills(policy, assigned),
      });
      if (unsupported !== null) return unsupported;

      // Issue #535: the agent with the carried policy, judged against the deployment's ceiling.
      // ponytail: check-then-write race until V-2, same as SD11
      const ceiling =
        installed.ceiling.kind === 'enforced'
          ? installed.ceiling.ceilingFor(request, workspaceId)
          : null;
      const refused = await judgeAgent(
        { ...current, policy },
        assignments?.connectorIds ?? [],
        ceiling,
        { id, label: current.name },
      );
      if (refused !== null) return refused;

      // Issue #616: a console edit is saved as a version (`via: 'ui'`) and `local` points at it.
      const unsaved = await saveConsoleEdit(
        current,
        { kind: 'policy', policy },
        access.principal,
        ceiling,
      );
      if (unsaved !== null) return unsaved;
      const saved = await store.get(id);
      if (saved === null) return agentNotFound();
      const savedPolicy = saved.policy ?? policy;
      return {
        status: 200,
        body: {
          policy: savedPolicy,
          source: 'stored',
          ...(await withConnectorNames(workspaceId, savedPolicy)),
        },
      };
    },
    access.principal.workspaceId,
  );
}
