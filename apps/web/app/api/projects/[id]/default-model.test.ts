/**
 * `GET`/`PATCH /api/projects/:id`, driven with real `Request` objects against a real PostgreSQL —
 * issue #153: the project-level model default pair must persist, round-trip, clear to `null`, and
 * refuse a connection id this workspace cannot see, without revealing whether that id belongs to
 * another workspace or names nothing at all.
 *
 * Mirrors `apps/web/server/files/routes.test.ts`'s DB-backed shape: `createIsolatedTestDatabase`
 * plus `openDatabaseRoot`, seeded fixture rows, and the route handlers imported and called exactly
 * as Next.js would call them. The actor authenticates as workspace Owner throughout — Owner's RBAC
 * fallback is `any` on every resource (`permissions.ts`), so these tests are about the model-default
 * write path itself, not `apps/web/server/resources/authorise.ts`'s own/other split, which
 * `apps/web/server/files/routes.test.ts` already covers.
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

import { GET, PATCH } from './route';
import { createPostgresDirectory } from '../../../../server/rbac/postgres-directory';
import { Principal } from '../../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../server/rbac/runtime';
import {
  clearProjectsRuntime,
  configureProjectsRuntime,
} from '../../../../server/projects/runtime';

const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';
const OWNER_A_MEMBERSHIP_ID = '2ab27588-5218-4b32-9043-12965f74f45f';
const OWNER_B_MEMBERSHIP_ID = '3dce0862-c686-414e-a8fb-fc305b33338b';
const OWNER_A_PRINCIPAL_ID = '9ce1a0dd-a79d-4571-83c6-6ed7fef64b01';
const OWNER_B_PRINCIPAL_ID = '01ea246f-4446-4129-b202-7b3d84069466';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[app/api/projects/[id]/route.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

function req(
  method: string,
  url: string,
  workspaceId: string,
  actor: string,
  body?: unknown,
): Request {
  return new Request(`https://example.invalid${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      [WORKSPACE_HEADER]: workspaceId,
      [ACTOR_HEADER]: actor,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe.skipIf(!hasDatabase)(
  'PATCH/GET /api/projects/:id — the project default model pair (issue #153, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    const workspaceA = { id: crypto.randomUUID(), slug: 'w9-153-a', name: 'Workspace A' };
    const workspaceB = { id: crypto.randomUUID(), slug: 'w9-153-b', name: 'Workspace B' };
    const ownerA = { id: crypto.randomUUID(), email: 'owner-a@example.test', name: 'Owner A' };
    const ownerB = { id: crypto.randomUUID(), email: 'owner-b@example.test', name: 'Owner B' };
    /** A's own, ready connection — the one a PATCH in A's workspace is allowed to name. */
    let connectionA: string;
    /** B's connection — real, but never visible from A. The cross-workspace attack's target. */
    let connectionB: string;
    /** A fresh project id every test gets, from `beforeEach` below. */
    let projectId: string;

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_w9_proj_153_route');
      await isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
      await isolated.db.insert(users).values([ownerA, ownerB]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(memberships).values([
          {
            id: OWNER_A_MEMBERSHIP_ID,
            workspaceId: workspaceA.id,
            userId: ownerA.id,
            role: 'owner',
          },
          {
            id: OWNER_B_MEMBERSHIP_ID,
            workspaceId: workspaceB.id,
            userId: ownerB.id,
            role: 'owner',
          },
        ]);
        await tx.insert(workspacePrincipals).values([
          {
            id: OWNER_A_PRINCIPAL_ID,
            workspaceId: workspaceA.id,
            kind: 'membership',
            membershipId: OWNER_A_MEMBERSHIP_ID,
          },
          {
            id: OWNER_B_PRINCIPAL_ID,
            workspaceId: workspaceB.id,
            kind: 'membership',
            membershipId: OWNER_B_MEMBERSHIP_ID,
          },
        ]);
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });

      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      const scopeB = await root.scopes.forWorkspaceId(workspaceB.id);
      if (scopeA === null || scopeB === null) throw new Error('fixture workspaces did not resolve');

      const createdA = await root.modelConnections.forScope(scopeA).create({
        id: crypto.randomUUID(),
        name: 'A ready connection',
        provider: 'anthropic',
        config: {},
      });
      const createdB = await root.modelConnections.forScope(scopeB).create({
        id: crypto.randomUUID(),
        name: 'B ready connection',
        provider: 'anthropic',
        config: {},
      });
      if (createdA.kind !== 'created' || createdB.kind !== 'created') {
        throw new Error('fixture model connections did not create');
      }
      connectionA = createdA.connection.id;
      connectionB = createdB.connection.id;
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    beforeEach(async () => {
      configureProjectsRuntime({
        resolveActor: (request) => {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          const actor = request.headers.get(ACTOR_HEADER);
          return Promise.resolve(
            workspaceId === null || actor === null
              ? { kind: 'unauthenticated' as const, reason: 'no test workspace header' }
              : {
                  kind: 'workspace' as const,
                  workspaceId,
                  principalId: actor === ownerA.id ? OWNER_A_PRINCIPAL_ID : OWNER_B_PRINCIPAL_ID,
                  ownerPrincipalId:
                    actor === ownerA.id ? OWNER_A_PRINCIPAL_ID : OWNER_B_PRINCIPAL_ID,
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
      });
      configureRbacRuntime({
        directory: createPostgresDirectory(root.directory),
        identify(request: Request) {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          const actor = request.headers.get(ACTOR_HEADER);
          return Promise.resolve(
            workspaceId === null || actor === null
              ? null
              : Principal.fromApiKey({
                  principalId: actor === ownerA.id ? OWNER_A_PRINCIPAL_ID : OWNER_B_PRINCIPAL_ID,
                  apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                  workspaceId,
                  role: 'owner',
                  label: 'Project default model test key',
                }),
          );
        },
      });

      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const project = await root.projects.forScope(scopeA).create({
        name: `Project ${crypto.randomUUID()}`,
        visibility: 'private',
        createdBy: ownerA.id,
        ownerPrincipalId: OWNER_A_PRINCIPAL_ID,
      });
      projectId = project.id;
    });

    afterEach(() => {
      clearProjectsRuntime();
      clearRbacRuntime();
    });

    /** The row's own two columns, read directly — independent of what any route reports. */
    async function storedPair(): Promise<{ connectionId: string | null; model: string | null }> {
      const scopeA = await root.scopes.forWorkspaceId(workspaceA.id);
      if (scopeA === null) throw new Error('workspace A did not resolve');
      const row = await root.projects.forScope(scopeA).get(projectId);
      if (row === null) throw new Error('fixture project disappeared');
      return { connectionId: row.defaultModelConnectionId, model: row.defaultModel };
    }

    it('persists the pair on PATCH and returns it from the next GET', async () => {
      const patched = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModelConnectionId: connectionA,
          defaultModel: 'claude-sonnet-4-5',
        }),
        idContext(projectId),
      );
      expect(patched.status, await patched.clone().text()).toBe(200);
      const patchedBody = (await patched.json()) as {
        defaultModelConnectionId: string | null;
        defaultModel: string | null;
      };
      expect(patchedBody.defaultModelConnectionId).toBe(connectionA);
      expect(patchedBody.defaultModel).toBe('claude-sonnet-4-5');

      const fetched = await GET(
        req('GET', `/api/projects/${projectId}`, workspaceA.id, ownerA.email),
        idContext(projectId),
      );
      expect(fetched.status).toBe(200);
      const fetchedBody = (await fetched.json()) as {
        defaultModelConnectionId: string | null;
        defaultModel: string | null;
      };
      expect(fetchedBody.defaultModelConnectionId).toBe(connectionA);
      expect(fetchedBody.defaultModel).toBe('claude-sonnet-4-5');
      expect(await storedPair()).toEqual({ connectionId: connectionA, model: 'claude-sonnet-4-5' });
    });

    it('clears both fields to null so the workspace default applies on the next resolution', async () => {
      const setResponse = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModelConnectionId: connectionA,
          defaultModel: 'claude-sonnet-4-5',
        }),
        idContext(projectId),
      );
      expect(setResponse.status).toBe(200);

      const cleared = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModelConnectionId: null,
          defaultModel: null,
        }),
        idContext(projectId),
      );
      expect(cleared.status, await cleared.clone().text()).toBe(200);
      const clearedBody = (await cleared.json()) as {
        defaultModelConnectionId: string | null;
        defaultModel: string | null;
      };
      expect(clearedBody.defaultModelConnectionId).toBeNull();
      expect(clearedBody.defaultModel).toBeNull();
      expect(await storedPair()).toEqual({ connectionId: null, model: null });
    });

    it('refuses defaultModel without a defaultModelConnectionId, and never stores it', async () => {
      const response = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModel: 'claude-sonnet-4-5',
        }),
        idContext(projectId),
      );
      expect(response.status, await response.clone().text()).toBe(400);
      expect(await storedPair()).toEqual({ connectionId: null, model: null });
    });

    /**
     * The verifier attack: a real connection in another workspace, and an id that names nothing
     * at all, must be refused the same way. Both go through `PATCH`; both are asserted against
     * the database directly (never stored) and against each other (identical response), which is
     * the actual concealment property #153 §25 asks for — not merely "some 4xx".
     */
    it('refuses a cross-workspace connection id exactly like a nonexistent one, and stores neither', async () => {
      const crossWorkspace = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModelConnectionId: connectionB,
          defaultModel: 'claude-sonnet-4-5',
        }),
        idContext(projectId),
      );
      const crossWorkspaceBody: unknown = await crossWorkspace.clone().json();
      expect(crossWorkspace.status, JSON.stringify(crossWorkspaceBody)).toBe(400);
      expect(await storedPair()).toEqual({ connectionId: null, model: null });

      const nonexistent = await PATCH(
        req('PATCH', `/api/projects/${projectId}`, workspaceA.id, ownerA.email, {
          defaultModelConnectionId: crypto.randomUUID(),
          defaultModel: 'claude-sonnet-4-5',
        }),
        idContext(projectId),
      );
      const nonexistentBody: unknown = await nonexistent.clone().json();
      expect(nonexistent.status, JSON.stringify(nonexistentBody)).toBe(400);
      expect(await storedPair()).toEqual({ connectionId: null, model: null });

      // The concealment property itself: workspace B's own real id is refused with the exact same
      // status and body as an id that names nothing anywhere. Nothing in the response lets a
      // caller distinguish "exists, but not yours" from "does not exist".
      expect(crossWorkspace.status).toBe(nonexistent.status);
      expect(crossWorkspaceBody).toEqual(nonexistentBody);
    });
  },
);
