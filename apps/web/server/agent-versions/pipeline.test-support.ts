/**
 * Shared setup for the `pipeline.*.test.ts` suites: the pipeline driven as each caller drives it,
 * an agent record, memory stores seeded with references or agents, and refusal assertions.
 */
import { expect } from 'vitest';

import {
  AgentVersionBodySchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import type { ApiResult } from '../http/result';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { FIXTURE_PERMISSIONS, versionRequest } from './fixtures';
import { createInMemoryAgentVersionStoreProvider, type SeededReferences } from './memory-store';
import {
  parseVersionRequest,
  validateAgentVersion,
  type AgentVersionContext,
  type AgentVersionSubject,
} from './pipeline';
import type { WorkspaceAgentVersionStore } from './store';

export const WORKSPACE = '66666666-6666-4666-8666-666666666666';
export const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

export type Dependencies = Pick<
  AgentVersionContext,
  'store' | 'registered' | 'ceiling' | 'toolBundles' | 'toolHost' | 'toolDomainsRefusal'
>;

type VersionRequest = ReturnType<typeof versionRequest>;

/** Step 1 and the pipeline over a create-version request, as `handlers.ts` runs them. */
export async function validateVersionRequest(
  raw: unknown,
  subject: AgentVersionSubject,
  dependencies: Dependencies,
) {
  const parsed = parseVersionRequest(
    CreateAgentVersionRequestSchema,
    raw,
    'body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed;
  const { request } = parsed;
  const validated = await validateAgentVersion(request.body, {
    ...dependencies,
    subject,
    bodyPath: 'body',
    dryRun: request.dryRun === true,
  });
  return validated.ok ? { ...validated, request } : validated;
}

/** The same over `POST /api/agents {version}`, as `create-from-version.ts` runs them. */
export async function validateAgentFromVersion(raw: unknown, dependencies: Dependencies) {
  const parsed = parseVersionRequest(
    CreateAgentFromVersionRequestSchema,
    raw,
    'version.body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed;
  const { request } = parsed;
  const validated = await validateAgentVersion(request.version.body, {
    ...dependencies,
    subject: { kind: 'new' },
    bodyPath: 'version.body',
    dryRun: request.dryRun === true,
  });
  return validated.ok ? { ...validated, request } : validated;
}

/** A stored body re-checked against the agent as it is now, as `pointers.ts` runs it. */
export function validateStoredVersion(
  body: unknown,
  current: AgentRecord,
  dependencies: Dependencies,
) {
  return validateAgentVersion(AgentVersionBodySchema.parse(body), {
    ...dependencies,
    subject: { kind: 'existing', agent: current },
    bodyPath: 'body',
    dryRun: false,
  });
}

export function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    name: 'Support triage',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: FIXTURE_PERMISSIONS,
    policy: null,
    createdBy: null,
    ownerPrincipalId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface HeldAgent {
  readonly name: string;
  readonly subagents?: readonly string[];
  readonly described?: boolean;
}

/** Saves one version of the agent and points `local` at it, so the agent row carries it. */
async function materialise(
  store: WorkspaceAgentVersionStore,
  seed: {
    readonly agentId: string;
    readonly name: string;
    readonly subagents: readonly string[] | undefined;
    readonly described: boolean;
  },
): Promise<void> {
  const { agentId, name, subagents, described } = seed;
  const body = {
    ...versionRequest({ name }).body,
    ...(described ? { description: `${name} does one job.` } : {}),
    ...(subagents === undefined ? {} : { subagents: subagents.map((n) => ({ name: n })) }),
  };
  const version = await store.create(agentId, {
    summary: 'seed',
    via: 'api',
    body,
    createdByPrincipalId: OWNER,
  });
  if (version.kind !== 'created') throw new Error('the memory store creates the version');
  const applied = await store.applyAndPoint(agentId, {
    environment: 'local',
    number: version.version.number,
    reason: 'set',
    audit: {
      subjectLabel: name,
      actorPrincipalId: OWNER,
      actorUserId: null,
      actorLabel: 'Owner',
    },
    agent: {
      name,
      instructions: '',
      model: null,
      permissions: FIXTURE_PERMISSIONS,
      policy: null,
      references: {
        modelConnectionId: null,
        runtimeProfileId: null,
        skillIds: [],
        connectorIds: [],
        files: [],
      },
    },
  });
  if (applied.kind !== 'applied') throw new Error(`the seed was not applied: ${applied.kind}`);
}

/**
 * A store whose workspace holds these references and agents. Each agent is first materialised
 * plain, then, for one that names `subagents`, from a second version naming them (so a named
 * agent must come out plain).
 */
export async function storeWithAgents(
  held: readonly HeldAgent[],
  references: SeededReferences = {},
  defaultRuntimeProfileId: string | null = null,
): Promise<WorkspaceAgentVersionStore> {
  const agents = createInMemoryAgentStoreProvider();
  const provider = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: references },
    ...(defaultRuntimeProfileId === null
      ? {}
      : { defaultRuntimeProfiles: { [WORKSPACE]: defaultRuntimeProfileId } }),
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const ids = new Map<string, string>();
  for (const { name, described = true } of held) {
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name,
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: OWNER, userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    ids.set(name, created.agent.id);
    await materialise(store, { agentId: created.agent.id, name, subagents: undefined, described });
  }
  for (const { name, subagents, described = true } of held) {
    const id = ids.get(name);
    if (subagents !== undefined && id !== undefined) {
      await materialise(store, { agentId: id, name, subagents, described });
    }
  }
  return store;
}

/** A store whose workspace holds these references and no agents. */
export function storeWith(
  references: SeededReferences = {},
  defaultRuntimeProfileId: string | null = null,
): Promise<WorkspaceAgentVersionStore> {
  return storeWithAgents([], references, defaultRuntimeProfileId);
}

/** A create-version request validated against an existing agent, with any extra dependencies. */
export async function validate(
  raw: unknown,
  options: {
    readonly store?: WorkspaceAgentVersionStore;
    readonly references?: SeededReferences;
    readonly defaultRuntimeProfileId?: string;
    readonly subject?: AgentRecord;
  } & Partial<Omit<Dependencies, 'store'>> = {},
) {
  const { store, references, defaultRuntimeProfileId, subject, ...dependencies } = options;
  return validateVersionRequest(
    raw,
    { kind: 'existing', agent: subject ?? agent() },
    {
      ...dependencies,
      store: store ?? (await storeWith(references, defaultRuntimeProfileId ?? null)),
    },
  );
}

export function refusalOf(
  result: { readonly ok: true } | { readonly ok: false; readonly result: ApiResult },
): { status: number; body: unknown } {
  if (result.ok) throw new Error('expected a refusal');
  return result.result;
}

/** Asserts the result is a refusal with this status and error code (and details, when given). */
export function expectRefusal(
  result: { readonly ok: true } | { readonly ok: false; readonly result: ApiResult },
  status: number,
  code: string,
  details?: readonly unknown[],
): void {
  const refusal = refusalOf(result);
  expect(refusal.status).toBe(status);
  expect(refusal.body).toMatchObject({
    error: { code, ...(details === undefined ? {} : { details }) },
  });
}

/** The request with these body fields replaced. */
export function withBody(
  request: VersionRequest,
  patch: Partial<VersionRequest['body']>,
): VersionRequest {
  return { ...request, body: { ...request.body, ...patch } };
}
