/**
 * SDK conformance, agent / pointers: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import { servedContractsHeaders } from './versioning/contracts-version';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionCheckResponseSchema,
  AgentVersionResourceSchema,
  CreateAgentFromVersionResponseSchema,
  SetAgentPointerResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import { createAgentFromVersion } from './agent-versions/create-from-version';
import { fixtureSurface, fromVersionRequest, versionRequest } from './agent-versions/fixtures';
import { createAgentVersion } from './agent-versions/handlers';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import { createInMemoryAgentVersionStoreProvider } from './agent-versions/memory-store';
import { setAgentPointer } from './agent-versions/pointers';
import { WORKSPACE } from './sdk-conformance.test-support';

const OWNER = 'principal-1';

async function workspace() {
  const agents = createInMemoryAgentStoreProvider();
  const provider = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return { agents: agents.forWorkspace(WORKSPACE), store };
}

const OWNER_CALLER = {
  principalId: OWNER,
  ownerPrincipalId: OWNER,
  userId: null,
  actorLabel: 'owner key',
};
const POINTER_ACTOR = { principalId: OWNER, userId: null, actor: 'conformance key' };

type PointerWorkspace = Awaited<ReturnType<typeof workspace>>;
type PointerAgent = NonNullable<Awaited<ReturnType<PointerWorkspace['agents']['get']>>>;

/** Two agents, the second saved under the first one's name so a name collision is possible. */
async function seedAgentsWithNameCollision({ agents, store }: PointerWorkspace) {
  const first = await createAgentFromVersion(
    fromVersionRequest({ surfaces: [fixtureSurface('main')] }),
    OWNER_CALLER,
    { store, agents },
  );
  const firstAgent = CreateAgentFromVersionResponseSchema.parse(first.body).agent;
  const other = await createAgentFromVersion(
    fromVersionRequest({ name: 'Billing' }),
    OWNER_CALLER,
    { store, agents },
  );
  const otherAgent = await agents.get(
    CreateAgentFromVersionResponseSchema.parse(other.body).agent.id,
  );
  if (otherAgent === null) throw new Error('the second agent exists');
  const saved = await createAgentVersion(
    versionRequest({ name: 'Billing', surfaces: [fixtureSurface('main', 'Billing')] }),
    otherAgent,
    OWNER,
    { store },
  );
  expect(saved.status).toBe(201);
  const renamed = await createAgentVersion(
    versionRequest({ name: firstAgent.name }),
    otherAgent,
    OWNER,
    { store },
  );
  expect(renamed.status).toBe(201);
  return { firstAgent, otherAgent };
}

/** One handler answer per published refusal code. */
async function refusalAnswers(
  { agents, store }: PointerWorkspace,
  otherAgent: PointerAgent,
): Promise<readonly { readonly status: number; readonly body: unknown }[]> {
  const create = (
    request: Parameters<typeof createAgentFromVersion>[0],
    registered?: readonly string[],
  ) =>
    createAgentFromVersion(request, OWNER_CALLER, {
      store,
      agents,
      ...(registered === undefined ? {} : { registered }),
    });
  const point = (environment: 'local' | 'preview', version: number) =>
    setAgentPointer({ environment, version }, otherAgent, POINTER_ACTOR, { store });
  return [
    await create({ version: { summary: '' } }),
    await create(fromVersionRequest({ name: 'New' }), ['pi']),
    await create(fromVersionRequest({ name: 'New', resources: { skills: ['triage'] } })),
    await create(fromVersionRequest()),
    await create(fromVersionRequest({ name: 'New', surfaces: [fixtureSurface('main', 'New')] })),
    await point('preview', 1),
    await point('local', 9),
    await point('local', 2),
    await point('local', 3),
  ];
}

/** A client whose one request is answered with `result`, as the route would serve it. */
function served(result: { readonly status: number; readonly body: unknown }) {
  return createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'content-type': 'application/json', ...servedContractsHeaders() },
        }),
      ),
  });
}

async function sdkReadsCreateFromVersion({ agents, store }: PointerWorkspace) {
  const { version } = fromVersionRequest();
  const checked = await createAgentFromVersion(fromVersionRequest({ dryRun: true }), OWNER_CALLER, {
    store,
    agents,
  });
  const sdkChecked = await served(checked).agents.create({ version, dryRun: true });
  expect(sdkChecked).toEqual(AgentVersionCheckResponseSchema.parse(checked.body));

  const created = await createAgentFromVersion(fromVersionRequest(), OWNER_CALLER, {
    store,
    agents,
  });
  const sdkCreated = await served(created).agents.create({ version });
  expect(sdkCreated).toEqual(CreateAgentFromVersionResponseSchema.parse(created.body));
  const agent = await agents.get(sdkCreated.agent.id);
  if (agent === null) throw new Error('the created agent exists');
  return agent;
}

