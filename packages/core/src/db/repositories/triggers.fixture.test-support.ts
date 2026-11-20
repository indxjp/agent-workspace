import crypto from 'node:crypto';

import { afterAll, beforeAll } from 'vitest';

import { agents } from '../schema/agents.js';
import { memberships } from '../schema/memberships.js';
import { runs } from '../schema/runs.js';
import { sessions } from '../schema/sessions.js';
import { users } from '../schema/users.js';
import { workspacePrincipals } from '../schema/workspace-principals.js';
import { workspaces } from '../schema/workspaces.js';
import { createDatabaseWorkspaceScopeResolver } from './scope.js';
import { createIsolatedTestDatabase, type IsolatedTestDatabase } from './testing.js';
import { postgresViolations } from './violations.js';
import { createDatabaseTriggerRepositoryProvider, type NewTriggerInput } from './triggers.js';

export const sha256Hex = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

/** The names of the constraints a refused statement violated; fails if it was not refused. */
export async function violationOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    return [...postgresViolations(error)].map((violation) => violation.constraint);
  }
  throw new Error('expected the statement to be refused');
}

const permissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const fixtureIds = () => ({
  workspaceId: crypto.randomUUID(),
  otherWorkspaceId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  otherUserId: crypto.randomUUID(),
  principalId: crypto.randomUUID(),
  otherPrincipalId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  otherAgentId: crypto.randomUUID(),
  otherRunId: crypto.randomUUID(),
});

type FixtureIds = ReturnType<typeof fixtureIds>;

/** Two workspaces, each with an owner principal and an agent, and one run in the other one. */
async function seedTenants(isolated: IsolatedTestDatabase, ids: FixtureIds): Promise<void> {
  const { db } = isolated;
  const { workspaceId, otherWorkspaceId, userId, otherUserId, principalId, otherPrincipalId } = ids;
  await db.insert(workspaces).values([
    { id: workspaceId, slug: workspaceId, name: 'Triggers' },
    { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Other' },
  ]);
  await db
    .insert(users)
    .values([userId, otherUserId].map((id) => ({ id, email: `${id}@example.com`, name: 'Owner' })));
  for (const [workspace, principal] of [
    [workspaceId, principalId],
    [otherWorkspaceId, otherPrincipalId],
  ] as const) {
    const membershipId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, workspaceId: workspace, userId, role: 'owner' });
      await tx.insert(workspacePrincipals).values({
        id: principal,
        workspaceId: workspace,
        kind: 'membership',
        membershipId,
      });
    });
  }
  await db.insert(agents).values(
    (
      [
        [ids.agentId, workspaceId, principalId],
        [ids.otherAgentId, otherWorkspaceId, otherPrincipalId],
      ] as const
    ).map(([id, workspace, owner]) => ({
      id,
      workspaceId: workspace,
      name: `agent ${id}`,
      instructions: '',
      ownerPrincipalId: owner,
      createdBy: userId,
      permissions,
    })),
  );
  const otherSessionId = crypto.randomUUID();
  await db.insert(sessions).values({
    id: otherSessionId,
    workspaceId: otherWorkspaceId,
    userId,
    ownerPrincipalId: otherPrincipalId,
    agentId: ids.otherAgentId,
  });
  await db
    .insert(runs)
    .values({ id: ids.otherRunId, workspaceId: otherWorkspaceId, sessionId: otherSessionId });
}

/** Registers the database lifecycle hooks and returns the seeded ids and trigger builders. */
export function createTriggerFixture() {
  let isolated: IsolatedTestDatabase | undefined;
  const ids = fixtureIds();
  const { workspaceId, userId, principalId, agentId } = ids;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_triggers');
    await seedTenants(isolated, ids);
  }, 180_000);

  afterAll(async () => isolated?.close());

  const database = (): IsolatedTestDatabase => {
    if (isolated === undefined) throw new Error('the test database is not ready');
    return isolated;
  };

  async function triggersFor(workspace: string) {
    const scope = await createDatabaseWorkspaceScopeResolver(database().db).forWorkspaceId(
      workspace,
    );
    if (scope === null) throw new Error('workspace did not resolve');
    return createDatabaseTriggerRepositoryProvider(database().db).forScope(scope);
  }

  const webhook = (
    name: string,
    secret = 's3cret',
  ): Extract<NewTriggerInput, { kind: 'webhook' }> => ({
    kind: 'webhook',
    name,
    agentId,
    promptTemplate: 'Handle: {{body}}',
    ownerPrincipalId: principalId,
    secretHash: sha256Hex(secret),
  });

  const schedule = (name: string): NewTriggerInput => ({
    kind: 'schedule',
    name,
    agentId,
    promptTemplate: 'Daily report',
    ownerPrincipalId: principalId,
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Tokyo',
  });

  async function created(input: NewTriggerInput, workspace = workspaceId) {
    const outcome = await (await triggersFor(workspace)).create(input);
    if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
    return outcome.trigger;
  }

  /** Insert a session and a run of the given status in the primary workspace; return the run id. */
  async function runOf(status: 'queued' | 'running' | 'completed') {
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await database().db.insert(sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      ownerPrincipalId: principalId,
      agentId,
    });
    await database()
      .db.insert(runs)
      .values({
        id: runId,
        workspaceId,
        sessionId,
        status,
        ...(status === 'completed' ? { endedAt: new Date() } : {}),
      });
    return runId;
  }

  return {
    ...ids,
    permissions,
    get isolated() {
      return database();
    },
    triggersFor,
    webhook,
    schedule,
    created,
    runOf,
  };
}

export type TriggerFixture = ReturnType<typeof createTriggerFixture>;
