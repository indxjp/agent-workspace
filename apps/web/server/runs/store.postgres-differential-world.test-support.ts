/**
 * The fixture behind the round 3 differential `listRuns` suite: **one run per predicate, differing
 * from `base` in exactly that predicate's column**, so that each `RunRepository.listRuns`
 * predicate and each `parseRunListQuery` assignment has one named test that fails, on real
 * PostgreSQL, when that predicate or assignment is deleted.
 *
 * Everything is inserted directly, with an explicit `created_at`, rather than through
 * `RunStore.create()`: the fixture is the *data*, and the code under test is the query.
 */
import type { RunStore } from './store';
import { READ_ONLY_PERMISSIONS, type RunDatabase } from './store.postgres.test-support';

/** Every run in the fixture workspace, keyed by the one thing that sets it apart. */
export type Difference =
  | 'base'
  | 'otherUser'
  | 'otherAgent'
  | 'otherProject'
  | 'otherStatus'
  | 'otherProvider'
  | 'otherModel'
  | 'earlier'
  | 'later';

export const everyDifference: readonly Difference[] = [
  'base',
  'otherUser',
  'otherAgent',
  'otherProject',
  'otherStatus',
  'otherProvider',
  'otherModel',
  'earlier',
  'later',
];

export interface DifferentialFixture {
  readonly store: RunStore;
  readonly workspaceId: string;
  /** `base`'s initiating user; an Owner of the workspace (grant `any`). */
  readonly ownerId: string;
  /** `base`'s exact session-owning workspace principal. */
  readonly ownerPrincipalId: string;
  /** `otherUser`'s initiating user; a Builder of the workspace (grant `own`). */
  readonly builderId: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly model: string;
  /** `base`'s `created_at`; `earlier` is an hour before it and `later` an hour after. */
  readonly t0: Date;
  readonly runs: Readonly<Record<Difference, string>>;
  /** A run in another workspace with every column equal to `base`'s. */
  readonly otherWorkspaceRun: string;
}

const newId = (): string => crypto.randomUUID();
const HOUR_MS = 3_600_000;

function differentialIds() {
  return {
    workspaceId: newId(),
    otherWorkspaceId: newId(),
    ownerId: newId(),
    builderId: newId(),
    otherWorkspaceUserId: newId(),
    agentId: newId(),
    otherAgentId: newId(),
    otherWorkspaceAgentId: newId(),
    projectId: newId(),
    otherProjectId: newId(),
    session: {
      base: newId(),
      otherUser: newId(),
      otherAgent: newId(),
      otherProject: newId(),
      otherWorkspace: newId(),
    },
  };
}

type Ids = ReturnType<typeof differentialIds>;

interface Principals {
  readonly ownerPrincipalId: string;
  readonly builderPrincipalId: string;
  readonly otherWorkspacePrincipalId: string;
}

async function seedPeople(database: RunDatabase, ids: Ids): Promise<Principals> {
  const { db, core } = database;
  await db.insert(core.workspaces).values([
    { id: ids.workspaceId, slug: ids.workspaceId, name: 'Differential' },
    { id: ids.otherWorkspaceId, slug: ids.otherWorkspaceId, name: 'Differential (other)' },
  ]);
  const user = (id: string, name: string) => ({ id, email: `${id}@example.com`, name });
  await db
    .insert(core.users)
    .values([
      user(ids.ownerId, 'Owner'),
      user(ids.builderId, 'Builder'),
      user(ids.otherWorkspaceUserId, 'X'),
    ]);
  return {
    ownerPrincipalId: await database.createMembershipPrincipal(ids.workspaceId, ids.ownerId),
    builderPrincipalId: await database.createMembershipPrincipal(
      ids.workspaceId,
      ids.builderId,
      'builder',
    ),
    otherWorkspacePrincipalId: await database.createMembershipPrincipal(
      ids.otherWorkspaceId,
      ids.otherWorkspaceUserId,
    ),
  };
}

async function seedAgentsAndProjects(
  database: RunDatabase,
  ids: Ids,
  principals: Principals,
): Promise<void> {
  const { db, core } = database;
  const agent = (id: string, workspaceId: string, name: string, userId: string, owner: string) => ({
    id,
    workspaceId,
    name,
    instructions: '',
    createdBy: userId,
    ownerPrincipalId: owner,
    permissions: READ_ONLY_PERMISSIONS,
  });
  await db
    .insert(core.agents)
    .values([
      agent(ids.agentId, ids.workspaceId, 'A', ids.ownerId, principals.ownerPrincipalId),
      agent(ids.otherAgentId, ids.workspaceId, 'B', ids.ownerId, principals.ownerPrincipalId),
      agent(
        ids.otherWorkspaceAgentId,
        ids.otherWorkspaceId,
        'X',
        ids.otherWorkspaceUserId,
        principals.otherWorkspacePrincipalId,
      ),
    ]);
  const project = (id: string, name: string) => ({
    id,
    workspaceId: ids.workspaceId,
    name,
    createdBy: ids.ownerId,
    ownerPrincipalId: principals.ownerPrincipalId,
  });
  await db
    .insert(core.projects)
    .values([project(ids.projectId, 'P'), project(ids.otherProjectId, 'Q')]);
}

