import type { AgentPermissions, PortableAgentConfig } from '@agent-workspace/run-protocol';

import { policyNarrowedPermissions } from '../../contracts/agents';
import type { AgentRecord } from '../agents/contract';
import type { RunSubagent } from '../agent-versions/session-version';
import type { AgentRunResourceSelection } from './resource-loader';

/** What {@link portableAgentConfigFor} composes over the agent record; every field is optional. */
interface PortableAgentOptions {
  readonly permissionOverride?: AgentPermissions | undefined;
  readonly projectInstructions?: string | null | undefined;
  readonly resources?: AgentRunResourceSelection | undefined;
  /**
   * issue #129: the model the run actually resolved to, which may come from any layer — not only
   * the agent's own stored default. `undefined` falls back to `agent.model` so a caller that has not
   * yet wired resolution (or a test exercising the function directly) keeps today's behaviour;
   * `null` stays `null`.
   */
  readonly model?: string | null | undefined;
  readonly subagents?: readonly RunSubagent[] | undefined;
}

/**
 * The §17 agent record as the **portable core** of a run request (#299's portable/engine-native
 * table; ENG-04b, #325).
 *
 * Until ENG-04b this function also produced §17 Step 4's SDK-facing detail — `tools`, in the Claude
 * Agent SDK's own tool vocabulary, derived here from the four permission checkboxes and from the
 * assigned connectors. It does not any more: the checkboxes *are* the portable statement, and the
 * engine's adapter maps them onto its own tool names
 * (`packages/engine-claude-agent-sdk/src/tools.ts`). What is left here is everything that means the
 * same thing on every engine.
 *
 * Three of the fields have no column behind them in this wave and are set to the narrowest value
 * that is true rather than to the widest that would work, **when `agent.policy` is NULL** — every
 * agent until a `PUT /api/agents/:id/policy` replaces it (S-13):
 *
 *   * `skills: { mode: 'allowlist', names: [] }` — **not** `{ mode: 'all' }`. "All of a set nobody
 *     has chosen" is the reading that hands a run every skill directory on the image.
 *   * `mcpServers: {}` — an agent with no connector assignment gets none.
 *   * `limits` — `maxTurns: null` means the engine's own default, which is what an agent with no
 *     configured limit has; `maxBudgetUsd: null` is no per-run cap, and §20.6.3's budgets sit
 *     above it.
 *
 * `skills` is *intersected* with the skills currently assigned to the agent, and `limits` comes from
 * the stored policy verbatim when there is one. That intersection is what keeps a stored policy
 * strictly narrowing (`docs/adr/SDK-02-AGENT-POLICY-234-stored-policy-is-a-narrowing-jsonb-column.md`):
 * a stored `{ mode: 'all' }` is composed as "every skill *currently assigned*", never as the whole
 * discoverable surface, and a stored allowlist loses any name whose assignment has since been
 * revoked. The `409 skill_not_assigned` refusal at `PUT` checks the same membership at write time;
 * this is the read-time half, so a policy that was valid when it was stored cannot go stale into a
 * widening. The *tool* half of the same rule is now enforced by the adapter, which unions the
 * permission floor into whatever the stored arm says rather than letting it replace them.
 */
export function portableAgentConfigFor(
  agent: AgentRecord,
  options: PortableAgentOptions = {},
): PortableAgentConfig {
  const {
    permissionOverride,
    projectInstructions = null,
    resources = { files: [], skills: [], mcpServers: {} },
    model = agent.model,
    subagents = [],
  } = options;
  const policy = agent.policy;
  // ADR-0074 D12: a withholding arm (`openai-agents`, `pi`, `mastra`) may withhold switches an
  // engine switch carried from the Claude arm's `tools.deny`/`permissionMode`. It only turns switches off, so it applies on top
  // of a run-level override as well as on top of the checkboxes.
  const permissions = policyNarrowedPermissions(permissionOverride ?? agent.permissions, policy);
  const limits: PortableAgentConfig['limits'] =
    policy === null ? { maxTurns: null, maxBudgetUsd: null } : { ...policy.limits };

  return {
    name: agent.name,
    instructions: composedInstructions(agent.instructions, projectInstructions),
    model,
    permissions,
    skills: composedSkills(policy, resources.skills),
    mcpServers: { ...resources.mcpServers },
    limits,
    // Only when non-empty, so a request without subagents is byte-identical to before.
    ...(subagents.length === 0 ? {} : { subagents: subagentConfigsFor(subagents, permissions) }),
  };
}

/** The stored skills policy intersected with the skills currently assigned (S-13). */
function composedSkills(
  policy: AgentRecord['policy'],
  assigned: AgentRunResourceSelection['skills'],
): PortableAgentConfig['skills'] {
  const assignedSkillNames = new Set(assigned.map((skill) => skill.name));
  return policy === null || policy.skills.mode === 'all'
    ? { mode: 'allowlist', names: [...assignedSkillNames] }
    : {
        mode: 'allowlist',
        names: policy.skills.names.filter((name) => assignedSkillNames.has(name)),
      };
}

/** The agent's instructions, with the project's appended when it has any. */
function composedInstructions(
  agentInstructions: string,
  projectInstructions: string | null,
): string {
  return projectInstructions === null || projectInstructions.length === 0
    ? agentInstructions
    : `${agentInstructions}\n\n${projectInstructions}`;
}

/** Each subagent's portable statement: its own withholding, then only ever narrower than its parent's. */
function subagentConfigsFor(
  subagents: readonly RunSubagent[],
  permissions: AgentPermissions,
): NonNullable<PortableAgentConfig['subagents']> {
  return subagents.map((sub) => {
    const own = policyNarrowedPermissions(sub.permissions, sub.policy);
    return {
      name: sub.name,
      description: sub.description,
      instructions: sub.instructions,
      model: sub.model,
      // A subagent can only narrow its parent's composed permissions.
      permissions: {
        readFiles: own.readFiles && permissions.readFiles,
        writeFiles: own.writeFiles && permissions.writeFiles,
        runCommands: own.runCommands && permissions.runCommands,
        unrestrictedNetwork: own.unrestrictedNetwork && permissions.unrestrictedNetwork,
      },
    };
  });
}
