import type { DatabaseRoot } from '@agent-workspace/core/db';

import type { AgentArchiveStore } from './sweep';

/** The database root the sweep needs: the agents repository and the workspace scope resolver. */
export type AgentArchiveRoot = Pick<DatabaseRoot, 'agents' | 'scopes'>;

/** The archive store of one workspace, or `null` when the workspace is gone. */
export async function openAgentArchiveStore(
  root: AgentArchiveRoot,
  workspaceId: string,
): Promise<AgentArchiveStore | null> {
  const scope = await root.scopes.forWorkspaceId(workspaceId);
  return scope === null ? null : root.agents.forScope(scope);
}
