import crypto from 'node:crypto';

import { afterAll, beforeAll, expect } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { projects } from '../schema/projects.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import {
  createDatabaseProjectRepositoryProvider,
  type ProjectRecord,
  type ProjectRepository,
} from './projects.js';
import { createDatabaseWorkspaceScopeResolver, type WorkspaceScope } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';

/** Narrow a nullable repository answer without a non-null assertion, failing the test if it is null. */
export function expectProject(project: ProjectRecord | null): ProjectRecord {
  expect(project).not.toBeNull();
  if (project === null) throw new Error('expected the repository to return a project row');
  return project;
}

const fixtureIds = () => ({
  workspaceId: crypto.randomUUID(),
  otherWorkspaceId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  membershipId: crypto.randomUUID(),
  otherMembershipId: crypto.randomUUID(),
  principalId: crypto.randomUUID(),
  otherPrincipalId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  otherWorkspaceProjectId: crypto.randomUUID(),
});

/** Two tenants, one owner, one agent and a project in the other tenant. */
async function seedTenants(
  isolated: IsolatedTestDatabase,
  ids: ReturnType<typeof fixtureIds>,
): Promise<void> {
  const { workspaceId, otherWorkspaceId, userId, membershipId, otherMembershipId } = ids;
  const { principalId, otherPrincipalId } = ids;
  await isolated.db.insert(workspaces).values([
    { id: workspaceId, slug: 'projects-lifecycle', name: 'Projects Lifecycle' },
    { id: otherWorkspaceId, slug: 'projects-lifecycle-other', name: 'Other Tenant' },
  ]);
  await isolated.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await isolated.db.transaction(async (tx) => {
    await tx.insert(memberships).values([
      { id: membershipId, workspaceId, userId, role: 'owner' },
      { id: otherMembershipId, workspaceId: otherWorkspaceId, userId, role: 'owner' },
    ]);
    await tx.insert(workspacePrincipals).values([
      { id: principalId, workspaceId, kind: 'membership', membershipId },
      {
        id: otherPrincipalId,
        workspaceId: otherWorkspaceId,
        kind: 'membership',
        membershipId: otherMembershipId,
      },
    ]);
  });
  await isolated.db.insert(agents).values({
    id: ids.agentId,
    workspaceId,
    name: 'Lifecycle agent',
    instructions: '',
    ownerPrincipalId: principalId,
    createdBy: userId,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  await isolated.db.insert(projects).values({
    id: ids.otherWorkspaceProjectId,
    workspaceId: otherWorkspaceId,
    name: 'Other tenant project',
    ownerPrincipalId: otherPrincipalId,
    createdBy: userId,
  });
}

/** Resolve a fixture workspace's scope, failing the test if it does not resolve. */
async function resolveScope(isolated: IsolatedTestDatabase, id: string): Promise<WorkspaceScope> {
  const scope = await createDatabaseWorkspaceScopeResolver(isolated.db).forWorkspaceId(id);
  if (scope === null) throw new Error('fixture workspace did not resolve');
  return scope;
}

export type ProjectFixture = ReturnType<typeof createProjectFixture>;

/** The seeded tenants and the fixture workspace's `ProjectRepository`; registers its own hooks. */
export function createProjectFixture() {
  let isolated: IsolatedTestDatabase;
  let repository: ProjectRepository;
  const ids = fixtureIds();
  const { workspaceId, userId, principalId } = ids;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_projects_lifecycle');
    await seedTenants(isolated, ids);
    const scope = await resolveScope(isolated, workspaceId);
    repository = createDatabaseProjectRepositoryProvider(isolated.db).forScope(scope);
  }, 180_000);

  afterAll(async () => isolated.close());

  /** A fresh project per test: `projects_workspace_name_key` makes the name the isolation. */
  async function createProject(label: string): Promise<ProjectRecord> {
    return repository.create({
      name: `${label}-${crypto.randomUUID()}`,
      ownerPrincipalId: principalId,
      createdBy: userId,
      instructions: null,
      defaultAgentId: null,
      visibility: 'private',
      defaultModelConnectionId: null,
      defaultModel: null,
    });
  }

  /** A session of the fixture agent attributed to `projectId`; answers its id. */
  async function seedSession(projectId: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    await isolated.db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId: ids.agentId,
      projectId,
    });
    return sessionId;
  }

  return {
    get isolated() {
      return isolated;
    },
    get repository() {
      return repository;
    },
    workspaceId,
    userId,
    principalId,
    otherWorkspaceProjectId: ids.otherWorkspaceProjectId,
    scopeFor: (id: string) => resolveScope(isolated, id),
    createProject,
    seedSession,
  };
}
