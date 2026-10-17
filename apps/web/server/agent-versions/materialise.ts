/**
 * What a version becomes when an environment runs it (S1-06, issue #444; ADR-0101): the agent row's
 * settable columns and its assignments, in the shape core's `applyAndPoint` and
 * `createAgentWithFirstVersion` write in one transaction.
 *
 * - `name`, `instructions`, `model` and `permissions` come from `definition.agent`.
 * - `policy` is the pipeline's `policyToStore` for a stored policy — carried across an engine
 *   switch against the agent as it is now — and `null` for a compiled one, the column value that
 *   means "compile from the permissions and the assignments".
 * - `references` are the ids the pipeline resolved a moment ago. The #133 write ceiling is core's
 *   (`writeAssignments` narrows a `read-write` grant on an agent without `writeFiles`).
 *
 * A model connection and a runtime profile travel by name in the definition and by id here: the
 * resolution is the only place a name becomes an id.
 */
import type { MaterialisedAgent, ResolvedReferences } from '@agent-workspace/core/db';
import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { AgentDefinition } from '@indx-workspace/contracts/agents';

import type { AgentPolicy } from '../../contracts/agents';
import { toStoredPolicy } from '../agents/store';

/** The agent `definition` materialises to, with the pipeline's resolved ids and carried policy. */
export function materialise(
  definition: AgentDefinition,
  references: ResolvedReferences,
  policyToStore: AgentPolicy | null,
): MaterialisedAgent {
  return {
    name: definition.agent.name,
    instructions: definition.agent.instructions,
    model: definition.agent.model,
    permissions: { ...definition.agent.permissions },
    policy:
      definition.policySource === 'stored' && policyToStore !== null
        ? toStoredPolicy(policyToStore)
        : null,
    references,
  };
}

/**
 * The body a save stores: the authored body with `definition.policy` replaced by the policy the
 * pipeline carried across an engine switch, so the immutable version keeps every denial the owner
 * set. A compiled policy carries nothing and the body is stored as authored. Shared by a version
 * save (S1-05) and a create-from-version (S1-06).
 */
export function bodyToStore(
  body: AgentVersionBody,
  policyToStore: AgentPolicy | null,
): AgentVersionBody {
  return policyToStore === null
    ? body
    : { ...body, definition: { ...body.definition, policy: policyToStore } };
}
