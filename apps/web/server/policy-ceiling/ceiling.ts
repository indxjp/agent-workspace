/**
 * The deployment's policy ceiling at every write path (issue #535, C14, ADR-0102 SD6): the version
 * save, its dry run and the pointer move, the legacy agent routes, a run start's `modelOverride`
 * and first-run setup each build the configuration the write would leave and call
 * {@link enforceCeiling}, which judges it with the contracts' `policyWidenings` — one rule, never a
 * copy. No caller's role is an input, so the Owner is refused like anyone else.
 *
 * Every path judges the whole configuration after the write, the rule `validateAgentVersion`
 * already applies to a pointer move: an agent saved before a ceiling was lowered is refused on its
 * next save until it fits, rather than keeping a stale over-ceiling field.
 */
import {
  policyWidenings,
  type EffectivePolicyConfiguration,
  type PolicyWidening,
  type ProjectPolicy,
} from '@indx-workspace/contracts/policy-ceiling';
import type { ModelProvider } from '@indx-workspace/contracts/runs';

import {
  AGENT_POLICY_PROBLEM_CODES,
  policyNarrowedPermissions,
  type AgentPermissions,
  type AgentPolicy,
} from '../../contracts/agents';
import { problem, type ApiResult } from '../agents/handlers';
import { engineForStoredPolicy } from '../engines/session-engine';
import type { DeploymentDefaultModels } from '../models/deployment-default';

/** What a refusal's audit row names: the agent (`null` before it exists) and a readable label. */
export interface CeilingSubject {
  readonly id: string | null;
  readonly label: string;
}

/** The ceiling, bound to one request and the workspace it acts in. */
export interface RequestCeiling {
  readonly policy: ProjectPolicy;
  /**
   * The deployment default model id (`AW_DEPLOYMENT_DEFAULT_MODELS`) for the provider of the
   * model connection `connectionId`, or `null`. Reads the connection row; never asks a provider.
   */
  deploymentDefaultModel(connectionId: string): Promise<string | null>;
  /** The names of the connectors `connectorIds` name; an id this workspace lacks has none. */
  connectorNames(connectorIds: readonly string[]): Promise<readonly string[]>;
  /** Write the refusal's §36 audit row. */
  recordRefusal(subject: CeilingSubject, widenings: readonly PolicyWidening[]): Promise<void>;
}

/** Binds the deployment's ceiling to a request; installed only when a ceiling is configured. */
export type CeilingFor = (request: Request, workspaceId: string) => RequestCeiling;

/** Who acts, as the composition root's principal identity reports it. */
export interface CeilingActor {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
  readonly label: string;
}

export interface CeilingAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: 'agent-changed';
  readonly subjectId: string | null;
  readonly subjectLabel: string;
}

export interface CeilingDependencies {
  readonly policy: ProjectPolicy;
  readonly deploymentDefaultModels: DeploymentDefaultModels;
  modelProvider(workspaceId: string, connectionId: string): Promise<ModelProvider | null>;
  connectorName(workspaceId: string, connectorId: string): Promise<string | null>;
  identifyActor(request: Request): Promise<CeilingActor | null>;
  recordAuditEvent(event: CeilingAuditEvent): Promise<void>;
}

/** Build the {@link CeilingFor} the composition root threads into every write path. */
export function createCeilingFor(dependencies: CeilingDependencies): CeilingFor {
  return (request, workspaceId) => ({
    policy: dependencies.policy,
    async deploymentDefaultModel(connectionId) {
      const provider = await dependencies.modelProvider(workspaceId, connectionId);
      return provider === null ? null : (dependencies.deploymentDefaultModels[provider] ?? null);
    },
    async connectorNames(connectorIds) {
      const names = await Promise.all(
        connectorIds.map((id) => dependencies.connectorName(workspaceId, id)),
      );
      return names.filter((name): name is string => name !== null);
    },
    async recordRefusal(subject, widenings) {
      const actor = await dependencies.identifyActor(request);
      if (actor === null) {
        throw new Error('the refused write no longer resolves to a workspace principal');
      }
      // ponytail: refusal audited as agent-changed, a dedicated action needs a core migration (core lane)
      await dependencies.recordAuditEvent({
        workspaceId: actor.workspaceId,
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.label,
        action: 'agent-changed',
        subjectId: subject.id,
        subjectLabel: `${subject.label}: refused policy_cannot_widen ${widenings.join(', ')}`,
      });
    },
  });
}

