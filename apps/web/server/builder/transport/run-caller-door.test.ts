import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearFeatureSwitches, configureFeatureSwitches } from '../../features/wiring';
import { createAuthorization } from '../adapters/authorization/production';
import { draftBody } from '../adapters/checker/checker.contract';
import { toCallContext } from './call-context';
import { serveBuilderMcp, createBuilderCallerVerifier } from './mcp';
import { verifyRunCaller } from './run-caller';
import {
  AGENT,
  allowed,
  ALLOWED,
  bearer,
  createdByAgent,
  doorOf,
  mcpPost,
  MEMBER,
  MEMBER_CALLER,
  RUN,
  rpc,
  SESSION,
  setup,
  WORKSPACE,
} from './run-caller.test-support';

afterEach(() => {
  vi.restoreAllMocks();
  clearFeatureSwitches();
});

describe('the Builder-only door (#1846) refusals', () => {
  it('refuses a valid run token of an agent row that is gone on every method, naming no token or claim', async () => {
    const s = setup();
    s.agentRows.clear();
    const token = await s.issue(MEMBER_CALLER);
    const logged = (['log', 'error', 'warn', 'info'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const verifyCaller = createBuilderCallerVerifier(s.deps);
    for (const [method, params] of [
      ['initialize', undefined],
      ['tools/list', undefined],
      ['tools/call', { name: 'catalog_list', arguments: {} }],
    ] as const) {
      const response = await serveBuilderMcp(rpc(token, method, params), doorOf(verifyCaller));
      const text = await response.text();
      expect(response.status).toBe(403);
      expect(JSON.parse(text)).toMatchObject({ error: { code: 'not_allowed_to_build' } });
      for (const secret of [token, MEMBER, WORKSPACE, RUN, SESSION, AGENT]) {
        expect(text).not.toContain(secret);
      }
    }
    for (const spy of logged) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'an agent the deployment does not list',
      { name: 'other' },
      { builder: { allow: ['planner'] } },
    ],
    ['an allowed agent made by an agent', { name: 'planner', createdByAgent }, ALLOWED],
    ['an agent whose name differs in case', { name: 'Planner' }, ALLOWED],
    ['an agent under a deployment with no ceiling', { name: 'planner' }, null],
  ])(
    'refuses the run of %s before the shell, whatever its token carries',
    async (_label, row, ceiling) => {
      const s = setup();
      s.agentRows.set(AGENT, row);
      const token = await s.issue(MEMBER_CALLER);
      const verified = await verifyRunCaller(bearer(token), { ...s.deps, ceiling }, mcpPost());
      expect(verified).toEqual({ ok: false, code: 'not_allowed_to_build', reads: false });
      const response = await serveBuilderMcp(
        rpc(token, 'tools/list'),
        doorOf(createBuilderCallerVerifier({ ...s.deps, ceiling })),
      );
      expect(response.status).toBe(403);
    },
  );
});

describe('the Builder-only door (#1846) admissions', () => {
  it('admits the run of an allowed, person-made agent and resolves it to an agent creator, not the Builder', async () => {
    const s = setup();
    s.agentRows.set(AGENT, { name: 'planner' });
    const token = await s.issue(MEMBER_CALLER);
    const verified = await verifyRunCaller(bearer(token), allowed(s.deps), mcpPost());
    expect(verified).toMatchObject({ ok: true, caller: { agentId: AGENT, principalId: MEMBER } });
    if (!verified.ok) throw new Error('the run was not admitted');

    const body = draftBody('Planner');
    const authorization = createAuthorization({
      agents: {
        forWorkspace: () => ({
          get: (id) =>
            Promise.resolve({
              id,
              ownerPrincipalId: MEMBER,
              name: 'planner',
              ...s.agentRows.get(id),
            }),
        }),
      },
      versions: { forWorkspace: () => Promise.resolve({ find: () => Promise.resolve({ body }) }) },
      ceiling: null,
    });
    const ctx = toCallContext(verified.caller, {
      modelId: 'model-1',
      agentVersion: { id: 'version-1', number: 1, summary: '' },
    });
    expect(ctx.door).toEqual({ kind: 'run', agentId: AGENT, agentVersion: 1 });
    expect(await authorization.creator(ctx)).toMatchObject({ kind: 'agent', body });
  });

  it('admits an allowed agent whose token carries no person as reads-only', async () => {
    const s = setup();
    s.agentRows.set(AGENT, { name: 'planner' });
    const token = await s.issue();
    expect(await verifyRunCaller(bearer(token), allowed(s.deps), mcpPost())).toMatchObject({
      ok: false,
      code: 'no_caller',
      reads: true,
    });
  });

  it('tells the owner warning of an allowed agent, and not of the Builder or a refused agent', async () => {
    const s = setup();
    const told: unknown[] = [];
    const deps = {
      ...allowed(s.deps),
      onAllowedAgent: (workspaceId: string, agent: unknown) => {
        told.push([workspaceId, agent]);
        return Promise.resolve();
      },
    };
    const token = await s.issue(MEMBER_CALLER);

    await verifyRunCaller(bearer(token), deps, mcpPost());
    s.agentRows.set(AGENT, { name: 'planner', createdByAgent });
    await verifyRunCaller(bearer(token), deps, mcpPost());
    expect(told).toEqual([]);

    s.agentRows.set(AGENT, { name: 'planner' });
    await verifyRunCaller(bearer(token), deps, mcpPost());
    expect(told).toEqual([[WORKSPACE, { id: AGENT, name: 'planner', ownerPrincipalId: MEMBER }]]);
  });

  it('lets a Builder run through as before', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    const verifyCaller = createBuilderCallerVerifier(s.deps);
    for (const method of ['initialize', 'tools/list']) {
      const response = await serveBuilderMcp(rpc(token, method), doorOf(verifyCaller));
      expect(response.status).toBe(200);
    }
  });
});

describe('POST /api/builder/mcp and a workspace with the Builder switched off (ADR-0160 D7)', () => {
  const rpcOf = (token: string): Request =>
    new Request('http://localhost/api/builder/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer(token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  const builderOff = (): void =>
    configureFeatureSwitches({
      enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => id !== 'builder')),
    });

  it('answers 404 feature_disabled once the token verifies, before the agent or the members are read', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    const agents = vi.spyOn(s.deps.agents, 'forWorkspace');
    const members = vi.spyOn(s.directory, 'forWorkspace');
    builderOff();
    const response = await serveBuilderMcp(
      rpcOf(token),
      doorOf(createBuilderCallerVerifier(s.deps)),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: 'feature_disabled', details: ['builder'] },
    });
    expect(agents).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
  });

  it('keeps the door’s own refusal for a token that does not verify', async () => {
    const s = setup();
    builderOff();
    const response = await serveBuilderMcp(
      rpcOf('not-a-run-token'),
      doorOf(createBuilderCallerVerifier(s.deps)),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'not_permitted' } });
  });

  it('checks the workspace the token names, not another one', async () => {
    const s = setup();
    const token = await s.issue(MEMBER_CALLER);
    const asked: string[] = [];
    configureFeatureSwitches({
      enabledFor: (workspaceId) => {
        asked.push(workspaceId);
        return Promise.resolve(FEATURE_IDS);
      },
    });
    await serveBuilderMcp(rpcOf(token), doorOf(createBuilderCallerVerifier(s.deps)));
    expect(asked).toEqual([WORKSPACE]);
  });
});
