/** Project archival fixtures use real user ids for ownership and audit foreign keys. */
import crypto from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

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

import { createPostgresDirectory } from '../../../../../server/rbac/postgres-directory';

import { Principal } from '../../../../../server/rbac/principal';

import type { Role } from '../../../../../server/rbac/core/roles';

import { clearApplicationContext } from '../../../../../server/application-context';

import { installTestDomains } from '../../../../../server/application-context-fixtures';
export const WORKSPACE_HEADER = 'x-test-workspace';

export const ACTOR_HEADER = 'x-test-actor';

export const workspaceA = { id: crypto.randomUUID(), slug: 'w9-183-a', name: 'Workspace A' };

export const workspaceB = { id: crypto.randomUUID(), slug: 'w9-183-b', name: 'Workspace B' };

export const ownerA = { id: crypto.randomUUID(), email: 'owner-a@example.test', name: 'Owner A' };

export const creator = {
  id: crypto.randomUUID(),
  email: 'creator@example.test',
  name: 'Creator Builder',
};

export const otherBuilder = {
  id: crypto.randomUUID(),
  email: 'other@example.test',
  name: 'Other Builder',
};

export const adminA = { id: crypto.randomUUID(), email: 'admin-a@example.test', name: 'Admin A' };

export const viewerA = {
  id: crypto.randomUUID(),
  email: 'viewer-a@example.test',
  name: 'Viewer A',
};

export const ownerB = { id: crypto.randomUUID(), email: 'owner-b@example.test', name: 'Owner B' };