/**
 * Four sessions in the workspace, each differing from `base`'s in exactly one column the join
 * reaches: the initiating user, the agent, or the project. A fifth is in the other workspace.
 */
async function seedSessions(
  database: RunDatabase,
  ids: Ids,
  principals: Principals,
): Promise<void> {
  const { db, core } = database;
  const inWorkspace = {
    workspaceId: ids.workspaceId,
    userId: ids.ownerId,
    agentId: ids.agentId,
    projectId: ids.projectId,
    ownerPrincipalId: principals.ownerPrincipalId,
  };
  await db.insert(core.sessions).values([
    { ...inWorkspace, id: ids.session.base },
    {
      ...inWorkspace,
      id: ids.session.otherUser,
      userId: ids.builderId,
      ownerPrincipalId: principals.builderPrincipalId,
    },
    { ...inWorkspace, id: ids.session.otherAgent, agentId: ids.otherAgentId },
    { ...inWorkspace, id: ids.session.otherProject, projectId: ids.otherProjectId },
    {
      id: ids.session.otherWorkspace,
      workspaceId: ids.otherWorkspaceId,
      userId: ids.otherWorkspaceUserId,
      agentId: ids.otherWorkspaceAgentId,
      ownerPrincipalId: principals.otherWorkspacePrincipalId,
    },
  ]);
}

async function seedRuns(
  database: RunDatabase,
  ids: Ids,
  model: string,
  t0: Date,
): Promise<{ runs: Record<Difference, string>; otherWorkspaceRun: string }> {
  const { db, core } = database;
  const runs = Object.fromEntries(
    everyDifference.map((difference) => [difference, newId()]),
  ) as Record<Difference, string>;
  const otherWorkspaceRun = newId();
  // `base`, verbatim; every other row below restates it with one column changed.
  const base = {
    workspaceId: ids.workspaceId,
    sessionId: ids.session.base,
    status: 'failed' as const,
    error: 'boom',
    endedAt: t0,
    provider: 'openai' as const,
    model,
    createdAt: t0,
  };
  await db.insert(core.runs).values([
    { ...base, id: runs.base },
    { ...base, id: runs.otherUser, sessionId: ids.session.otherUser },
    { ...base, id: runs.otherAgent, sessionId: ids.session.otherAgent },
    { ...base, id: runs.otherProject, sessionId: ids.session.otherProject },
    // `queued`: the one status change the `runs_ended_at_iff_terminal` check lets stand
    // without also moving `ended_at`, which it then requires to be null.
    { ...base, id: runs.otherStatus, status: 'queued', error: null, endedAt: null },
    { ...base, id: runs.otherProvider, provider: 'anthropic' },
    { ...base, id: runs.otherModel, model: newId() },
    { ...base, id: runs.earlier, createdAt: new Date(t0.getTime() - HOUR_MS) },
    { ...base, id: runs.later, createdAt: new Date(t0.getTime() + HOUR_MS) },
    {
      ...base,
      id: otherWorkspaceRun,
      workspaceId: ids.otherWorkspaceId,
      sessionId: ids.session.otherWorkspace,
    },
  ]);
  return { runs, otherWorkspaceRun };
}

export async function seedDifferentialFixture(database: RunDatabase): Promise<DifferentialFixture> {
  const ids = differentialIds();
  const model = newId();
  const t0 = new Date('2026-03-01T12:00:00.000Z');
  const principals = await seedPeople(database, ids);
  await seedAgentsAndProjects(database, ids, principals);
  await seedSessions(database, ids, principals);
  const { runs, otherWorkspaceRun } = await seedRuns(database, ids, model, t0);
  return {
    store: database.makeStore(),
    workspaceId: ids.workspaceId,
    ownerId: ids.ownerId,
    ownerPrincipalId: principals.ownerPrincipalId,
    builderId: ids.builderId,
    agentId: ids.agentId,
    projectId: ids.projectId,
    model,
    t0,
    runs,
    otherWorkspaceRun,
  };
}
