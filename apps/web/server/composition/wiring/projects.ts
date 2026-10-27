import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { SecretsService } from '@agent-workspace/core/secrets';

import {
  engineForStoredPolicy,
  pinSessionEngine,
  sessionEngineMismatchMessage,
} from '../../engines/session-engine';
import { createProjectRunGate, guardProjectSessionCreation } from '../../projects/archive-gate';
import type { ProjectsRuntime } from '../../projects/runtime';
import { getRunApi } from '../../runs/environment';
import type { SharesRuntime } from '../../shares/core/runtime';
import { log } from '../../telemetry/logger';
import { guardSessionCreation } from '../../workspaces/run-gate';
import { sessionForLaunch } from '../session-launch';
import type { AgentsWiring } from './agents';
import type { RunResourcesWiring } from './run-resources';

export function wireProjects({
  resolveWave5Actor,
  wave5Repositories,
  runGate,
}: Pick<RunResourcesWiring, 'resolveWave5Actor' | 'wave5Repositories'> &
  Pick<AgentsWiring, 'runGate'>): ProjectsRuntime {
  return {
    resolveActor: resolveWave5Actor,
    forWorkspace: async (workspaceId) => {
      const repositories = await wave5Repositories(workspaceId);
      return {
        projects: repositories.projects,
        files: repositories.files,
        mcpServers: repositories.mcpServers,
        audit: repositories.audit,
        agents: repositories.agents,
        agentVersions: repositories.agentVersions,
        // Verification round 1, finding 3: `POST /api/projects/:id/sessions` (issue #125,
        // `apps/web/app/api/projects/**`/`apps/web/server/projects/**`, outside this task's
        // `Owns`) called `sessions.ensure(...)` on this provider with no archived-workspace
        // check at all, so it created a new session in an archived workspace. Neither the route
        // nor `apps/web/server/projects/runtime.ts` is a file this task may edit, so the seam
        // this composition root DOES own — the provider `wireProjects` returns —
        // is wrapped instead: see `apps/web/server/workspaces/run-gate.ts`'s
        // `guardSessionCreation`.
        //
        // Issue #183 wraps that wrapper with the archived-PROJECT gate, defence in depth behind
        // `POST /api/projects/:id/sessions`'s own named `409 project_archived`: the route is where
        // a caller learns why, and this is what keeps the refusal true for any other caller of the
        // same provider. Order is irrelevant — both refuse, neither writes — but the workspace
        // gate stays innermost so an archived workspace is still answered by #119's own line.
        sessions: guardProjectSessionCreation(
          guardSessionCreation(repositories.sessions, workspaceId, runGate),
          createProjectRunGate(repositories.projects),
        ),
      };
    },
  };
}

