/**
 * What the store's visitor pages (`/runs`, `/runs/:id`, `/chat`) read from the platform, proved
 * through the real route files: `GET /api/runs`, `GET /api/runs/:id`, `GET /api/demo/allowance` and
 * `POST /api/agents/:id/runs`, called as two guests of two different demo workspaces.
 *
 * The pages call these from the visitor's browser with the visitor's own session, so the only
 * isolation they have is the platform's. Each case reads the store back where it can, so a status
 * is never the only evidence.
 */
import { DemoAllowanceSchema } from '@indx-workspace/contracts/demo';
import { afterEach, describe, expect, it } from 'vitest';

import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { GET as allowanceRoute } from '../../app/api/demo/allowance/route';
import { GET as readRunRoute } from '../../app/api/runs/[id]/route';
import { GET as listRunsRoute } from '../../app/api/runs/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, resetTestRunApi } from '../application-context-fixtures';
import { fixedClock } from '../clock';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import { install as installRunApi } from '../runs/api.test-support';
import { MemoryDemoRunAdmissions } from './caps/adapters/admissions/memory';
import { MemoryDemoSpend } from './caps/adapters/spend/memory';
import { createDemoAllowance } from './caps/transport/allowance';
import { createDemoRunGate } from './caps/transport/gate';

const SECRET = 'a-store-visitor-pages-secret-that-is-long-enough';
const NOW = '2026-11-16T09:00:00.000Z';
const HOUR_MS = 3_600_000;
const AGENT = '33333333-3333-4333-8333-333333333333';
const PER_DAY = 20;

