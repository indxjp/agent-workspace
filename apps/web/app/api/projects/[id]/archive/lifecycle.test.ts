/**
 * `POST /api/projects/:id/archive` and `POST /api/projects/:id/restore` against a real PostgreSQL —
 * issue #183's role matrix, its concealment rule, its idempotence-with-audit rule and its
 * history-attribution criterion, driven with real `Request` objects through the route handlers
 * exactly as Next.js calls them.
 *
 * Shape borrowed from `../default-model.test.ts` (`createIsolatedTestDatabase` + `openDatabaseRoot`
 * + `describe.skipIf(!hasDatabase)`), with one difference that matters: the actor header carries a
 * real `users.id`, not an email, because `projects.created_by` and `audit_events.actor_user_id` are
 * both `uuid` foreign keys and the own/other split this file is about is a comparison against the
 * former.
 */
import crypto from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { POST as ARCHIVE } from './route';
import { POST as RESTORE } from '../restore/route';
import { GET as GET_PROJECT } from '../route';
import { GET as LIST_PROJECTS } from '../../route';
import { createPostgresDirectory } from '../../../../../server/rbac/postgres-directory';
import { Principal } from '../../../../../server/rbac/principal';
import type { Role } from '../../../../../server/rbac/roles';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';

const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn(
    '[app/api/projects/[id]/archive/lifecycle.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so ' +
      'the archive/restore routes were NOT exercised against a real database.',
  );
}

const workspaceA = { id: crypto.randomUUID(), slug: 'w9-183-a', name: 'Workspace A' };
const workspaceB = { id: crypto.randomUUID(), slug: 'w9-183-b', name: 'Workspace B' };
const ownerA = { id: crypto.randomUUID(), email: 'owner-a@example.test', name: 'Owner A' };
const creator = { id: crypto.randomUUID(), email: 'creator@example.test', name: 'Creator Builder' };
const otherBuilder = {
  id: crypto.randomUUID(),
  email: 'other@example.test',
  name: 'Other Builder',
};
const adminA = { id: crypto.randomUUID(), email: 'admin-a@example.test', name: 'Admin A' };
const viewerA = { id: crypto.randomUUID(), email: 'viewer-a@example.test', name: 'Viewer A' };
const ownerB = { id: crypto.randomUUID(), email: 'owner-b@example.test', name: 'Owner B' };
const PRINCIPAL_IDS = {
  ownerA: '119cba41-57af-45ad-9f7d-ad08ae584a45',
  creator: 'e7615ca3-dd44-48c8-aeee-030b0c3f3da5',
  otherBuilder: 'e208b98d-202a-43a7-9064-a65713c56795',
  adminA: '302fbaf0-19b3-4ace-ab46-e49abe7c706a',
  viewerA: 'fb0ea9f3-d8a2-4d05-8178-7860d75bc2a5',
  ownerB: '42d30a25-538f-49e4-90d1-0d6fa38152e5',
} as const;
const MEMBERSHIP_IDS = {
  ownerA: 'd3d4d980-6d90-4c80-a6e5-7f77a7b8f3e5',
  creator: '28c35c81-21b6-45e7-b39c-c5fe6f71c8cb',
  otherBuilder: 'db9da1b9-00ea-4b43-9ff8-999af0112f67',
  adminA: '3db5f665-0c50-4614-94a3-7b6ee74b2d40',
  viewerA: 'ccce94fd-bf2a-4b48-ab72-06c431f8cfdc',
  ownerB: '9834ab7c-c5f1-49f1-aa9e-c277daab84d2',
} as const;

function principalIdFor(actor: string): string {
  if (actor === ownerA.id) return PRINCIPAL_IDS.ownerA;
  if (actor === creator.id) return PRINCIPAL_IDS.creator;
  if (actor === otherBuilder.id) return PRINCIPAL_IDS.otherBuilder;
  if (actor === adminA.id) return PRINCIPAL_IDS.adminA;
  if (actor === viewerA.id) return PRINCIPAL_IDS.viewerA;
  if (actor === ownerB.id) return PRINCIPAL_IDS.ownerB;
  throw new Error(`no principal fixture for actor ${actor}`);
}

