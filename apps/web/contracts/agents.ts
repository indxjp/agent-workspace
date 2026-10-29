/**
 * The agent wire contract now lives in `@indx-workspace/contracts/agents`, the package the SDK and
 * every external consumer validate against. This module is the application's import seam: browser
 * and server code keep importing `contracts/agents` while the canonical schema moves out, so the
 * migration is one file at a time rather than a flag day (`docs/sdk/03-sdk-design.md`).
 */
export {
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_MODEL_MAX_LENGTH,
  AGENT_MUTABLE_FIELDS,
  AGENT_NAME_MAX_LENGTH,
  AGENT_PERMISSION_KEYS,
  AGENT_POLICY_PROBLEM_CODES,
  AGENT_TOOL_PERMISSION_MODES,
  AgentGrantsSchema,
  AgentListResponseSchema,
  AgentPermissionsSchema,
  AgentPolicyLimitsSchema,
  AgentPolicyResponseSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsResponseSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
  AgentSkillPolicySchema,
  AgentToolPermissionModeSchema,
  AgentToolPolicySchema,
  agentRequestIssueMessages,
  BUILTIN_AGENT_PROBLEM_CODES,
  type BuiltinAgentProblemCode,
  claudeBaseToolPolicyFor,
  CreateAgentInputSchema,
  CreateAgentWithAssignmentsResponseSchema,
  DenyingToolRuleSchema,
  GrantingToolRuleSchema,
  policyNarrowedPermissions,
  translatePolicyForEngineSwitch,
  UpdateAgentPatchSchema,
  type AgentPermissionKey,
  type AgentGrants,
  type AgentPermissions,
  type AgentPolicy,
  type AgentPolicyLimits,
  type AgentPolicyProblemCode,
  type AgentPolicyResponse,
  type AgentPolicySource,
  type AgentResource,
  type BuiltinAgentOperation,
  type AgentResourceAssignments,
  type AgentResourceAssignmentsInput,
  type AgentSkillPolicy,
  type AgentToolPermissionMode,
  type AgentToolPolicy,
  type CreateAgentInput,
  type CreateAgentOptions,
  type CreateAgentWithAssignmentsResponse,
  type EngineSwitchTranslation,
  type UpdateAgentPatch,
} from '@indx-workspace/contracts/agents';

/**
 * What the signed-in viewer may do with `POST /api/agents/:id/restore`, decided on the server by the
 * same `decide()` table the route consults and handed to the console as a prop (issue #184: no role
 * table in the browser). Split by ownership because the route is: a Builder restores an agent they
 * own and not another's. `viewerPrincipalId` is `null`, with both grants `false`, when the caller
 * could not be resolved.
 */
export interface AgentRestoreCapability {
  readonly canRestoreOwn: boolean;
  readonly canRestoreOther: boolean;
  readonly viewerPrincipalId: string | null;
}