/**
 * The model id a save can judge (SD6): an explicit model, else the deployment default for the
 * connection's provider. The default is read only when the ceiling names `models` and the agent
 * names a connection; there is no discovery, so a model the S1-23 ladder would resolve at run time
 * is judged at compose (S2-04c), not here.
 */
export async function judgedModel(
  model: string | null,
  modelConnectionId: string | null,
  ceiling: RequestCeiling,
): Promise<string | null> {
  if (model !== null) return model;
  if (ceiling.policy.models === undefined || modelConnectionId === null) return null;
  return ceiling.deploymentDefaultModel(modelConnectionId);
}

/** The connector names a tools ceiling judges; nothing is read when the ceiling has no `tools`. */
export async function assignedTools(
  connectorIds: readonly string[],
  ceiling: RequestCeiling,
): Promise<readonly string[]> {
  return ceiling.policy.tools === undefined ? [] : ceiling.connectorNames(connectorIds);
}

/** The agent fields a write leaves behind, as the agent row stores them. */
export interface CeilingAgent {
  readonly permissions: AgentPermissions;
  /** The stored policy; `null` when compiled. */
  readonly policy: AgentPolicy | null;
  readonly model: string | null;
  readonly modelConnectionId: string | null;
}

/**
 * The configuration an agent row runs with: permissions after the stored arm's withholding
 * (`policyNarrowedPermissions`), the stored limits (none when compiled), the stored engine (the
 * default arm when compiled), the {@link judgedModel} and the connector names `tools`.
 */
export async function agentEffective(
  agent: CeilingAgent,
  tools: readonly string[],
  ceiling: RequestCeiling,
): Promise<EffectivePolicyConfiguration> {
  return storedEffective(
    agent,
    await judgedModel(agent.model, agent.modelConnectionId, ceiling),
    tools,
  );
}

/**
 * {@link agentEffective} once the model to judge is known: what a caller holding the raw policy
 * (first-run setup, which writes an explicit model) judges with `policyWidenings`.
 */
export function storedEffective(
  agent: Pick<CeilingAgent, 'permissions' | 'policy'>,
  model: string | null,
  tools: readonly string[],
): EffectivePolicyConfiguration {
  return {
    permissions: policyNarrowedPermissions(agent.permissions, agent.policy),
    limits: agent.policy?.limits ?? { maxTurns: null, maxBudgetUsd: null },
    engine: engineForStoredPolicy(agent.policy),
    model,
    tools,
  };
}

/**
 * The version pipeline's step 7, and every legacy write's: {@link enforceCeiling} over what the
 * agent row would be and the connector names `tools`. `null` without a ceiling, before any lookup.
 */
export async function ceilingStep(
  agent: CeilingAgent,
  tools: readonly string[],
  ceiling: RequestCeiling | null | undefined,
  audit: CeilingSubject | null,
): Promise<ApiResult | null> {
  if (ceiling === null || ceiling === undefined) return null;
  return enforceCeiling(await agentEffective(agent, tools, ceiling), ceiling, audit);
}

/** {@link ceilingStep} over the connectors `connectorIds` names: the legacy routes' one call. */
export async function judgeAgent(
  agent: CeilingAgent,
  connectorIds: readonly string[],
  ceiling: RequestCeiling | null,
  audit: CeilingSubject | null,
): Promise<ApiResult | null> {
  if (ceiling === null) return null;
  return ceilingStep(agent, await assignedTools(connectorIds, ceiling), ceiling, audit);
}

/**
 * `403 policy_cannot_widen` naming each widening in C14 order, or `null` when `effective` fits
 * (or there is no ceiling). A refusal writes one audit row unless `audit` is `null` (a dry run).
 */
export async function enforceCeiling(
  effective: EffectivePolicyConfiguration,
  ceiling: RequestCeiling | null | undefined,
  audit: CeilingSubject | null,
): Promise<ApiResult | null> {
  if (ceiling === null || ceiling === undefined) return null;
  const widenings = policyWidenings(effective, ceiling.policy);
  if (widenings.length === 0) return null;
  if (audit !== null) await ceiling.recordRefusal(audit, widenings);
  return problem(
    AGENT_POLICY_PROBLEM_CODES.policy_cannot_widen,
    'policy_cannot_widen',
    "The agent would be wider than this deployment's policy ceiling allows.",
    widenings,
  );
}