async function sdkReadsVersionDraft(store: PointerWorkspace['store'], agent: PointerAgent) {
  const { summary, via, body } = versionRequest({
    instructions: 'Answer support mail politely.',
  });
  const draft = { summary, via, body };
  const versionCheck = await createAgentVersion({ ...draft, dryRun: true }, agent, OWNER, {
    store,
  });
  expect(await served(versionCheck).agents.versions.check(agent.id, draft)).toEqual({
    ok: true,
    number: 2,
  });
  const saved = await createAgentVersion(draft, agent, OWNER, { store });
  const sdkSaved = await served(saved).agents.versions.create(agent.id, draft);
  expect(sdkSaved).toEqual(AgentVersionResourceSchema.parse(saved.body));
  expect(sdkSaved.number).toBe(2);
}

async function sdkReadsPointerMove(store: PointerWorkspace['store'], agent: PointerAgent) {
  const moved = await setAgentPointer({ environment: 'local', version: 2 }, agent, POINTER_ACTOR, {
    store,
  });
  const sdkMoved = await served(moved).agents.pointers.set(agent.id, {
    environment: 'local',
    version: 2,
  });
  expect(sdkMoved).toEqual(SetAgentPointerResponseSchema.parse(moved.body));
  expect(sdkMoved.pointer.number).toBe(2);
}

async function sdkReadsNameCollision({ agents, store }: PointerWorkspace) {
  const { version } = fromVersionRequest();
  const collision = await createAgentFromVersion(fromVersionRequest(), OWNER_CALLER, {
    store,
    agents,
  });
  const failure: unknown = await served(collision)
    .agents.create({ version })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiProblemError);
  const refusal = failure as ApiProblemError;
  expect([refusal.status, refusal.code]).toEqual([collision.status, 'agent_name_conflict']);
  expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.agent_name_conflict);
}

/**
 * S1-06 (issue #444): the pointer move and create-from-version render the shapes the contracts
 * publish, and every code they answer — `agent_name_conflict` (409) included, published since
 * issue #480 — is one `AGENT_VERSION_PROBLEM_CODES` names under the same status. S1-09 (issue
 * #447): the SDK's `agents.create`, `agents.versions.*` and `agents.pointers.set` read those
 * handler answers back as the parsed shapes and the typed refusal.
 */
describe('agent pointers and create-from-version (S1-06, issue #444)', () => {
  it('serialises a pointer move, a create-from-version and its dry run into the published shapes', async () => {
    const { agents, store } = await workspace();
    const checked = await createAgentFromVersion(
      fromVersionRequest({ dryRun: true }),
      OWNER_CALLER,
      {
        store,
        agents,
      },
    );
    expect(AgentVersionCheckResponseSchema.safeParse(checked.body).success).toBe(true);

    const created = await createAgentFromVersion(fromVersionRequest(), OWNER_CALLER, {
      store,
      agents,
    });
    const createdBody = CreateAgentFromVersionResponseSchema.safeParse(created.body);
    expect(createdBody.success, JSON.stringify(createdBody.error)).toBe(true);
    if (!createdBody.success) return;

    const agent = await agents.get(createdBody.data.agent.id);
    if (agent === null) throw new Error('the created agent exists');
    const moved = await setAgentPointer(
      { environment: 'local', version: 1 },
      agent,
      POINTER_ACTOR,
      { store },
    );
    const movedBody = SetAgentPointerResponseSchema.safeParse(moved.body);
    expect(movedBody.success, JSON.stringify(movedBody.error)).toBe(true);
  });
});

describe('agent pointers and create-from-version (S1-06, issue #444)', () => {
  it('answers every refusal with a published code and status', async () => {
    const stores = await workspace();
    const { otherAgent } = await seedAgentsWithNameCollision(stores);
    const results = await refusalAnswers(stores, otherAgent);
    const published: Readonly<Record<string, number>> = AGENT_VERSION_PROBLEM_CODES;
    const seen = new Set<string>();
    for (const result of results) {
      const code = ApiProblemSchema.parse(result.body).error.code;
      expect(published[code], code).toBe(result.status);
      seen.add(code);
    }
    expect([...seen].sort()).toEqual([
      'agent_definition_references_missing',
      'agent_name_conflict',
      'agent_version_not_found',
      'invalid_agent_version',
      'surface_name_taken',
      'unsupported_engine',
    ]);
  });
});

describe('agent pointers and create-from-version (S1-06, issue #444)', () => {
  it('S1-09: the SDK reads each handler answer as the parsed shape or the typed refusal', async () => {
    const stores = await workspace();
    const agent = await sdkReadsCreateFromVersion(stores);
    await sdkReadsVersionDraft(stores.store, agent);
    await sdkReadsPointerMove(stores.store, agent);
    await sdkReadsNameCollision(stores);
  });
});
