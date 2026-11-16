import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import { createMemberCallerVerifier } from '../../agent-teams/member-tools';
import type { AgentTeamsRuntime } from '../../agent-teams/runtime';
import { createRepositoryAgentTeamsRuntime } from '../../agent-teams/store';
import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { DirectoryRoot } from '../../rbac/directory';

type StoreRoot = Parameters<typeof createRepositoryAgentTeamsRuntime>[0];
type Scope = NonNullable<Awaited<ReturnType<StoreRoot['scopes']['forWorkspaceId']>>>;

/**
 * Build the agent-team routes' runtime (ADR-0104 acceptance, issues #1516 and #1517). `root` is
 * typed by the store adapter, the one agent-team file that may name `core/db` (F-15). The member
 * endpoint also verifies the lead run's token, so it needs `GATEWAY_TOKEN_SECRET` and the
 * directory the token's caller is read from; without the secret it verifies nothing.
 */
export function wireAgentTeams(
  root: StoreRoot & RunTokenDatabase<Scope>,
  members: {
    readonly tokenSecret: string | null;
    readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  },
): AgentTeamsRuntime {
  return {
    ...createRepositoryAgentTeamsRuntime(root),
    verifyMemberCaller: createMemberCallerVerifier(
      members.tokenSecret === null
        ? null
        : {
            tokens: createRunTokenCodec({ secret: members.tokenSecret }),
            database: root,
            directory: members.directory,
          },
    ),
  };
}
