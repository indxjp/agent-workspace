/**
 * A composition-root integration test — issue #119's "Archived workspaces … are excluded from new
 * run/session creation", proved by driving the closures `register()` actually installs, not the
 * `isWorkspaceUsableForRuns` predicate in isolation.
 *
 * ## Why this file exists (verification round 1, finding 2)
 *
 * `register-archived-guard.test.ts` unit-tests `isWorkspaceUsableForRuns` with literal objects and
 * never calls `register()`, `findAgent` or `openSession`. Deleting the two
 * `if (!(await runGate.isUsable(principal.workspaceId))) return null;` lines this task's repair
 * added to `apps/web/server/composition/register.ts` — or deleting the check inside
 * `run-gate.ts`'s `createRunGate` — makes THIS test fail, because it calls the real `register()`
 * against a real, isolated PostgreSQL and then reads the closures it installed through
 * `apps/web/server/runs/environment.ts`'s `getRunApi()`, the same seam `register.ts` itself reads
 * from for `runPublic`.
 *
 * This needs a database: `describe.skipIf(!hasDatabase)`, exactly like every other
 * database-backed suite in this repository (`pnpm test`, not `pnpm vitest run`, exercises it).
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentPermissions } from '@agent-workspace/core';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import type { RegisteredComposition } from '../composition/register';

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[workspaces/run-gate-integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'composed findAgent/openSession call sites in register.ts were NOT exercised against a ' +
      'real database. A green result without it says nothing about them.',
  );
}

const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

/** Env vars `register()` reads that this test must control, restored afterwards. */
const CONTROLLED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'RUNNER_URL', 'NEXT_RUNTIME'] as const;
const OWNER_MEMBERSHIP_ID = '6891fecf-2816-46b3-bd43-86a3fc8c8604';
const OWNER_PRINCIPAL_ID = 'd7219f92-25b3-47ee-a2b8-e8dfc0ac3329';

