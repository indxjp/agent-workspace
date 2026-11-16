/**
 * The two-workspace fixture behind the issue #135 `listRuns` attribution test: an Acme workspace
 * with an Owner, a Builder, two projects and an agent, and a Bravo workspace whose runs must never
 * appear in Acme's list.
 */
import { READ_ONLY_PERMISSIONS, type RunDatabase } from './store.postgres.test-support';

const newId = (): string => crypto.randomUUID();

function listWorldIds() {
  return {
    acmeId: newId(),
    bravoId: newId(),
    ownerId: newId(),
    builderId: newId(),
    bravoUserId: newId(),
    agentId: newId(),
    bravoAgentId: newId(),
    projectId: newId(),
    otherProjectId: newId(),
    ownerSessionId: newId(),
    builderSessionId: newId(),
    bravoSessionId: newId(),
    modelConnectionId: newId(),
  };
}

type ListIds = ReturnType<typeof listWorldIds>;

interface Principals {
  readonly ownerPrincipalId: string;
  readonly builderPrincipalId: string;
  readonly bravoPrincipalId: string;
}

export interface ListWorld extends ListIds, Pick<Principals, 'ownerPrincipalId'> {
  /**
   * A session of the owner's, attributed exactly as `ownerSessionId` is. A session takes one run
   * at a time, so every run of the owner's gets a session of its own.
   */
  ownerSession(): Promise<string>;
}

async function seedPeople(database: RunDatabase, ids: ListIds): Promise<Principals> {
  const { db, core } = database;
  await db.insert(core.workspaces).values([
    { id: ids.acmeId, slug: ids.acmeId, name: 'Acme (list)' },
    { id: ids.bravoId, slug: ids.bravoId, name: 'Bravo (list)' },
  ]);
  await db.insert(core.users).values([
    { id: ids.ownerId, email: `${ids.ownerId}@example.com`, name: 'Owner' },
    { id: ids.builderId, email: `${ids.builderId}@example.com`, name: 'Builder' },
    { id: ids.bravoUserId, email: `${ids.bravoUserId}@example.com`, name: 'Bravo user' },
  ]);
  return {
    ownerPrincipalId: await database.createMembershipPrincipal(ids.acmeId, ids.ownerId),
    builderPrincipalId: await database.createMembershipPrincipal(
      ids.acmeId,
      ids.builderId,
      'builder',
    ),
    bravoPrincipalId: await database.createMembershipPrincipal(ids.bravoId, ids.bravoUserId),
  };
}

async function seedAgentsAndProjects(
  database: RunDatabase,
  ids: ListIds,
  principals: Principals,
): Promise<void> {
  const { db, core } = database;
  const permissions = READ_ONLY_PERMISSIONS;
  await db.insert(core.agents).values([
    {
      id: ids.agentId,
      workspaceId: ids.acmeId,
      name: 'List agent',
      instructions: '',
      createdBy: ids.ownerId,
      ownerPrincipalId: principals.ownerPrincipalId,
      permissions,
    },
    {
      id: ids.bravoAgentId,
      workspaceId: ids.bravoId,
      name: 'Bravo agent',
      instructions: '',
      createdBy: ids.bravoUserId,
      ownerPrincipalId: principals.bravoPrincipalId,
      permissions,
    },
  ]);
  const project = (id: string, name: string) => ({
    id,
    workspaceId: ids.acmeId,
    name,
    createdBy: ids.ownerId,
    ownerPrincipalId: principals.ownerPrincipalId,
  });
  await db
    .insert(core.projects)
    .values([project(ids.projectId, 'List project'), project(ids.otherProjectId, 'Other project')]);
}

async function seedSessions(
  database: RunDatabase,
  ids: ListIds,
  principals: Principals,
): Promise<void> {
  const { db, core } = database;
  await db.insert(core.sessions).values([
    {
      id: ids.ownerSessionId,
      workspaceId: ids.acmeId,
      userId: ids.ownerId,
      agentId: ids.agentId,
      projectId: ids.projectId,
      ownerPrincipalId: principals.ownerPrincipalId,
    },
    {
      id: ids.builderSessionId,
      workspaceId: ids.acmeId,
      userId: ids.builderId,
      agentId: ids.agentId,
      projectId: ids.otherProjectId,
      ownerPrincipalId: principals.builderPrincipalId,
    },
    {
      id: ids.bravoSessionId,
      workspaceId: ids.bravoId,
      userId: ids.bravoUserId,
      agentId: ids.bravoAgentId,
      ownerPrincipalId: principals.bravoPrincipalId,
    },
  ]);
}

export async function seedListWorld(database: RunDatabase): Promise<ListWorld> {
  const ids = listWorldIds();
  const principals = await seedPeople(database, ids);
  await seedAgentsAndProjects(database, ids, principals);
  await seedSessions(database, ids, principals);
  const { db, core } = database;
  await db.insert(core.modelConnections).values({
    id: ids.modelConnectionId,
    workspaceId: ids.acmeId,
    name: 'List fixture connection',
    provider: 'openai',
    config: {},
  });

  const ownerSession = async (): Promise<string> => {
    const id = newId();
    await db.insert(core.sessions).values({
      id,
      workspaceId: ids.acmeId,
      userId: ids.ownerId,
      agentId: ids.agentId,
      projectId: ids.projectId,
      ownerPrincipalId: principals.ownerPrincipalId,
    });
    return id;
  };
  return { ...ids, ownerPrincipalId: principals.ownerPrincipalId, ownerSession };
}