interface Visitor extends RunPrincipal {
  readonly header: string;
  readonly userId: string;
  readonly workspaceId: string;
}
const visitor = (header: string, digit: string): Visitor => ({
  header,
  principalId: digit.repeat(8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ownerPrincipalId: digit.repeat(8) + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: digit.repeat(8) + '-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workspaceId: digit.repeat(8) + '-cccc-4ccc-8ccc-cccccccccccc',
  role: 'guest',
  scope: null,
});
const A = visitor('a', '1');
const B = visitor('b', '2');
const visitors = [A, B];
/** A demo workspace whose end has passed. */
const ENDED = visitor('ended', '3');

const asVisitor = (request: Request): Visitor | undefined =>
  [...visitors, ENDED].find((v) => v.header === request.headers.get('x-visitor'));

async function sessionPrincipal(v: Visitor): Promise<Principal> {
  const { mintSignInSessionToken, newEmailLinkSignInSessionClaims, verifySignInSessionToken } =
    await import('../auth/session');
  const token = await mintSignInSessionToken(
    newEmailLinkSignInSessionClaims('v@example.test', 'slug'),
    SECRET,
  );
  const verified = await verifySignInSessionToken(token, SECRET);
  if (!verified.ok) throw new Error('fixture token did not verify');
  const built = Principal.fromSession(
    verified.claims,
    { id: v.workspaceId, slug: 'slug' },
    'guest',
    { principalId: v.principalId, userId: v.userId, label: 'Guest' },
  );
  if (!built.ok) throw new Error(built.because);
  return built.principal;
}

const AGENT_INPUT = {
  name: 'Support',
  instructions: '',
  modelConnectionId: null,
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
} as const;
const PROVISIONER = { principalId: '99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: null };

/** Each demo workspace holds the demo agent, made by the provisioner and granted to its guest. */
async function demoAgents() {
  const agents = createInMemoryAgentStoreProvider({ newId: () => AGENT });
  for (const v of [...visitors, ENDED]) {
    await agents.forWorkspace(v.workspaceId).create(AGENT_INPUT, PROVISIONER);
  }
  return {
    agents,
    resolveWorkspace: () => Promise.reject(new Error('the agents routes are not under test')),
    agentGrants: {
      forWorkspace: () => ({ hasGrant: () => Promise.resolve(true) }),
    },
  };
}

async function wire() {
  const clock = fixedClock(NOW);
  const admissions = new MemoryDemoRunAdmissions();
  const demoExpiresAt = (workspaceId: string) =>
    Promise.resolve(
      new Date(
        clock.now().getTime() + (workspaceId === ENDED.workspaceId ? -HOUR_MS : 2 * HOUR_MS),
      ),
    );
  const gate = createDemoRunGate({
    settings: {
      runsPerPersonPerDay: PER_DAY,
      runsPerClientPerDay: 60,
      maxTurnsPerRun: 8,
      maxCostPerRunUsd: 0.5,
      siteMaxCostPerDayUsd: 30,
    },
    admissions,
    spend: new MemoryDemoSpend(),
    clock,
    demoExpiresAt,
    clientOf: (_headers, limit) => ({ key: 'shared', limit }),
  });
  const runs = installRunApi({
    authenticate: (request) => Promise.resolve(asVisitor(request) ?? null),
    ownsRun: (principal, run) =>
      Promise.resolve(run.ownerPrincipalId === principal.ownerPrincipalId),
    demoRunGate: gate,
  });
  installTestDomains({
    agents: (await demoAgents()) as never,
    rbac: {
      directory: createMemoryDirectory(),
      identify: async (request) => {
        const v = asVisitor(request);
        return v === undefined ? null : sessionPrincipal(v);
      },
    },
    store: {
      baseUrl: null,
      privacy: { leadRetentionDays: null, demoWorkspaceHours: 24 },
      leads: null,
      allowance: createDemoAllowance({
        runsPerPersonPerDay: PER_DAY,
        admissions,
        demoExpiresAt,
        clock,
      }),
    },
  });
  return runs.store;
}

const call = (path: string, as: Visitor | null, init: RequestInit = {}) =>
  new Request(`https://platform.example.test${path}`, {
    ...init,
    headers: { ...(as === null ? {} : { 'x-visitor': as.header }), ...init.headers },
  });

async function seed(store: InMemoryRunStore, v: Visitor): Promise<string> {
  const id = crypto.randomUUID();
  await store.create({
    engine: 'claude-agent-sdk',
    id,
    workspaceId: v.workspaceId,
    agentId: AGENT,
    sessionId: id,
    initiatingUserId: v.userId,
    ownerPrincipalId: v.ownerPrincipalId,
  });
  return id;
}

const ids = async (response: Response): Promise<unknown[]> =>
  ((await response.json()) as { runs: { id: string }[] }).runs.map((run) => run.id);
const errorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => {
  resetTestRunApi();
  clearApplicationContext();
});

describe('the store visitor pages read only the visitor own demo workspace', () => {
  it('lists the visitor own runs, and a second visitor sees none of the first', async () => {
    const store = await wire();
    const runA = await seed(store, A);
    const runB = await seed(store, B);
    // A second run in B's workspace, owned by A's principal: only the workspace can exclude it.
    await seed(store, { ...A, workspaceId: B.workspaceId });

    const listedA = await listRunsRoute(call('/api/runs?limit=50', A) as never);
    expect(listedA.status).toBe(200);
    expect(await ids(listedA)).toEqual([runA]);

    const listedB = await listRunsRoute(call('/api/runs', B) as never);
    expect(await ids(listedB)).toEqual([runB]);
  });

  it('answers 404 for another visitor run, the same as a missing one', async () => {
    const store = await wire();
    const runA = await seed(store, A);

    const own = await readRunRoute(call(`/api/runs/${runA}`, A) as never, params(runA));
    expect(own.status).toBe(200);

    const other = await readRunRoute(call(`/api/runs/${runA}`, B) as never, params(runA));
    const missing = crypto.randomUUID();
    const none = await readRunRoute(call(`/api/runs/${missing}`, B) as never, params(missing));
    expect(other.status).toBe(404);
    expect(none.status).toBe(404);
    expect(await errorCode(other)).toBe(await errorCode(none));
  });

  it('answers 401 to a caller with no session, on the runs list and the allowance', async () => {
    await wire();
    const list = await listRunsRoute(call('/api/runs', null) as never);
    expect(list.status).toBe(401);
    const allowance = await allowanceRoute(call('/api/demo/allowance', null));
    expect(allowance.status).toBe(401);
    expect(await errorCode(allowance)).toBe('unauthenticated');
  });

  it('answers the allowance of a live demo and of an ended one with its own expiresAt', async () => {
    await wire();
    const live = await allowanceRoute(call('/api/demo/allowance', A));
    expect(live.status).toBe(200);
    expect(DemoAllowanceSchema.parse(await live.json()).expiresAt).toBe('2026-11-16T11:00:00.000Z');

    const ended = await allowanceRoute(call('/api/demo/allowance', ENDED));
    expect(ended.status).toBe(200);
    expect(DemoAllowanceSchema.parse(await ended.json()).expiresAt).toBe(
      '2026-11-16T08:00:00.000Z',
    );
  });

  it('refuses a run start in an ended demo with 409 demo_expired and starts nothing', async () => {
    const store = await wire();
    const start = (as: Visitor) =>
      startRunRoute(
        call(`/api/agents/${AGENT}/runs`, as, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi' }),
        }) as never,
        params(AGENT),
      );
    const refused = await start(ENDED);
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe('demo_expired');
    expect((await store.listRuns(ENDED.workspaceId, { limit: 10 })).items).toHaveLength(0);

    // The same request in a live demo is accepted, so the 409 above is the demo's end.
    expect((await start(A)).status).toBe(202);
    expect((await store.listRuns(A.workspaceId, { limit: 10 })).items).toHaveLength(1);
  });
});
