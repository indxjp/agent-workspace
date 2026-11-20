/**
 * Fixtures for `team-run.integration.test.ts`: the seeded workspace and team, the production run
 * store over the isolated database, and the run routes with an in-process runtime double.
 */
import { eq } from 'drizzle-orm';

import { installTestRunApi } from '../application-context-fixtures';
import type {
  AgentRef,
  LaunchContext,
  RunApiEnvironment,
  RunPrincipal,
  SessionRef,
} from '../runs/environment';
import { createRepositoryRunStore } from '../runs/repository-store';
import type { RunStore } from '../runs/store';
import { serveMemberTools, type MemberToolsEnvironment } from './member-tools';
import type { AgentTeamVersionRecord } from './wiring';

/** The declared test-only escape to the raw handle and the tables (see `store.test.ts`). */
export type CoreDb = typeof import('@agent-workspace/core/db/unscoped');
export type IsolatedDatabase = Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;

/** The module and the isolated database every fixture works against. */
export interface TeamRunHarness {
  readonly core: CoreDb;
  readonly isolated: IsolatedDatabase;
}

/** The cost each run settles with: the lead's, then each member's, in the smallest unit summed. */
export const COSTS = { lead: '0.125000', writer: '0.250000', critic: '0.062500' } as const;

type MemberName = 'lead' | 'writer' | 'critic';
type AgentPin = { agentId: string; agentVersionId: string };

const MEMBER_TOKEN_TTL_MS = 60_000;
const MEMBER_POLL_INTERVAL_MS = 5;
const WAIT_ATTEMPTS = 400;
const WAIT_STEP_MS = 10;
const PRICE_TABLE_VERSION = '2026-11';

export interface Seeded {
  readonly workspaceId: string;
  readonly person: RunPrincipal;
  readonly agents: Readonly<Record<MemberName, string>>;
  readonly version: AgentTeamVersionRecord;
}

/** Plays the agent of one launched run; `members` calls a member of the lead's team by name. */
export type PlayRun = (
  context: LaunchContext,
  members: (name: string, prompt: string) => Promise<unknown>,
) => Promise<void>;

interface SeededOwner {
  readonly workspaceId: string;
  readonly userId: string;
  readonly principalId: string;
}

/** A workspace and its owner membership, whose trigger creates the owner's principal. */
async function seedOwner({ core, isolated }: TeamRunHarness): Promise<SeededOwner> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  await isolated.db
    .insert(core.workspaces)
    .values({ id: workspaceId, slug: workspaceId, name: 'Team' });
  await isolated.db
    .insert(core.users)
    .values({ id: userId, email: `${userId}@example.com`, name: 'Ada' });
  await isolated.db
    .insert(core.memberships)
    .values({ id: membershipId, workspaceId, userId, role: 'owner' });
  const principal = (await isolated.db.select().from(core.workspacePrincipals)).find(
    (candidate) => candidate.membershipId === membershipId,
  );
  if (principal === undefined) throw new Error('the membership trigger created no principal');
  return { workspaceId, userId, principalId: principal.id };
}