export function createPublicShareRun({
  root,
  scopes,
  agents,
  sessionRows,
  runGate,
  pinnedVersionFor,
  readRunAgent,
}: Pick<AgentsWiring, 'scopes' | 'agents' | 'sessionRows' | 'runGate'> &
  Pick<RunResourcesWiring, 'pinnedVersionFor' | 'readRunAgent'> & {
    readonly root: DatabaseRoot;
  }): SharesRuntime['runPublic'] {
  return async ({ workspaceId, share, prompt, sessionId }) => {
    const runApi = getRunApi();
    if (runApi === null) throw new Error('The runner is not configured.');

    // Verification round 2, finding 1: this closure creates a session row and a queued run
    // row exactly like `findAgent`/`openSession` above, so it is bound by the same issue #119
    // rule ("Archived workspaces … are excluded from new run/session creation") and the same
    // `runGate` those two call sites share — see `run-gate-integration.test.ts` for the
    // `applicationContext()?.shares.runPublic` probe this line makes pass.
    if (!(await runGate.isUsable(workspaceId))) {
      throw new Error('The public share became unavailable because its workspace is archived.');
    }
    // Issue #1851: a visitor's run spends the workspace's model budget like any other start, so
    // the daily cap refuses it before any row is written. A spend that cannot be read refuses too
    // (fail-closed); either way the visitor sees the share's usual "unavailable", with no cause.
    if (runApi.dailyCostCap !== undefined) {
      const capReached = await runApi.dailyCostCap.refusal(workspaceId).catch((error: unknown) => {
        log.error('[shares] the daily cost cap could not be checked', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return 'unreadable' as const;
      });
      if (capReached !== null) {
        throw new Error('The public share is unavailable: the workspace cannot start runs now.');
      }
    }

    const scope = await scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('The publishing workspace no longer exists.');
    const agent = await agents.forWorkspace(workspaceId).get(share.subjectId);
    if (agent === null) throw new Error('The shared agent no longer exists.');

    // Issue #183, the public run path its acceptance criteria name explicitly. A session this
    // closure *creates* carries no `projectId`, so the only way an archived project is reached
    // here is a `sessionId` that already names a session inside one — `ensure` would return it
    // as `existing` and the run below would be a NEW run in an archived project. Refused before
    // either insert, exactly like the archived-workspace line above.
    const priorSession = await sessionRows.forScope(scope).get(sessionId);
    if (
      priorSession !== null &&
      !(await createProjectRunGate(root.projects.forScope(scope)).isUsableForNewWork(
        priorSession.projectId,
      ))
    ) {
      throw new Error('The public share became unavailable because its project is archived.');
    }

    // A machine publisher has no human `userId` for the current runnable-share contract. Refuse
    // before `ensure`: the visitor session id is deterministic, so writing first would leave a
    // durable machine-owned session that every retry finds but can never run.
    if (share.createdBy === null) {
      throw new Error('Machine-published runnable shares are not enabled in this release.');
    }

    // Lean `startSession`: a visitor's session that already started keeps its pin (`ensure`
    // answers it `existing`), so only a new one reads the pointer.
    const sessionOutcome = await sessionRows.forScope(scope).ensure({
      id: sessionId,
      agentId: agent.id,
      ownerPrincipalId: share.publisherPrincipalId,
      userId: share.createdBy,
      agentVersionId: priorSession === null ? await pinnedVersionFor(scope, agent.id) : null,
    });
    if (sessionOutcome.kind !== 'created' && sessionOutcome.kind !== 'existing') {
      throw new Error('The publisher can no longer run this agent.');
    }

    const principal = {
      principalId: share.publisherPrincipalId,
      // The publisher principal is already the owner (`ShareService.publish` records
      // `ownerPrincipalIdOf(actor)`), so the share runs as, and writes for, that owner.
      ownerPrincipalId: share.publisherPrincipalId,
      userId: share.createdBy,
      workspaceId,
      // A public share runs as its publisher, not as a browser-token holder: no attenuation.
      scope: null,
    };
    const session = sessionForLaunch(sessionOutcome.session);
    // The session's pinned version, not the row, decides the engine and the permissions.
    const { agent: pinned } = await readRunAgent(
      workspaceId,
      agent.id,
      session.agentVersionId ?? null,
    );
    const agentEngine = engineForStoredPolicy(pinned.policy);
    const agentRef = { id: agent.id, workspaceId, engine: agentEngine };
    // ADR-0065 D8, exactly as `startRun` applies it: a visitor's run is still a run in a session
    // with a history, so it is refused before the run row exists rather than re-pinning the
    // session. A share whose agent was moved to another engine after a visitor started talking
    // becomes unavailable, which is the same answer the archived-workspace lines above give.
    const pin = pinSessionEngine({ sessionEngine: session.engine, agentEngine });
    if (pin.kind === 'mismatch') {
      throw new Error(`The public share cannot run: ${sessionEngineMismatchMessage(pin)}`);
    }
    const run = await runApi.store.create({
      engine: pin.engine,
      id: crypto.randomUUID(),
      workspaceId,
      agentId: agent.id,
      sessionId: session.id,
    });
    const attribution = await root.shares.forScope(scope).linkRun(share.id, run.id, new Date());
    if (attribution.kind === 'unavailable') {
      throw new Error('The public share became unavailable before its run was linked.');
    }
    runApi.launch({
      run,
      agent: agentRef,
      session,
      principal,
      prompt,
      permissionOverride: {
        ...pinned.permissions,
        runCommands: false,
        writeFiles: false,
      },
    });
    return {
      output: { runId: run.id, events: `/api/runs/${run.id}/events` },
      runId: run.id,
    };
  };
}

/** The sharing API's runtime, fully built from the stores the composition root opened. */
export function wireShares({
  root,
  scopes,
  agents,
  sessionRows,
  runGate,
  pinnedVersionFor,
  readRunAgent,
  resolveWave5Actor,
  wave5Repositories,
  secretsService,
}: Pick<AgentsWiring, 'scopes' | 'agents' | 'sessionRows' | 'runGate'> &
  Pick<
    RunResourcesWiring,
    'pinnedVersionFor' | 'readRunAgent' | 'resolveWave5Actor' | 'wave5Repositories'
  > & {
    readonly root: DatabaseRoot;
    readonly secretsService: SecretsService | null;
  }): SharesRuntime {
  return {
    resolveActor: resolveWave5Actor,
    forWorkspace: async (workspaceId) => {
      const repositories = await wave5Repositories(workspaceId);
      return { shares: repositories.shares, views: repositories.views, audit: repositories.audit };
    },
    resolvePublic: async (token) => {
      const workspaceId = await root.findShareWorkspace(token);
      if (workspaceId === null) return null;
      const repositories = await wave5Repositories(workspaceId);
      return {
        workspaceId,
        sharing: {
          shares: repositories.shares,
          views: repositories.views,
          audit: repositories.audit,
        },
      };
    },
    sharingMaterials: async (workspaceId) => {
      if (secretsService === null) return { values: [], referenceIds: [] };
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) return { values: [], referenceIds: [] };
      const metadata = await secretsService.list(scope);
      const resolved = await Promise.all(
        metadata.map(async (secretMetadata) =>
          secretsService.resolveByName(scope, secretMetadata.name),
        ),
      );
      return {
        values: resolved.flatMap((secretValue) =>
          secretValue === null ? [] : [secretValue.value.toString('utf8')],
        ),
        referenceIds: metadata.map((secretMetadata) => secretMetadata.id),
      };
    },
    sessionRuns: async (workspaceId, runIds) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) return runIds.map(() => null);
      const runs = root.runs.forScope(scope);
      // ponytail: one read per run, at most SHARE_TRANSCRIPT_MAX_RUNS; one IN query if it matters.
      return Promise.all(
        runIds.map(async (runId) => {
          const run = await runs.get(runId);
          return run === null
            ? null
            : {
                id: run.id,
                sessionId: run.sessionId,
                createdAt: run.createdAt,
                prompt: run.prompt ?? null,
                answer: run.output?.text ?? null,
              };
        }),
      );
    },
    subjectOwnership: async ({ workspaceId, principalId, subjectType, subjectId }) => {
      if (typeof subjectId !== 'string') return 'unknown';
      const scope = await scopes.forWorkspaceId(workspaceId);
      if (scope === null) return 'unknown';
      if (subjectType === 'project') {
        const project = await root.projects.forScope(scope).get(subjectId);
        return project === null
          ? 'unknown'
          : project.ownerPrincipalId === principalId
            ? 'own'
            : 'other';
      }
      if (subjectType === 'session') {
        const session = await sessionRows.forScope(scope).get(subjectId);
        return session === null
          ? 'unknown'
          : session.ownerPrincipalId === principalId
            ? 'own'
            : 'other';
      }
      // This resolver implements ownership lookups only for projects and sessions. Agent and skill
      // subjects remain unknown here, so own-only grants fail closed.
      return 'unknown';
    },
    runPublic: createPublicShareRun({
      root,
      scopes,
      agents,
      sessionRows,
      runGate,
      pinnedVersionFor,
      readRunAgent,
    }),
  };
}
