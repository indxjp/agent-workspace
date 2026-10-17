/**
 * A composition-root integration test — issue #183's "Refuse every new session and run for an
 * archived project at the server boundary", proved by driving the closures `register()` actually
 * installs rather than the predicate in `archive-gate.ts` in isolation.
 *
 * ## Why this file exists
 *
 * `docs/adr/W9-WS-119-run-gate-module-and-project-sessions.md` finding 2 recorded the exact
 * mistake this avoids, one wave ago and one level up: a unit test of `isWorkspaceUsableForRuns`
 * proved the predicate and proved nothing about the `if (!…) return null;` lines calling it, so
 * deleting those lines left every test green. `archive-gate.test.ts` beside this file is that unit
 * test; **this** file is what makes each call site load-bearing. Deleting the gate line in
 * `register.ts`'s `openSession` resume branch, in its `runPublic`, or the
 * `guardProjectSessionCreation` wrapper on the projects runtime's session provider, turns exactly
 * one test here red.
 *
 * Needs a database: `describe.skipIf(!hasDatabase)`, exercised by `pnpm test` (which starts
 * PostgreSQL) rather than by a bare `pnpm vitest run`.
 */
import crypto from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentPermissions } from '@agent-workspace/core';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runs,
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
    '[projects/archive-gate-integration.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the ' +
      'composed archived-project call sites in register.ts were NOT exercised against a real ' +
      'database. A green result without it says nothing about them.',
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
const OWNER_MEMBERSHIP_ID = '5d99dcb9-5caa-4f6d-a206-d403d7e94fe6';
const OWNER_PRINCIPAL_ID = 'fbcb140b-6355-4f95-ae71-f3d258102b58';

describe.skipIf(!hasDatabase)(
  'register() refuses new sessions and runs in an archived project (issue #183)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let composition: RegisteredComposition;
    let agentId: string;
    let projectId: string;
    let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;
    const workspace = { id: crypto.randomUUID(), slug: 'archive-gate-it', name: 'Archive Gate IT' };
    const owner = { id: crypto.randomUUID(), email: 'owner@archive-gate-it.test', name: 'Owner' };

    /** Archive the fixture project through the repository, never through the gate under test. */
    async function setArchived(archived: boolean): Promise<void> {
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed');
      const projects = root.projects.forScope(scope);
      const row = archived ? await projects.archive(projectId) : await projects.restore(projectId);
      if (row === null) throw new Error('the fixture project disappeared');
      expect(row.archivedAt === null).toBe(!archived);
    }

    /** A session in the fixture project, owned by `owner` and running `agentId`. */
    async function seedSession(): Promise<string> {
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed');
      const outcome = await root.sessions.forScope(scope).ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        projectId,
      });
      if (outcome.kind !== 'created') throw new Error(`session seed failed: ${outcome.kind}`);
      return outcome.session.id;
    }

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_archive_gate_integration');
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

      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
      const created = await root.agents.forScope(scope).create({
        name: 'Archive Gate Agent',
        instructions: 'irrelevant',
        modelConnectionId: null,
        model: null,
        permissions: PERMISSIONS,
        createdBy: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
      });
      if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);
      agentId = created.agent.id;
      const project = await root.projects.forScope(scope).create({
        name: 'Archive Gate Project',
        visibility: 'private',
        createdBy: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
      });
      projectId = project.id;

      previousEnv = Object.fromEntries(
        CONTROLLED_ENV.map((key) => [key, process.env[key]]),
      ) as typeof previousEnv;
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'archive-gate-integration-test-secret-32-chars-min';
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

    it('the projects runtime’s session provider refuses a new session in an archived project', async () => {
      const { currentProjectsRuntime } = await import('./runtime');
      const projectsRuntime = currentProjectsRuntime();
      expect(projectsRuntime).not.toBeNull();
      if (projectsRuntime === null) return;
      const repositories = await projectsRuntime.forWorkspace(workspace.id);

      const before = await repositories.sessions.ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        projectId,
      });
      expect(before.kind).toBe('created');

      await setArchived(true);
      const after = await repositories.sessions.ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        projectId,
      });
      expect(after.kind).not.toBe('created');
      expect(after.kind).not.toBe('existing');

      // Reading an existing session is untouched — #183 excludes archived projects from NEW work
      // only, and a session that predates the archive may finish.
      if (before.kind === 'created') {
        expect((await repositories.sessions.get(before.session.id))?.id).toBe(before.session.id);
      }

      // A session that belongs to no project at all is unaffected by any project's state.
      const projectless = await repositories.sessions.ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
      });
      expect(projectless.kind).toBe('created');

      await setArchived(false);
      const restored = await repositories.sessions.ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: owner.id,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        projectId,
      });
      expect(restored.kind).toBe('created');
    });

    it('openSession refuses to resume a session whose project is archived, so no new run starts', async () => {
      const { getRunApi } = await import('../runs/environment');
      const runApi = getRunApi();
      expect(runApi).not.toBeNull();
      if (runApi === null) return;

      const sessionId = await seedSession();
      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
      const claimed = await root.sessions.forScope(scope).update(sessionId, {
        engineIdentity: { engineSessionId: sessionId, engine: 'claude-agent-sdk' },
      });
      if (claimed.kind === 'not-found') throw new Error('the seeded session disappeared');
      const principal = {
        principalId: OWNER_PRINCIPAL_ID,
        ownerPrincipalId: OWNER_PRINCIPAL_ID,
        userId: owner.id,
        workspaceId: workspace.id,
        role: 'owner' as const,
        scope: null,
      };
      const agentRef = { id: agentId, workspaceId: workspace.id, engine: 'claude-agent-sdk' };

      const before = await runApi.openSession(principal, agentRef, sessionId);
      expect(before).toEqual({
        id: sessionId,
        agentId,
        engine: 'claude-agent-sdk',
        agentVersionId: null,
        resume: true,
      });

      await setArchived(true);
      expect(await runApi.openSession(principal, agentRef, sessionId)).toBeNull();

      // Non-destructive: restoring makes the same resume work again, so the refusal above was this
      // gate and not some other failure the test accidentally induced.
      await setArchived(false);
      expect(await runApi.openSession(principal, agentRef, sessionId)).toEqual({
        id: sessionId,
        agentId,
        engine: 'claude-agent-sdk',
        agentVersionId: null,
        resume: true,
      });
    });

    it('runPublic refuses a run on a session inside an archived project, and writes no run row', async () => {
      const { currentSharesRuntime } = await import('../shares/core/runtime');
      const sharesRuntime = currentSharesRuntime();
      expect(sharesRuntime).not.toBeNull();
      if (sharesRuntime === null) return;

      const scope = await root.scopes.forWorkspaceId(workspace.id);
      if (scope === null) throw new Error('scope resolution failed for the seeded workspace');
      const share = await root.shares.forScope(scope).create({
        token: 'archive-gate-it-public-token',
        subjectType: 'agent',
        subjectId: agentId,
        subjectLabel: 'Archive Gate Agent',
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

      const sessionId = await seedSession();
      await setArchived(true);

      await expect(
        sharesRuntime.runPublic({ workspaceId: workspace.id, share, prompt: 'hi', sessionId }),
      ).rejects.toThrow('The public share became unavailable because its project is archived.');

      // The acceptance criterion is about the run, not about the exception: the refusal happens
      // before `store.create`, so no queued run row exists for this session.
      const runRows = (await isolated.db.select().from(runs)).filter(
        (run) => run.sessionId === sessionId,
      );
      expect(runRows).toEqual([]);

      await setArchived(false);
    });
  },
);
