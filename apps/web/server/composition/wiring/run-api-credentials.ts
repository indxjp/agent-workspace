import type { RunPrincipal } from '../../runs/environment';
import type { RunReadEnvironment } from '../../runs/environment';
import { signalLiveRun } from '../../runs/interrupt';
import type { RunApiWiring, RevokeRunTokens } from './run-api';
export function wireRunCredentials(
  wired: Pick<RunApiWiring, 'root' | 'scopes' | 'runs' | 'runnerManagerFetch'>,
  revokeAllRunTokensFor: RevokeRunTokens,
): Pick<RunReadEnvironment, 'revokeRunTokens' | 'interruptRun'> {
  const { root, scopes, runs, runnerManagerFetch } = wired;
  return {
    revokeRunTokens: async (principal, runId, tokenId) => {
      if (tokenId === null) return revokeAllRunTokensFor(principal, runId);
      const scope = await scopes.forWorkspaceId(principal.workspaceId);
      if (scope === null) return { revoked: 0, outcome: 'not-found' };
      const repository = root.runTokens.forScope(scope);
      const outcome = await repository.revoke(tokenId, runId);
      return { revoked: outcome === 'revoked' ? 1 : 0, outcome };
    },

    // Issue #235 (S-14): the control-plane transition is the security boundary (this file's own
    // `docs/adr/SDK-03-RUN-235-an-interrupt-is-a-control-plane-transition.md`) — write the
    // terminal `cancelled` status and revoke this run's tokens BEFORE the best-effort runtime
    // signal, so a caller never sees success for a run whose credential is still live. Ordered the
    // same way `launcher.ts`'s own credential-lifetime timer already reads it.
    interruptRun: async (principal, run) => {
      await runs.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
      await revokeAllRunTokensFor(principal, run.id);
      await signalLiveRun(run.id, runnerManagerFetch);
    },
  };
}

export function createRunTokenRevoker({
  root,
  scopes,
}: Pick<RunApiWiring, 'root' | 'scopes'>): RevokeRunTokens {
  return async (
    principal: RunPrincipal,
    runId: string,
  ): Promise<{ readonly revoked: number; readonly outcome: string }> => {
    const scope = await scopes.forWorkspaceId(principal.workspaceId);
    if (scope === null) return { revoked: 0, outcome: 'not-found' };
    const repository = root.runTokens.forScope(scope);
    const revoked = await repository.revokeForRun(runId);
    await root.browserTokens.forScope(scope).revokeForRun(runId);
    return { revoked, outcome: revoked > 0 ? 'revoked' : 'already-revoked' };
  };
}