export const PRINCIPAL_IDS = {
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

const ACTORS = [
  {
    user: ownerA,
    workspace: workspaceA,
    role: 'owner',
    membershipId: MEMBERSHIP_IDS.ownerA,
    principalId: PRINCIPAL_IDS.ownerA,
  },
  {
    user: creator,
    workspace: workspaceA,
    role: 'builder',
    membershipId: MEMBERSHIP_IDS.creator,
    principalId: PRINCIPAL_IDS.creator,
  },
  {
    user: otherBuilder,
    workspace: workspaceA,
    role: 'builder',
    membershipId: MEMBERSHIP_IDS.otherBuilder,
    principalId: PRINCIPAL_IDS.otherBuilder,
  },
  {
    user: adminA,
    workspace: workspaceA,
    role: 'admin',
    membershipId: MEMBERSHIP_IDS.adminA,
    principalId: PRINCIPAL_IDS.adminA,
  },
  {
    user: viewerA,
    workspace: workspaceA,
    role: 'viewer',
    membershipId: MEMBERSHIP_IDS.viewerA,
    principalId: PRINCIPAL_IDS.viewerA,
  },
  {
    user: ownerB,
    workspace: workspaceB,
    role: 'owner',
    membershipId: MEMBERSHIP_IDS.ownerB,
    principalId: PRINCIPAL_IDS.ownerB,
  },
] satisfies readonly {
  user: typeof ownerA;
  workspace: typeof workspaceA;
  role: Role;
  membershipId: string;
  principalId: string;
}[];

function principalIdFor(actor: string): string {
  const fixture = ACTORS.find(({ user }) => user.id === actor);
  if (fixture === undefined) throw new Error('no principal fixture for actor ' + actor);
  return fixture.principalId;
}
const ROLES = new Map<string, Role>(ACTORS.map(({ user, role }) => [user.id, role]));

export const STRANGER = crypto.randomUUID();

function req(url: string, workspaceId: string | null, actor: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (workspaceId !== null) headers.set(WORKSPACE_HEADER, workspaceId);
  if (actor !== null) headers.set(ACTOR_HEADER, actor);
  return new Request(`https://example.invalid${url}`, { method: 'POST', headers });
}

export function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

interface Problem {
  readonly status: number;
  readonly body: unknown;
}

export async function asProblem(response: Response): Promise<Problem> {
  return { status: response.status, body: await response.json() };
}

export function createScopedFixture() {
  return new ProjectLifecycleFixture();
}

class ProjectLifecycleFixture {
  constructor() {
    beforeAll(() => this.setup(), 180_000);
    afterAll(() => this.teardown());
    beforeEach(() => this.reset());
    afterEach(() => clearApplicationContext());
  }

  private isolatedValue: IsolatedTestDatabase | undefined;
  private get isolated(): IsolatedTestDatabase {
    if (this.isolatedValue === undefined) throw new Error('database not initialized');
    return this.isolatedValue;
  }

  private rootValue: DatabaseRoot | undefined;
  get root(): DatabaseRoot {
    if (this.rootValue === undefined) throw new Error('database root not initialized');
    return this.rootValue;
  }

  agentId = '';

  /** A fresh project in workspace A, created by `creator`, for every test. */
  projectId = '';

  private async setup() {
    this.isolatedValue = await createIsolatedTestDatabase('aw_w9_proj_183_lifecycle');
    await this.isolated.db.insert(workspaces).values([workspaceA, workspaceB]);
    await this.isolated.db
      .insert(users)
      .values([ownerA, creator, otherBuilder, adminA, viewerA, ownerB]);
    await this.isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values(
        ACTORS.map(({ user, workspace, membershipId, role }) => ({
          id: membershipId,
          workspaceId: workspace.id,
          userId: user.id,
          role,
        })),
      );
      await tx.insert(workspacePrincipals).values(
        ACTORS.map(({ workspace, membershipId, principalId }) => ({
          id: principalId,
          workspaceId: workspace.id,
          kind: 'membership' as const,
          membershipId,
        })),
      );
    });
    this.rootValue = await openDatabaseRoot({ DATABASE_URL: this.isolated.url });

    const scopeA = await this.workspaceScope(workspaceA.id);
    const agent = await this.root.agents.forScope(scopeA).create({
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
    this.agentId = agent.agent.id;
  }

  private async teardown() {
    await this.root.close();
    await this.isolated.close();
  }

  private installProjects() {
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
          const scope = await this.workspaceScope(workspaceId);
          return {
            projects: this.root.projects.forScope(scope),
            files: this.root.projectFiles.forScope(scope),
            mcpServers: this.root.projectMcpServers.forScope(scope),
            audit: this.root.auditEventRepository.forScope(scope),
            agents: this.root.agents.forScope(scope),
            sessions: this.root.sessions.forScope(scope),
            agentVersions: this.root.agentVersions.forScope(scope),
          };
        },
      },
    });
  }

  private installAuthorisation() {
    installTestDomains({
      rbac: {
        directory: createPostgresDirectory(this.root.directory),
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
  }

  private async reset() {
    this.installProjects();
    this.installAuthorisation();
    const scopeA = await this.workspaceScope(workspaceA.id);
    const project = await this.root.projects.forScope(scopeA).create({
      name: `Project ${crypto.randomUUID()}`,
      visibility: 'private',
      createdBy: creator.id,
      ownerPrincipalId: PRINCIPAL_IDS.creator,
    });
    this.projectId = project.id;
  }

  private async workspaceScope(workspaceId: string) {
    const scope = await this.root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error(`fixture workspace ${workspaceId} did not resolve`);
    return scope;
  }

  /** The row's own column, read directly — independent of what any route reports. */
  async storedArchivedAt(id = this.projectId): Promise<Date | null> {
    const scopeA = await this.workspaceScope(workspaceA.id);
    const row = await this.root.projects.forScope(scopeA).get(id);
    if (row === null) throw new Error('fixture project disappeared');
    return row.archivedAt;
  }

  /** Every audit row about this test's project, in workspace A. */
  async auditRows(): Promise<readonly { action: string; actorUserId: string | null }[]> {
    const scopeA = await this.workspaceScope(workspaceA.id);
    return (
      await this.root.auditEventRepository.forScope(scopeA).list({ limit: 500 })
    ).items.filter((row) => row.subjectId === this.projectId);
  }

  /**
   * Workspace A's total audit-row count — the unfiltered read `auditRows` narrows. Rows
   * accumulate across the cases in this file, so this is only meaningful as a difference taken
   * around the requests under test, never as an absolute.
   */
  async auditCount(): Promise<number> {
    const scopeA = await this.workspaceScope(workspaceA.id);
    return this.root.auditEventRepository.forScope(scopeA).count();
  }

  archive(actor: string | null, id = this.projectId, workspaceId = workspaceA.id) {
    return ARCHIVE(req(`/api/projects/${id}/archive`, workspaceId, actor), idContext(id));
  }

  restore(actor: string | null, id = this.projectId, workspaceId = workspaceA.id) {
    return RESTORE(req(`/api/projects/${id}/restore`, workspaceId, actor), idContext(id));
  }
}