/** The role each seeded actor authenticates as. An actor absent here does not authenticate. */
const ROLES = new Map<string, Role>([
  [ownerA.id, 'owner'],
  [creator.id, 'builder'],
  [otherBuilder.id, 'builder'],
  [adminA.id, 'admin'],
  [viewerA.id, 'viewer'],
  [ownerB.id, 'owner'],
]);

/** An authenticated-at-the-projects-runtime actor that the RBAC identity layer does not know. */
const STRANGER = crypto.randomUUID();

function req(url: string, workspaceId: string | null, actor: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (workspaceId !== null) headers.set(WORKSPACE_HEADER, workspaceId);
  if (actor !== null) headers.set(ACTOR_HEADER, actor);
  return new Request(`https://example.invalid${url}`, { method: 'POST', headers });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

interface Problem {
  readonly status: number;
  readonly body: unknown;
}

async function asProblem(response: Response): Promise<Problem> {
  return { status: response.status, body: await response.json() };
}

describe.skipIf(!hasDatabase)(
  'POST /api/projects/:id/archive and /restore (issue #183, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let agentId: string;
    /** A fresh project in workspace A, created by `creator`, for every test. */
    let projectId: string;

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_w9_proj_183_lifecycle');
      await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
      await isolated.db
        .insert(users)
        .values([ownerA, creator, otherBuilder, adminA, viewerA, ownerB]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values([
          {
            id: MEMBERSHIP_IDS.ownerA,
            workspaceId: workspaceA.id,
            userId: ownerA.id,
            role: 'owner',
          },
          {
            id: MEMBERSHIP_IDS.creator,
            workspaceId: workspaceA.id,
            userId: creator.id,
            role: 'builder',
          },
          {
            id: MEMBERSHIP_IDS.otherBuilder,
            workspaceId: workspaceA.id,
            userId: otherBuilder.id,
            role: 'builder',
          },
          {
            id: MEMBERSHIP_IDS.adminA,
            workspaceId: workspaceA.id,
            userId: adminA.id,
            role: 'admin',
          },
          {
            id: MEMBERSHIP_IDS.viewerA,
            workspaceId: workspaceA.id,
            userId: viewerA.id,
            role: 'viewer',
          },
          {
            id: MEMBERSHIP_IDS.ownerB,
            workspaceId: workspaceB.id,
            userId: ownerB.id,
            role: 'owner',
          },
        ]);
        await tx.insert(workspacePrincipals).values([
          {
            id: PRINCIPAL_IDS.ownerA,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.ownerA,
          },
          {
            id: PRINCIPAL_IDS.creator,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.creator,
          },
          {
            id: PRINCIPAL_IDS.otherBuilder,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.otherBuilder,
          },
          {
            id: PRINCIPAL_IDS.adminA,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.adminA,
          },
          {
            id: PRINCIPAL_IDS.viewerA,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.viewerA,
          },
          {
            id: PRINCIPAL_IDS.ownerB,
            workspaceId: workspaceB.id,
            kind: 'membership',
            membershipId: MEMBERSHIP_IDS.ownerB,
          },
        ]);
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });

      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('fixture workspace A did not resolve');
      const agent = await root.agents.forScope(scopeA).create({
        name: 'Lifecycle Agent',
        instructions: 'irrelevant',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        createdBy: ownerA.id,
        ownerPrincipalId: PRINCIPAL_IDS.ownerA,
      });
      if (agent.kind !== 'created') throw new Error(`fixture agent failed: ${agent.kind}`);
      agentId = agent.agent.id;
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    beforeEach(async () => {
      installTestDomains({
        projects: {
          resolveActor: (request) => {
            const workspaceId = request.headers.get(WORKSPACE_HEADER);
            const actor = request.headers.get(ACTOR_HEADER);
            return Promise.resolve(
              workspaceId === null || actor === null || !ROLES.has(actor)
                ? { kind: 'unauthenticated' as const, reason: 'no test workspace header' }
                : {
                    kind: 'workspace' as const,
                    workspaceId,
                    principalId: principalIdFor(actor),
                    ownerPrincipalId: principalIdFor(actor),
                    userId: actor,
                    userLabel: actor,
                  },
            );
          },
          forWorkspace: async (workspaceId) => {
            const scope = await root.scopes.forWorkspaceId(workspaceId);
            if (scope === null) throw new Error(`fixture workspace ${workspaceId} did not resolve`);
            return {
              projects: root.projects.forScope(scope),
              files: root.projectFiles.forScope(scope),
              mcpServers: root.projectMcpServers.forScope(scope),
              audit: root.auditEventRepository.forScope(scope),
              agents: root.agents.forScope(scope),
              sessions: root.sessions.forScope(scope),
              agentVersions: root.agentVersions.forScope(scope),
            };
          },
        },
      });
      installTestDomains({
        rbac: {
          directory: createPostgresDirectory(root.directory),
          identify(request: Request) {
            const workspaceId = request.headers.get(WORKSPACE_HEADER);
            const actor = request.headers.get(ACTOR_HEADER);
            const role = actor === null ? undefined : ROLES.get(actor);
            return Promise.resolve(
              workspaceId === null || actor === null || role === undefined
                ? null
                : Principal.fromApiKey({
                    principalId: principalIdFor(actor),
                    apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    workspaceId,
                    role,
                    label: 'Project lifecycle test key',
                  }),
            );
          },
        },
      });

      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const project = await root.projects.forScope(scopeA).create({
        name: `Project ${crypto.randomUUID()}`,
        visibility: 'private',
        createdBy: creator.id,
        ownerPrincipalId: PRINCIPAL_IDS.creator,
      });
      projectId = project.id;
    });

    afterEach(() => {
      clearApplicationContext();
    });

    /** The row's own column, read directly — independent of what any route reports. */
    async function storedArchivedAt(id = projectId): Promise<Date | null> {
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const row = await root.projects.forScope(scopeA).get(id);
      if (row === null) throw new Error('fixture project disappeared');
      return row.archivedAt;
    }

    /** Every audit row about this test's project, in workspace A. */
    async function auditRows(): Promise<readonly { action: string; actorUserId: string | null }[]> {
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      return (await root.auditEventRepository.forScope(scopeA).list({ limit: 500 })).items.filter(
        (row) => row.subjectId === projectId,
      );
    }

    /**
     * Workspace A's total audit-row count — the unfiltered read `auditRows` narrows. Rows
     * accumulate across the cases in this file, so this is only meaningful as a difference taken
     * around the requests under test, never as an absolute.
     */
    async function auditCount(): Promise<number> {
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      return root.auditEventRepository.forScope(scopeA).count();
    }

    function archive(actor: string | null, id = projectId, workspaceId = workspaceA.id) {
      return ARCHIVE(req(`/api/projects/${id}/archive`, workspaceId, actor), idContext(id));
    }

    function restore(actor: string | null, id = projectId, workspaceId = workspaceA.id) {
      return RESTORE(req(`/api/projects/${id}/restore`, workspaceId, actor), idContext(id));
    }

    it('lets the workspace Owner archive and restore, publishing archivedAt both ways', async () => {
      const archived = await archive(ownerA.id);
      expect(archived.status, await archived.clone().text()).toBe(200);
      const archivedBody = (await archived.json()) as { id: string; archivedAt: string | null };
      expect(archivedBody.id).toBe(projectId);
      expect(archivedBody.archivedAt).not.toBeNull();
      expect(await storedArchivedAt()).not.toBeNull();

      const restored = await restore(ownerA.id);
      expect(restored.status, await restored.clone().text()).toBe(200);
      const restoredBody = (await restored.json()) as { archivedAt: string | null };
      expect(restoredBody.archivedAt).toBeNull();
      expect(await storedArchivedAt()).toBeNull();
    });

    it('lets the Builder who created the project archive and restore it', async () => {
      const archived = await archive(creator.id);
      expect(archived.status, await archived.clone().text()).toBe(200);
      expect(await storedArchivedAt()).not.toBeNull();

      const restored = await restore(creator.id);
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await storedArchivedAt()).toBeNull();
    });

    it('lets a workspace Admin archive and restore any project (ADR-0152)', async () => {
      const archived = await archive(adminA.id);
      expect(archived.status, await archived.clone().text()).toBe(200);
      expect(await storedArchivedAt()).not.toBeNull();

      const restored = await restore(adminA.id);
      expect(restored.status, await restored.clone().text()).toBe(200);
      expect(await storedArchivedAt()).toBeNull();
    });

    /**
     * The concealment criterion, asserted as an equality rather than as "some 4xx": every refused
     * caller receives the byte-identical response an id that names nothing at all produces. A 403
     * here — the answer `GET`/`PATCH /api/projects/:id` give — fails this test by name.
     */
    it('conceals a refused Builder, Viewer and foreign-workspace caller exactly like a nonexistent id', async () => {
      const nonexistent = await asProblem(await archive(ownerA.id, crypto.randomUUID()));
      expect(nonexistent.status).toBe(404);

      const refusals = [
        ['non-creator Builder', await asProblem(await archive(otherBuilder.id))],
        ['Viewer', await asProblem(await archive(viewerA.id))],
        [
          'foreign-workspace Owner',
          await asProblem(await archive(ownerB.id, projectId, workspaceB.id)),
        ],
      ] as const;

      for (const [who, problem] of refusals) {
        expect(problem, `${who} must be answered exactly like a nonexistent id`).toEqual(
          nonexistent,
        );
      }
      // None of them changed anything, which is the other half of "refused".
      expect(await storedArchivedAt()).toBeNull();
      expect(await auditRows()).toEqual([]);

      // Restore refuses identically, so a caller cannot learn the project exists from one route
      // while being concealed by the other.
      expect(await asProblem(await restore(otherBuilder.id))).toEqual(nonexistent);
    });

    /**
     * A malformed `:id` is an id that names nothing at all, so it gets that one answer too —
     * issue #200. `projects.id` is a `uuid` column, so a segment that is not a UUID cannot match
     * a row; handing it to the repository instead makes PostgreSQL raise `22P02 invalid input
     * syntax for type uuid`, which `errorResponse` classifies as an unclassified persistence
     * failure and reports as `500 internal_error`.
     *
     * Asserted as an equality against the absent-id control rather than as "some 4xx", for the
     * same reason the concealment case above is: the contract is that *one* response answers
     * every id that names nothing, so a caller must not be able to tell a malformed id from an
     * absent one by its status, its code or its message.
     */
    it('answers a malformed id exactly like an absent one, on both archive and restore', async () => {
      // A malformed id must not outrank the credential check: the guard lives inside the
      // `withProjects` callback, so 401 still precedes it. Moving the guard into the two
      // `route.ts` files would turn these into 404s and conceal a missing credential. The "keeps a
      // 401 a 401" case below cannot catch that — its id is a well-formed UUID the guard accepts.
      expect((await archive(null, 'not-a-uuid')).status).toBe(401);
      expect((await restore(null, 'not-a-uuid')).status).toBe(401);

      const nonexistent = await asProblem(await archive(ownerA.id, crypto.randomUUID()));
      expect(nonexistent.status).toBe(404);

      const auditsBefore = await auditCount();
      const malformed = [
        ['a segment that is not a UUID at all', 'not-a-uuid'],
        ['a near-miss one character short', '11111111-1111-4111-8111-11111111111'],
        ['a well-formed UUID with a trailing suffix', '11111111-1111-4111-8111-111111111111x'],
      ] as const;

      for (const [shape, id] of malformed) {
        expect(
          await asProblem(await archive(ownerA.id, id)),
          `archive with ${shape} must be answered exactly like an absent id`,
        ).toEqual(nonexistent);
        // Restore answers identically, so one route cannot leak what the other conceals.
        expect(
          await asProblem(await restore(ownerA.id, id)),
          `restore with ${shape} must be answered exactly like an absent id`,
        ).toEqual(nonexistent);
      }

      // Refused before anything was touched — a later "fix" that answers 404 only after writing
      // fails here rather than passing on the status alone. The audit check is a count taken around
      // the requests, and unfiltered: `auditRows()` is scoped to `projectId`, which none of these
      // ids can ever name, so an equality against it would stay green whatever was written.
      expect(await storedArchivedAt()).toBeNull();
      expect(await auditCount()).toBe(auditsBefore);
    });

    /**
     * Concealment applies to the **refusal**, never to the absence of a credential: answering an
     * unauthenticated caller "no such project" would make a missing credential indistinguishable
     * from a wrong one and would answer a question they never got far enough to ask.
     */
    it('keeps a 401 a 401 — an unauthenticated caller is not concealed as a missing project', async () => {
      const noHeaders = await archive(null);
      expect(noHeaders.status).toBe(401);

      // Past the projects runtime, refused by the RBAC identity layer: still 401, not 404.
      const unknownIdentity = await archive(STRANGER);
      expect(unknownIdentity.status, await unknownIdentity.clone().text()).toBe(401);
      expect(await storedArchivedAt()).toBeNull();
    });

    it('is idempotent, and audits the transition rather than the request', async () => {
      const first = await archive(ownerA.id);
      const firstAt = ((await first.json()) as { archivedAt: string }).archivedAt;
      const second = await archive(ownerA.id);
      expect(second.status, await second.clone().text()).toBe(200);
      expect(((await second.json()) as { archivedAt: string }).archivedAt).toBe(firstAt);
      expect((await auditRows()).filter((row) => row.action === 'project-archived')).toHaveLength(
        1,
      );

      await restore(ownerA.id);
      const secondRestore = await restore(ownerA.id);
      expect(secondRestore.status).toBe(200);
      expect(((await secondRestore.json()) as { archivedAt: null }).archivedAt).toBeNull();
      const rows = await auditRows();
      expect(rows.filter((row) => row.action === 'project-restored')).toHaveLength(1);
      expect(rows.map((row) => row.action).sort()).toEqual([
        'project-archived',
        'project-restored',
      ]);
    });

    it('records who acted and on what, and nothing else — no credential, no foreign id', async () => {
      await archive(ownerA.id);
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const row = (
        await root.auditEventRepository.forScope(scopeA).list({ limit: 500 })
      ).items.find((candidate) => candidate.subjectId === projectId);
      expect(row?.action).toBe('project-archived');
      expect(row?.actorUserId).toBe(ownerA.id);
      expect(row?.workspaceId).toBe(workspaceA.id);
      // Workspace B's id and the API key the principal authenticated with appear nowhere.
      const serialised = JSON.stringify(row);
      expect(serialised).not.toContain(workspaceB.id);
      expect(serialised).not.toContain('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    });

    it('keeps session and run history attributed to the project after it is archived', async () => {
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const session = await root.sessions.forScope(scopeA).ensure({
        id: crypto.randomUUID(),
        agentId,
        userId: creator.id,
        ownerPrincipalId: PRINCIPAL_IDS.creator,
        projectId,
      });
      if (session.kind !== 'created') throw new Error(`fixture session failed: ${session.kind}`);
      const run = await root.runs.forScope(scopeA).create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        sessionId: session.session.id,
      });
      if (run.kind !== 'created') throw new Error(`fixture run failed: ${run.kind}`);

      expect((await archive(ownerA.id)).status).toBe(200);

      // The project itself still reads, with its lifecycle state visible.
      const fetched = await GET_PROJECT(
        new Request(`https://example.invalid/api/projects/${projectId}`, {
          headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
        }),
        idContext(projectId),
      );
      expect(fetched.status, await fetched.clone().text()).toBe(200);
      expect(((await fetched.json()) as { archivedAt: string | null }).archivedAt).not.toBeNull();

      // …and both the session and the run still resolve to it.
      expect((await root.sessions.forScope(scopeA).get(session.session.id))?.projectId).toBe(
        projectId,
      );
      const page = await root.runs
        .forScope(scopeA)
        .listRuns?.({ filter: { projectId }, limit: 10 });
      expect(page?.items.map((item) => item.id)).toEqual([run.run.id]);
    });

    it('hides an archived project from the default listing and returns it on ?archived=all', async () => {
      await archive(ownerA.id);

      const listed = async (query: string): Promise<readonly string[]> => {
        const response = await LIST_PROJECTS(
          new Request(`https://example.invalid/api/projects${query}`, {
            headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
          }),
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const body = (await response.json()) as { projects: readonly { id: string }[] };
        return body.projects.map((project) => project.id);
      };

      expect(await listed('')).not.toContain(projectId);
      expect(await listed('?archived=all')).toContain(projectId);
      expect(await listed('?archived=archived')).toContain(projectId);
      expect(await listed('?archived=active')).not.toContain(projectId);

      const invalid = await LIST_PROJECTS(
        new Request('https://example.invalid/api/projects?archived=yes', {
          headers: { [WORKSPACE_HEADER]: workspaceA.id, [ACTOR_HEADER]: ownerA.id },
        }),
      );
      expect(invalid.status, await invalid.clone().text()).toBe(400);
      expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
        'invalid_project',
      );
    });
  },
);