/** One agent with a first version, pinned for a team. */
async function seedAgent(
  { core, isolated }: TeamRunHarness,
  owner: SeededOwner,
  name: MemberName,
): Promise<AgentPin> {
  const agentId = crypto.randomUUID();
  const agentVersionId = crypto.randomUUID();
  await isolated.db.insert(core.agents).values({
    id: agentId,
    workspaceId: owner.workspaceId,
    name,
    instructions: '',
    modelConnectionId: null,
    model: null,
    createdBy: owner.userId,
    ownerPrincipalId: owner.principalId,
    permissions: {
      readFiles: false,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
  });
  await isolated.db.insert(core.agentVersions).values({
    id: agentVersionId,
    workspaceId: owner.workspaceId,
    agentId,
    number: 1,
    summary: 'first',
    via: 'api',
    body: {},
    createdByPrincipalId: owner.principalId,
  });
  return { agentId, agentVersionId };
}

/** A workspace, its owner, three agents with a version each, and a team of them. */
export async function seed(harness: TeamRunHarness): Promise<Seeded> {
  const { core, isolated } = harness;
  const owner = await seedOwner(harness);
  const lead = await seedAgent(harness, owner, 'lead');
  const writer = await seedAgent(harness, owner, 'writer');
  const critic = await seedAgent(harness, owner, 'critic');
  const scope = await core
    .createDatabaseWorkspaceScopeResolver(isolated.db)
    .forWorkspaceId(owner.workspaceId);
  if (scope === null) throw new Error('the seeded workspace did not resolve');
  const created = await core
    .createDatabaseAgentTeamRepositoryProvider(isolated.db)
    .forScope(scope)
    .create({
      name: 'Launch',
      ownerPrincipalId: owner.principalId,
      createdBy: owner.userId,
      version: { lead, members: [writer, critic] },
    });
  if (created.kind !== 'created' || created.team.latestVersion === null)
    throw new Error(created.kind);
  return {
    workspaceId: owner.workspaceId,
    person: {
      principalId: owner.principalId,
      ownerPrincipalId: owner.principalId,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      role: 'owner',
      scope: null,
      via: 'session',
      kind: 'membership',
    },
    agents: { lead: lead.agentId, writer: writer.agentId, critic: critic.agentId },
    version: created.team.latestVersion,
  };
}

export function runStore({ core, isolated }: TeamRunHarness): RunStore {
  return createRepositoryRunStore({
    repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
    events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
    scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
    findRunWorkspace: (id: string): Promise<string | null> =>
      core.findRunWorkspace(isolated.db, id),
  });
}

/** Settle a run as the runtime and the ledger would: priced, with its cost, then `completed`. */
export async function settle(
  { core, isolated }: TeamRunHarness,
  store: RunStore,
  runId: string,
  outcome: { readonly cost: string; readonly text: string },
): Promise<void> {
  const { cost, text } = outcome;
  await isolated.db
    .update(core.runs)
    .set({ costUsd: cost, accountingState: 'complete', priceTableVersion: PRICE_TABLE_VERSION })
    .where(eq(core.runs.id, runId));
  await store.finish(runId, 'completed', null, true, { text, structured: null });
}

function memberCall(leadRunId: string, name: string, prompt: string): Request {
  return new Request(`http://web.test/api/runs/${leadRunId}/members/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer lead:${leadRunId}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { prompt } },
    }),
  });
}

/** Opens a session row for a launched run, or answers `null` when it cannot be read back. */
function sessionOpener({ core, isolated }: TeamRunHarness): RunApiEnvironment['openSession'] {
  const scopes = core.createDatabaseWorkspaceScopeResolver(isolated.db);
  const sessions = core.createDatabaseSessionRepositoryProvider(isolated.db);
  return async (principal, agent, requested, agentVersionId): Promise<SessionRef | null> => {
    if (requested !== null) return { id: requested, agentId: agent.id, engine: null };
    const id = crypto.randomUUID();
    await isolated.db.insert(core.sessions).values({
      id,
      workspaceId: principal.workspaceId,
      userId: principal.userId,
      agentId: agent.id,
      ownerPrincipalId: principal.ownerPrincipalId,
      agentVersionId: agentVersionId ?? null,
    });
    const scope = await scopes.forWorkspaceId(principal.workspaceId);
    if (scope === null || (await sessions.forScope(scope).get(id)) === null) return null;
    return { id, agentId: agent.id, engine: null };
  };
}

/** The member endpoint's environment: the lead is identified by a `Bearer lead:<run id>` token. */
function memberEnvironment(
  { core, isolated }: TeamRunHarness,
  seeded: Seeded,
  runs: RunApiEnvironment,
): MemberToolsEnvironment {
  const scopes = core.createDatabaseWorkspaceScopeResolver(isolated.db);
  return {
    verifyCaller: (authorization) => {
      const runId = /^Bearer lead:(.+)$/u.exec(authorization ?? '')?.[1];
      return Promise.resolve(
        runId === undefined
          ? null
          : {
              runId,
              workspaceId: seeded.workspaceId,
              expiresAtMs: Date.now() + MEMBER_TOKEN_TTL_MS,
              person: seeded.person,
            },
      );
    },
    runs,
    teamVersion: async (workspaceId, versionId) => {
      const scope = await scopes.forWorkspaceId(workspaceId);
      return scope === null
        ? null
        : core
            .createDatabaseAgentTeamRepositoryProvider(isolated.db)
            .forScope(scope)
            .getVersion(versionId);
    },
    mayRunAgent: () => Promise.resolve(true),
    pollIntervalMs: MEMBER_POLL_INTERVAL_MS,
  };
}

/**
 * The run routes over the real store and session rows, with a runtime double: `play` runs the
 * agent of each launched run. The member endpoint is served in-process with the lead's identity.
 */
export function environment(
  harness: TeamRunHarness,
  seeded: Seeded,
  store: RunStore,
  play: PlayRun,
): { env: RunApiEnvironment; settled: Promise<void>[] } {
  const settled: Promise<void>[] = [];
  const env: RunApiEnvironment = {
    authenticate: () => Promise.resolve(seeded.person),
    findAgent: (principal, agentId): Promise<AgentRef | null> =>
      Promise.resolve({
        id: agentId,
        workspaceId: principal.workspaceId,
        engine: 'claude-agent-sdk',
      }),
    openSession: sessionOpener(harness),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: (context) => {
      const members = async (name: string, prompt: string) => {
        const response = await serveMemberTools(
          memberCall(context.run.id, name, prompt),
          context.run.id,
          memberEnv,
        );
        return ((await response.json()) as { result: unknown }).result;
      };
      settled.push(
        (async () => {
          await store.markRunning(context.run.id);
          await play(context, members);
        })(),
      );
    },
    interruptRun: async (_principal, run) => {
      await store.finish(run.id, 'cancelled', 'the run was interrupted by request', true);
    },
  };
  const memberEnv = memberEnvironment(harness, seeded, env);
  installTestRunApi(env);
  return { env, settled };
}

/** Start the team's lead as `POST /api/agent-teams/:id/runs` does: the lead, its version, the team version. */
export async function startLead(seeded: Seeded, env: RunApiEnvironment) {
  const { startRunOnSession } = await import('../runs/service');
  const started = await startRunOnSession(
    env,
    seeded.person,
    { id: seeded.agents.lead, workspaceId: seeded.workspaceId, engine: 'claude-agent-sdk' },
    {
      prompt: 'Write and review the launch note.',
      sessionId: null,
      modelOverride: null,
      agentVersionId: seeded.version.lead.agentVersionId,
      agentTeamVersionId: seeded.version.id,
    },
  );
  if (started.kind !== 'started') throw new Error(started.code);
  return started.run;
}

export async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  throw new Error('the condition was never met');
}
