import type { AgentPermissions } from '@agent-workspace/run-protocol';
import { type AgentPermissionKey } from '@indx-workspace/contracts/agents';
import { DomainError } from '../errors';
import { type AgentRunResourceLoaderDependencies } from './resource-loader-contract';

/**
 * The project's read-only file grants, or the pre-launch refusal for #125's narrowing rule.
 *
 * `project_files` is a bare id list (ADR: `W9-PLAN-project-file-grants-are-read-only-in-wave-9`),
 * so every id it names becomes a `'read'` grant — never `'read-write'`, structurally, because
 * nothing here ever produces that value for a project-sourced id. Grants are returned **ahead of**
 * the agent's own in the array `loadFiles` merges: that function already applies the shallowest
 * grant first and lets a deeper, more specific grant repaint its own subtree (see its own tests),
 * so putting the project's grants first and the agent's own after — unchanged — makes the agent's
 * own explicit assignment win whenever it names the same id or a deeper path, and lets the
 * project's grant win a subtree the agent only reaches through a shallower grant of its own. That
 * is #125's "agent wins for the same file id, the more restrictive mode wins for the same path"
 * in one existing algorithm, not a second one.
 *
 * The ceiling is `agentPermissions.readFiles`: a project cannot hand an agent file access its own
 * tool permissions do not include, so any project file association is refused outright (not
 * silently dropped — see the loader's own doc comment) when that permission is off.
 */
async function loadProjectFileGrants(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly { readonly fileId: string; readonly access: 'read' }[]> {
  if (dependencies.projectResources === undefined) return [];
  const fileIds = await dependencies.projectResources.listFileIds(workspaceId, projectId);
  if (fileIds.length === 0) return [];
  if (agentPermissions?.readFiles !== true) {
    if (ceilingCaps.includes('readFiles')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(fileIds.length)} file(s)/folder(s)`,
        'readFiles',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(fileIds.length)} file(s)/folder(s), but the ` +
        'agent running this session does not have the readFiles tool permission — a project ' +
        "association can only narrow an agent's own permissions, never widen them.",
    );
  }
  return fileIds.map((fileId) => ({ fileId, access: 'read' as const }));
}

/** The refusal of a project resource whose switch the deployment's policy ceiling turned off. */
function ceilingCappedProjectResource(
  projectId: string,
  associates: string,
  key: AgentPermissionKey,
): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'policy_cannot_widen',
    publicMessage:
      `policy_cannot_widen: project ${projectId} associates ${associates}, but this deployment's ` +
      `policy ceiling caps permissions.${key}. Remove the association from the project, or ask ` +
      'an administrator to raise the ceiling.',
  });
}

/**
 * The project's connector ids, or the pre-launch refusal for #125's narrowing rule.
 *
 * The ceiling is `agentPermissions.unrestrictedNetwork` — an MCP connector is a network egress,
 * and #125 asks that "a project connector whose credential the agent is not authorised for is
 * dropped and reported as a pre-launch error"; this codebase has no per-agent, per-connector
 * authorisation narrower than that tool permission, so that is the check. Whether the resulting
 * connector is actually usable (enabled, has a resolvable credential) is `loadConnectors`'s own,
 * unchanged, check — applied identically to a project-sourced id and an agent-assigned one.
 */
async function loadProjectConnectorIds(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly string[]> {
  if (dependencies.projectResources === undefined) return [];
  const connectorIds = await dependencies.projectResources.listMcpServerIds(workspaceId, projectId);
  if (connectorIds.length === 0) return [];
  if (agentPermissions?.unrestrictedNetwork !== true) {
    if (ceilingCaps.includes('unrestrictedNetwork')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(connectorIds.length)} connector(s)`,
        'unrestrictedNetwork',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(connectorIds.length)} connector(s), but the ` +
        'agent running this session does not have the unrestrictedNetwork tool permission, so ' +
        "it is not authorised for those connectors' credentials.",
    );
  }
  return connectorIds;
}
export { loadProjectFileGrants, loadProjectConnectorIds };
