import { log } from '../../telemetry/logger';
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { isStoppedRunStatus } from '@indx-workspace/contracts/runs';

import { mintBrowserToken } from '../../rbac/browser-token';
import { createSurfaceSessionsRuntime } from '../../surfaces/public/composition';
import type { SurfaceSessionsRuntime } from '../../surfaces/public/runtime';
import type { TokensRuntime } from '../../tokens/runtime';
import type { AgentsWiring } from './agents';
import type { RunRuntimeWiring } from './run-runtime';

/** Build `POST /api/tokens`'s runtime; the root installs it as `ApplicationContext.tokens`. */
export function createTokensRuntime({
  root,
  scopes,
  sessionRows,
}: Pick<AgentsWiring, 'scopes' | 'sessionRows'> & {
  readonly root: DatabaseRoot;
}): TokensRuntime {
  // Issue #236 (SDK-04, S-1): `POST /api/tokens`'s runtime, sharing the same scope resolver and
  // session repository the run API above already closes over. `findTarget`'s run branch reads the
  // run's *session* for ownership, exactly as `ownsRun` above does — a run itself carries no
  // `ownerPrincipalId` (`packages/core/src/db/schema/runs.ts`'s own header explains why).
  const tokens: TokensRuntime = {
    findTarget: async (principal, scope) => {
      const dbScope = await scopes.forWorkspaceId(principal.workspaceId);
      if (dbScope === null) return { kind: 'not-found' };
      if (scope.kind === 'run') {
        const run = await root.runs.forScope(dbScope).get(scope.id);
        if (run === null) return { kind: 'not-found' };
        const session = await sessionRows.forScope(dbScope).get(run.sessionId);
        if (session === null) return { kind: 'not-found' };
        return { kind: 'found', ownerPrincipalId: session.ownerPrincipalId };
      }
      const session = await sessionRows.forScope(dbScope).get(scope.id);
      if (session === null) return { kind: 'not-found' };
      return { kind: 'found', ownerPrincipalId: session.ownerPrincipalId };
    },
    issue: async (principal, scope, ttlSeconds) => {
      const dbScope = await scopes.forWorkspaceId(principal.workspaceId);
      if (dbScope === null) return null;
      // Re-checked rather than assumed from the ownership resolver's earlier read: the row may
      // have been deleted between that check and this write, and the two calls do not share a
      // transaction.
      //
      // A target that has already stopped (terminal, or paused at `awaiting_approval`: ADR-0145 D1,
      // no token stays valid while a person decides) is refused here too. `§3.1`'s
      // revocation conditions make `resolveBrowserTokenActor` (`session-rbac.ts`) reject a
      // terminal run and an archived session on the token's very first use, and the plaintext is
      // shown exactly once — so a `201` there would hand the caller an unusable credential it can
      // never mint again. `null` is the only refusal this seam's contract carries, which makes the
      // answer the route's indistinguishable `404 run_not_found` / `404 session_not_found`: the
      // same one a target deleted a moment earlier gives, and for the same reason.
      if (scope.kind === 'run') {
        const run = await root.runs.forScope(dbScope).get(scope.id);
        if (run === null || isStoppedRunStatus(run.status)) return null;
      } else {
        const session = await sessionRows.forScope(dbScope).get(scope.id);
        if (session === null || session.status === 'archived') return null;
      }
      const minted = await mintBrowserToken();
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      await root.browserTokens.forScope(dbScope).issue({
        id: crypto.randomUUID(),
        mintedByPrincipalId: principal.principalId,
        scope,
        tokenHash: minted.tokenHash,
        expiresAt,
      });
      return { token: minted.presented, expiresAt };
    },
  };
  log.info('[compose] tokens API installed: PostgreSQL browser tokens');
  return tokens;
}

/** Build the public surfaces' session bootstrap; the root installs it as `ApplicationContext.surfaces`. */
export function wireSurfaces({
  root,
  tokens,
  scopes,
  agents,
  sessionRows,
  runGate,
  preflightAgainst,
  runStartPreflight,
}: Pick<AgentsWiring, 'scopes' | 'agents' | 'sessionRows' | 'runGate'> &
  Pick<RunRuntimeWiring, 'preflightAgainst' | 'runStartPreflight'> & {
    readonly root: DatabaseRoot;
    readonly tokens: TokensRuntime;
  }): SurfaceSessionsRuntime {
  // S1-17 (#455): the hosted surface page's local session bootstrap, over the same seams.
  return createSurfaceSessionsRuntime({
    env: () => process.env,
    scopes,
    agentVersions: root.agentVersions,
    agents,
    principalById: (workspaceId, principalId) =>
      root.directory.principalById(workspaceId, principalId),
    sessions: sessionRows,
    surfaceSessionKeys: root.surfaceSessionKeys,
    runGate,
    preflight: (publisher, agent, sessionId, versionId) =>
      sessionId === null
        ? preflightAgainst(publisher, agent, null, null, versionId)
        : runStartPreflight(publisher, agent, sessionId, null),
    tokens: () => tokens,
  });
}
