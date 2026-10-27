import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createAgentVersion } from '../../../agent-versions/handlers';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../../agents/memory-store';
import type { AgentStoreProvider } from '../../../agents/store';
import type { Role } from '../../../rbac/roles';
import { callContextOf } from '../../testing/context';
import { describeCheckerConformance, draftBody, type CheckerFixture } from './checker.contract';
import { MemoryChecker } from './memory';
import { createChecker, toCheckResult } from './production';

const WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();

const ctxOf = (role: Role | null, principalId?: string) =>
  callContextOf(WORKSPACE, role, principalId);

const bodyWith: CheckerFixture['bodyWith'] = (connectors) => draftBody('Draft agent', connectors);

/** The real pipeline over in-memory stores that hold connector `crm` and an agent with two versions. */
async function productionFixture() {
  const agents = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: 'c1', name: 'crm' }] } },
  });
  const store = await versions.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the agent');
  const save = () => createAgentVersion(versionRequest(), created.agent, OWNER, { store });
  expect([(await save()).status, (await save()).status]).toEqual([201, 201]);
  return { agents, versions, agentId: created.agent.id };
}

describeCheckerConformance('the production adapter', async () => {
  const { agents, versions, agentId } = await productionFixture();
  return {
    port: createChecker({ agents, versions, pipeline: () => ({}) }),
    bodyWith,
    agentWithTwoVersions: agentId,
    agentOwner: OWNER,
    unknownAgentId: crypto.randomUUID(),
    ctxOf,
  };
});

describeCheckerConformance('the memory adapter', () =>
  Promise.resolve({
    port: new MemoryChecker(
      new Set(['crm']),
      new Map([['agent-2', { versions: 2, ownerPrincipalId: OWNER }]]),
    ),
    bodyWith,
    agentWithTwoVersions: 'agent-2',
    agentOwner: OWNER,
    unknownAgentId: 'agent-x',
    ctxOf,
  }),
);

describe('the production checker', () => {
  it('writes nothing: a check leaves the agents and versions as they were', async () => {
    const { agents, versions, agentId } = await productionFixture();
    const checker = createChecker({ agents, versions, pipeline: () => ({}) });
    const before = (await agents.forWorkspace(WORKSPACE).list()).length;
    const versionsBefore = versions.versionCount();

    await checker.check(ctxOf('builder'), undefined, bodyWith(['crm']));
    await checker.check(ctxOf('builder', OWNER), agentId, bodyWith(['crm']));

    expect((await agents.forWorkspace(WORKSPACE).list()).length).toBe(before);
    expect(versions.versionCount()).toBe(versionsBefore);
  });

  it('refuses a built-in agent with builtin_agent_read_only, as the console route does, and writes nothing', async () => {
    const { agents, versions, agentId } = await productionFixture();
    const marked: AgentStoreProvider = {
      forWorkspace: (id) => {
        const bound = agents.forWorkspace(id);
        return {
          ...bound,
          get: async (candidate) => {
            const agent = await bound.get(candidate);
            return agent !== null && candidate === agentId
              ? { ...agent, builtin: 'builder' }
              : agent;
          },
        };
      },
    };
    const checker = createChecker({ agents: marked, versions, pipeline: () => ({}) });
    const versionsBefore = versions.versionCount();

    expect(await checker.check(ctxOf('builder', OWNER), agentId, bodyWith([]))).toMatchObject({
      ok: false,
      code: 'builtin_agent_read_only',
    });
    expect(versions.versionCount()).toBe(versionsBefore);
  });

  it('throws on a 5xx, and on a body it does not know, so the shell reports an internal error', () => {
    const problem = { error: { code: 'internal_error', message: 'Something went wrong.' } };
    expect(() => toCheckResult({ status: 500, body: problem })).toThrow(/500/u);
    expect(() => toCheckResult({ status: 200, body: {} })).toThrow(/200/u);
    expect(() => toCheckResult({ status: 422, body: {} })).toThrow(/422/u);
  });

  it('passes a 4xx problem through with its code unchanged', () => {
    const body = {
      error: { code: 'unsupported_engine', message: 'No such engine.', details: ['x'] },
    };
    expect(toCheckResult({ status: 400, body })).toMatchObject({
      ok: false,
      code: 'unsupported_engine',
      details: ['x'],
    });
  });
});