describe.skipIf(!hasDatabase)(
  'register() refuses a new run/session in an archived workspace (finding 2)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let composition: RegisteredComposition;
    let agentId: string;
    let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;
    const workspace = { id: crypto.randomUUID(), slug: 'run-gate-it', name: 'Run Gate IT' };
    const owner = { id: crypto.randomUUID(), email: 'owner@run-gate-it.test', name: 'Owner' };

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_run_gate_integration');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values(owner);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values({
          id: OWNER_MEMBERSHIP_ID,
          workspaceId: workspace.id,
          userId: owner.id,
          role: 'owner',
        });
        await tx.insert(workspacePrincipals).values({
          id: OWNER_PRINCIPAL_ID,
          workspaceId: workspace.id,
          kind: 'membership',
          membershipId: OWNER_MEMBERSHIP_ID,
        });
      });

      // Through the public entry point, exactly as a composition root opens it — a second
      // connection to the same physical database `register()` below will also open.
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
      const created = await root.agents.forScope(scope).create({
        name: 'Run Gate Agent',
        instructions: 'irrelevant',
        modelConnectionId: null,
        model: null,
        permissions: PERMISSIONS,
        createdBy: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
      });
      if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);
      agentId = created.agent.id;

      previousEnv = Object.fromEntries(
        CONTROLLED_ENV.map((key) => [key, process.env[key]]),
      ) as typeof previousEnv;
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'run-gate-integration-test-secret-32-chars-min';
      process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
      delete process.env['NEXT_RUNTIME'];

      const { register } = await import('../composition/register');
      const registered = await register();
      if (registered === undefined) throw new Error('composition registration was skipped');
      composition = registered;
    }, 180_000);

    afterAll(async () => {
      for (const key of CONTROLLED_ENV) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeIsolatedTestResources(isolated, composition, root);
    });

    it('findAgent and openSession succeed before archiving, then both refuse after', async () => {
      const { getRunApi } = await import('../runs/environment');
      const runApi = getRunApi();
      expect(runApi).not.toBeNull();
      if (runApi === null) return;

      const principal = {
        principalId: OWNER_PRINCIPAL_ID,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        userId: owner.id,
        workspaceId: workspace.id,
        role: 'owner' as const,
        scope: null,
      };

      const agentBefore = await runApi.findAgent(principal, agentId);
      expect(agentBefore).toEqual({
        id: agentId,
        workspaceId: workspace.id,
        engine: 'claude-agent-sdk',
      });

      const sessionBefore = await runApi.openSession(principal, agentBefore!, null);
      expect(sessionBefore).not.toBeNull();

      const archived = await root.workspaces.archive(workspace.id);
      expect(archived?.archivedAt).not.toBeNull();

      const agentAfter = await runApi.findAgent(principal, agentId);
      expect(agentAfter).toBeNull();

      const sessionAfter = await runApi.openSession(
        principal,
        { id: agentId, workspaceId: workspace.id, engine: 'claude-agent-sdk' },
        null,
      );
      expect(sessionAfter).toBeNull();

      // Non-destructive: restoring makes both usable again, proving the refusal above was the
      // archived-workspace gate and not some other failure this test accidentally induced.
      const restored = await root.workspaces.restore(workspace.id);
      expect(restored?.archivedAt).toBeNull();
      const agentRestored = await runApi.findAgent(principal, agentId);
      expect(agentRestored).toEqual({
        id: agentId,
        workspaceId: workspace.id,
        engine: 'claude-agent-sdk',
      });
    });

    it('refuses to reuse an archived session for a new run', async () => {
      const { getRunApi } = await import('../runs/environment');
      const runApi = getRunApi();
      if (runApi === null) throw new Error('run API was not installed');
      const principal = {
        principalId: OWNER_PRINCIPAL_ID,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        userId: owner.id,
        workspaceId: workspace.id,
        role: 'owner' as const,
        scope: null,
      };
      const agent = { id: agentId, workspaceId: workspace.id, engine: 'claude-agent-sdk' };
      const created = await runApi.openSession(principal, agent, null);
      if (created === null) throw new Error('session was not created');
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed');
      const archived = await root.sessions.forScope(scope).archive(created.id);
      expect(archived.kind).toBe('updated');

      expect(await runApi.openSession(principal, agent, created.id)).toBeNull();
    });

    it(
      'the projects runtime’s session provider (configureProjectsRuntime) refuses new sessions ' +
        'once the workspace is archived (finding 3)',
      async () => {
        const { currentProjectsRuntime } = await import('../projects/runtime');
        const projectsRuntime = currentProjectsRuntime();
        expect(projectsRuntime).not.toBeNull();
        if (projectsRuntime === null) return;

        const repositories = await projectsRuntime.forWorkspace(workspace.id);

        const before = await repositories.sessions.ensure({
          id: crypto.randomUUID(),
          agentId,
          userId: owner.id,
          ownerPrincipalId: OWNER_PRINCIPAL_ID,
        });
        expect(before.kind).toBe('created');

        const archived = await root.workspaces.archive(workspace.id);
        expect(archived?.archivedAt).not.toBeNull();

        const after = await repositories.sessions.ensure({
          id: crypto.randomUUID(),
          agentId,
          userId: owner.id,
          ownerPrincipalId: OWNER_PRINCIPAL_ID,
        });
        // Not `created`/`existing`: `POST /api/projects/:id/sessions` turns any other kind into
        // a generic non-2xx `422 project_session_start_failed` — see `run-gate.ts`'s
        // `guardSessionCreation` for why `not-a-member` specifically.
        expect(after.kind).not.toBe('created');
        expect(after.kind).not.toBe('existing');

        // Reading and archiving an EXISTING session must still work — #119 excludes archived
        // workspaces from NEW creation only.
        if (before.kind === 'created') {
          const read = await repositories.sessions.get(before.session.id);
          expect(read?.id).toBe(before.session.id);
        }

        const restored = await root.workspaces.restore(workspace.id);
        expect(restored?.archivedAt).toBeNull();
        const afterRestore = await repositories.sessions.ensure({
          id: crypto.randomUUID(),
          agentId,
          userId: owner.id,
          ownerPrincipalId: OWNER_PRINCIPAL_ID,
        });
        expect(afterRestore.kind).toBe('created');
      },
    );

    it(
      'the shares runtime’s runPublic refuses to create a session or run once the workspace ' +
        'is archived (verification round 2, finding 1)',
      async () => {
        const { currentSharesRuntime } = await import('../shares/core/runtime');
        const sharesRuntime = currentSharesRuntime();
        expect(sharesRuntime).not.toBeNull();
        if (sharesRuntime === null) return;

        const scope = await root.scopes.forWorkspaceId(workspace.id);
        if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
        const share = await root.shares.forScope(scope).create({
          token: 'run-gate-it-public-token',
          subjectType: 'agent',
          subjectId: agentId,
          subjectLabel: 'Run Gate Agent',
          visibility: 'public',
          mode: 'runnable',
          snapshot: null,
          include: {},
          budgetCapUsd: null,
          expiresAt: null,
          passphraseHash: null,
          createdBy: owner.id,
          publisherPrincipalId: OWNER_PRINCIPAL_ID,
        });

        const archived = await root.workspaces.archive(workspace.id);
        expect(archived?.archivedAt).not.toBeNull();

        const sessionId = crypto.randomUUID();
        await expect(
          sharesRuntime.runPublic({ workspaceId: workspace.id, share, prompt: 'hi', sessionId }),
        ).rejects.toThrow();

        // The bug this closed (verification round 2, finding 1): `runPublic` wrote a session
        // row and a queued run row for an archived workspace BEFORE throwing later for an
        // unrelated reason (the share's un-reserved budget). Both must now be entirely absent —
        // `runGate.isUsable` refuses before either insert runs.
        const sessionRow = await root.sessions.forScope(scope).get(sessionId);
        expect(sessionRow).toBeNull();

        const { runs } = await import('@agent-workspace/core/db/unscoped');
        const runRows = (await isolated.db.select().from(runs)).filter(
          (run) => run.sessionId === sessionId,
        );
        expect(runRows).toEqual([]);

        const restored = await root.workspaces.restore(workspace.id);
        expect(restored?.archivedAt).toBeNull();
      },
    );
  },
);
