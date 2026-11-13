/**
 * The PostgreSQL-backed {@link AgentTeamsRuntime} (ADR-0104 acceptance, issue #1516): the core
 * agent-team repository scoped to one workspace, and the audit trail. The one agent-team file that
 * names `@agent-workspace/core/db` (F-15).
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';

import type { AgentTeamsRuntime } from './runtime';

type StoreRoot = Pick<DatabaseRoot, 'scopes' | 'agentTeams' | 'recordAuditEvent'>;

export function createRepositoryAgentTeamsRuntime(root: StoreRoot): AgentTeamsRuntime {
  return {
    async repository(workspaceId) {
      const scope = await root.scopes.forWorkspaceId(workspaceId);
      // `authorise` verified the caller is a member of this workspace, so it exists.
      if (scope === null) throw new Error('the agent-team workspace no longer exists');
      return root.agentTeams.forScope(scope);
    },
    recordAudit: (event) => root.recordAuditEvent(event),
  };
}
