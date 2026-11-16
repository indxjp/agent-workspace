import { isStoppedRunStatus } from '@indx-workspace/contracts/runs';
import type { TokenScope } from '../rbac/core/token-scope';
import type { PrincipalResolution, RbacActorDependencies } from './session-rbac';

/**
 * The scope an OAuth access token carries, by its client's kind. A kind this switch does not name
 * fails the build, and an `a2a-agent` client with no agent fails closed rather than widening.
 */
function oauthTokenScope(
  row: Pick<
    NonNullable<Awaited<ReturnType<RbacActorDependencies['root']['findOAuthAccessTokenByHash']>>>,
    'clientKind' | 'clientId' | 'agentId' | 'agentIds'
  >,
): TokenScope | null {
  switch (row.clientKind) {
    case 'a2a-agent':
      return row.agentId === null ? null : { kind: 'a2a-agent', id: row.agentId };
    case 'mcp-project':
      return { kind: 'mcp-project', id: row.clientId };
    case 'builder':
      return { kind: 'builder', id: row.clientId };
    case 'app-backend':
      return row.agentIds.length === 0
        ? null
        : { kind: 'app-backend', id: row.clientId, agentIds: Object.freeze([...row.agentIds]) };
    default: {
      const unreachable: never = row.clientKind;
      throw new Error(`unhandled endpoint client kind ${String(unreachable)}`);
    }
  }
}

async function resolveBrowserTokenActor(
  token: import('../rbac/browser-token').PresentedBrowserToken,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  const { root, principalModule, browserTokenModule } = context;

  const invalid: PrincipalResolution = {
    kind: 'unauthenticated',
    reason: 'The bearer credential is invalid.',
  };
  const tokenHash = await browserTokenModule.hashBrowserTokenSecret(token.secret);
  const row = await root.findBrowserTokenByHash(tokenHash);
  if (row === null) return invalid;
  const scope = await root.scopes.forWorkspaceId(row.workspaceId);
  if (scope === null) return invalid;
  let tokenScope: import('../rbac/core/token-scope').TokenScope;
  if (row.scopeKind === 'run') {
    if (row.runId === null) throw new Error('a run-scoped browser token row has no run_id');
    const run = await root.runs.forScope(scope).get(row.runId);
    if (run === null || isStoppedRunStatus(run.status)) return invalid;
    tokenScope = { kind: 'run', id: row.runId };
  } else {
    if (row.sessionId === null) {
      throw new Error('a session-scoped browser token row has no session_id');
    }
    const session = await root.sessions.forScope(scope).get(row.sessionId);
    if (session === null || session.status === 'archived') return invalid;
    tokenScope = { kind: 'session', id: row.sessionId };
  }
  const minterRecord = await root.directory.principalById(row.workspaceId, row.mintedByPrincipalId);
  if (minterRecord === null) return invalid;
  const minter = principalModule.Principal.fromDirectoryRecord({
    principalId: row.mintedByPrincipalId,
    kind: minterRecord.kind,
    workspaceId: row.workspaceId,
    role: minterRecord.role,
    label: minterRecord.label,
    userId: minterRecord.userId,
    apiKeyId: minterRecord.apiKeyId,
    actsForPrincipalId: minterRecord.actsForPrincipalId,
  });
  return {
    kind: 'workspace',
    principal: principalModule.Principal.fromBrowserToken(minter, tokenScope),
  };
}

async function resolveCliTokenActor(
  token: import('../rbac/cli-token').PresentedCliToken,
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  const { root, principalModule, cliTokenModule } = context;

  const row = await root.cliSessions.findActiveByHash(
    await cliTokenModule.hashCliTokenSecret(token.secret),
  );
  if (row === null) {
    return { kind: 'unauthenticated', reason: 'The bearer credential is invalid.' };
  }
  const member = await root.resolveMembership(row.userEmail, row.workspaceSlug);
  if (member === null || member.userId !== row.userId) {
    return {
      kind: 'forbidden',
      reason: 'The signed-in account is not a member of the token workspace.',
    };
  }
  return {
    kind: 'workspace',
    principal: principalModule.Principal.fromUserToken(
      member.workspaceId,
      row.userEmail,
      member.role,
      {
        principalId: member.principalId,
        userId: member.userId,
        label: member.userLabel,
      },
    ),
  };
}

async function resolveOAuthActor(
  secret: string,
  route: 'agent-endpoint' | 'app-backend',
  context: RbacActorDependencies,
): Promise<PrincipalResolution> {
  const { root, keyModule, principalModule } = context;

  const invalid: PrincipalResolution = {
    kind: 'unauthenticated',
    reason: 'The bearer credential is invalid.',
  };
  const row = await root.findOAuthAccessTokenByHash(await keyModule.hashApiKeySecret(secret));
  if (row === null) return invalid;
  // ADR-0161 D9: on an app-backend route only an app-backend client's token resolves, so an
  // a2a-agent token cannot use `POST /api/agents/:id/runs` as a second way in. On an
  // agent-endpoint route an app-backend token resolves and the endpoint's audience check refuses
  // it, because its resource is never an endpoint URL.
  if (route === 'app-backend' && row.clientKind !== 'app-backend') return invalid;
  const subject = await root.directory.principalById(row.workspaceId, row.subjectPrincipalId);
  if (subject === null || subject.kind !== 'membership') return invalid;
  const member = principalModule.Principal.fromDirectoryRecord({
    principalId: row.subjectPrincipalId,
    kind: subject.kind,
    workspaceId: row.workspaceId,
    role: subject.role,
    label: subject.label,
    userId: subject.userId,
    apiKeyId: subject.apiKeyId,
    actsForPrincipalId: subject.actsForPrincipalId,
  });
  const tokenScope = oauthTokenScope(row);
  if (tokenScope === null) return invalid;
  return {
    kind: 'workspace',
    principal: principalModule.Principal.fromOAuthToken(member, tokenScope, {
      clientId: row.clientId,
      audience: row.resource,
    }),
  };
}
export { resolveBrowserTokenActor, resolveCliTokenActor, resolveOAuthActor };
