import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
} from '@indx-workspace/contracts/agents';
import {
  AgentTeamResourceSchema,
  AgentTeamVersionSchema,
} from '@indx-workspace/contracts/agent-teams';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, runFixture, stdoutJson, type Route } from '../testing.js';
import { parseMemberSpec } from './agent-teams.js';

/** Issue #1516 (ADR-0104): `aw agent-teams list|get|create|remove|versions create|versions list`. */

const AT = '2026-10-31T00:00:00.000Z';
const TEAM_ID = '88888888-8888-4888-8888-888888888888';
const RESEARCHER_ID = '12121212-1212-4212-8212-121212121212';
const RESEARCHER = { ...FIXTURES.agent, id: RESEARCHER_ID, name: 'researcher' };

const definition: AgentDefinition = {
  apiVersion: AGENT_DEFINITION_API_VERSION,
  kind: AGENT_DEFINITION_KIND,
  agent: {
    name: 'Summariser',
    instructions: 'Summarise.',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    model: 'claude-x',
    modelConnectionName: 'anthropic',
    runtimeProfileName: null,
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  policySource: 'stored',
  resources: { files: [], skills: [], connectors: [] },
};

/** Version `number` of `agentId`, with an id that names both. */
const versionId = (agentId: string, number: number) =>
  `${agentId.slice(0, 24)}${String(number).padStart(12, '0')}`;

function versionList(agentId: string, local: number | null) {
  return {
    items: [1, 2].map((number) => ({
      id: versionId(agentId, number),
      agentId,
      workspaceId: IDS.workspace,
      number,
      summary: `Version ${String(number)}`,
      via: 'api',
      body: { definition, surfaces: [] },
      createdByPrincipalId: IDS.principal,
      createdAt: AT,
    })),
    pointers: local === null ? [] : [{ environment: 'local', number: local, updatedAt: AT }],
    materialised: null,
  };
}

const VERSION = {
  id: '99999999-9999-4999-8999-999999999999',
  teamId: TEAM_ID,
  workspaceId: IDS.workspace,
  version: 1,
  mode: 'handoff',
  lead: { agentId: IDS.agent, agentVersionId: versionId(IDS.agent, 1) },
  members: [
    { name: 'researcher', agentId: RESEARCHER_ID, agentVersionId: versionId(RESEARCHER_ID, 2) },
  ],
  createdBy: null,
  createdAt: AT,
};

const TEAM = {
  id: TEAM_ID,
  workspaceId: IDS.workspace,
  name: 'Research',
  description: null,
  latestVersion: VERSION,
  ownerPrincipalId: IDS.principal,
  createdBy: null,
  createdAt: AT,
  updatedAt: AT,
};

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** The control plane the commands talk to, recording each request. */
function platform(seen: Seen[], teams: readonly unknown[] = [TEAM]): Route {
  return (request) => {
    const path = `${request.url.pathname}${request.url.search}`;
    seen.push({ method: request.method, path, body: request.json });
    const route = `${request.method} ${request.url.pathname}`;
    if (route === 'GET /api/agent-teams') return json(200, { items: teams, nextCursor: null });
    if (route === 'POST /api/agent-teams') return json(201, TEAM);
    if (route === `DELETE /api/agent-teams/${TEAM_ID}`) return new Response(null, { status: 204 });
    if (route === `POST /api/agent-teams/${TEAM_ID}/versions`)
      return json(201, { ...VERSION, version: 2 });
    if (route === `GET /api/agent-teams/${TEAM_ID}/versions`) {
      return request.url.searchParams.get('cursor') === null
        ? json(200, { items: [{ ...VERSION, version: 2 }], nextCursor: 'more' })
        : json(200, { items: [VERSION], nextCursor: null });
    }
    if (route === `POST /api/agent-teams/${TEAM_ID}/runs`) {
      return json(202, { run: runFixture('queued'), events: `/api/runs/${IDS.run}/events` });
    }
    if (route === 'GET /api/agents') return json(200, { agents: [FIXTURES.agent, RESEARCHER] });
    if (route === `GET /api/agents/${IDS.agent}/versions`)
      return json(200, versionList(IDS.agent, 1));
    if (route === `GET /api/agents/${RESEARCHER_ID}/versions`) {
      return json(200, versionList(RESEARCHER_ID, null));
    }
    return json(404, { error: { code: 'not_found', message: `no route ${route}` } });
  };
}

describe('parseMemberSpec', () => {
  it('reads an agent, an optional version and an optional member name', () => {
    expect(parseMemberSpec('researcher', 'member')).toEqual({ agent: 'researcher' });
    expect(parseMemberSpec('researcher@3', 'member')).toEqual({ agent: 'researcher', version: 3 });
    expect(parseMemberSpec('web=researcher@3', 'member')).toEqual({
      name: 'web',
      agent: 'researcher',
      version: 3,
    });
    // `=` is a member name only for a slug, `@` a version only before digits.
    expect(parseMemberSpec('Ops Bot=x', 'member')).toEqual({ agent: 'Ops Bot=x' });
    expect(parseMemberSpec('ops@home', 'member')).toEqual({ agent: 'ops@home' });
    expect(parseMemberSpec('web=lead@2', 'lead')).toEqual({ agent: 'web=lead', version: 2 });
  });

  it('refuses a value with no agent and a version past the largest', () => {
    expect(() => parseMemberSpec('web=', 'member')).toThrow(/names no agent/u);
    expect(() => parseMemberSpec('x@99999999999', 'member')).toThrow(/at most/u);
  });
});

describe('aw agent-teams', () => {
  it('list shows each team with its lead and members, and --json keeps the resources', async () => {
    const human = await runCli(['agent-teams', 'list'], { route: platform([]) });
    expect(human.stderr).toBe('');
    expect(human.code).toBe(EXIT_CODE.ok);
    expect(human.stdout.split('\n')[0]).toMatch(
      /^id\s+name\s+version\s+lead\s+members\s+createdAt$/u,
    );
    expect(human.stdout).toContain('Research');
    const structured = await runCli(['agent-teams', 'list', '--json'], { route: platform([]) });
    expect(AgentTeamResourceSchema.array().parse(stdoutJson(structured))).toEqual([TEAM]);
  });

  it('get resolves a team by name or id, and refuses an unknown one', async () => {
    for (const name of ['Research', TEAM_ID]) {
      const run = await runCli(['agent-teams', 'get', name, '--json'], { route: platform([]) });
      expect(AgentTeamResourceSchema.parse(stdoutJson(run))).toEqual(TEAM);
    }
    const missing = await runCli(['agent-teams', 'get', 'Nobody'], { route: platform([]) });
    expect(missing.code).not.toBe(EXIT_CODE.ok);
    expect(missing.stderr).toContain('no agent team named "Nobody"');
  });

  it('create sends the name alone, or the name and version 1 with pinned versions', async () => {
    const bare: Seen[] = [];
    await runCli(['agent-teams', 'create', 'Research', '--description', 'Finds things', '--json'], {
      route: platform(bare),
    });
    expect(bare.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/api/agent-teams',
        body: { name: 'Research', description: 'Finds things' },
      },
    ]);

    const seen: Seen[] = [];
    const run = await runCli(
      [
        'agent-teams',
        'create',
        'Research',
        '--lead',
        'Summariser@2',
        '--member',
        'web=researcher',
        '--json',
      ],
      { route: platform(seen) },
    );
    expect(AgentTeamResourceSchema.parse(stdoutJson(run))).toEqual(TEAM);
    // The lead is pinned at version 2 as asked; the member, with no `local` pointer, at its newest.
    expect(seen.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Research',
      version: {
        lead: { agentId: IDS.agent, agentVersionId: versionId(IDS.agent, 2) },
        members: [
          { agentId: RESEARCHER_ID, agentVersionId: versionId(RESEARCHER_ID, 2), name: 'web' },
        ],
      },
    });
  });

  it('create refuses a member without a lead, and an unknown agent or version', async () => {
    const noLead = await runCli(['agent-teams', 'create', 'Research', '--member', 'researcher'], {
      route: platform([]),
    });
    expect(noLead.code).toBe(EXIT_CODE.usage);
    expect(noLead.stderr).toContain('--lead');
    const unknown = await runCli(
      ['agent-teams', 'create', 'R', '--lead', 'Summariser', '--member', 'ghost'],
      { route: platform([]) },
    );
    expect(unknown.stderr).toContain('no agent named "ghost"');
    const noVersion = await runCli(
      ['agent-teams', 'create', 'R', '--lead', 'Summariser@7', '--member', 'researcher'],
      { route: platform([]) },
    );
    expect(noVersion.stderr).toContain('has no version 7');
  });

  it('remove deletes the team it names', async () => {
    const seen: Seen[] = [];
    const run = await runCli(['agent-teams', 'remove', 'Research'], { route: platform(seen) });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/agent-teams/${TEAM_ID}` });
  });

  it('versions create keeps the current lead unless --lead names another, and pins the local version', async () => {
    const seen: Seen[] = [];
    const run = await runCli(
      ['agent-teams', 'versions', 'create', 'Research', '--member', 'researcher@1', '--json'],
      { route: platform(seen) },
    );
    expect(AgentTeamVersionSchema.parse(stdoutJson(run)).version).toBe(2);
    expect(seen.find((call) => call.method === 'POST')?.body).toEqual({
      lead: VERSION.lead,
      members: [{ agentId: RESEARCHER_ID, agentVersionId: versionId(RESEARCHER_ID, 1) }],
    });

    const relead: Seen[] = [];
    await runCli(
      [
        'agent-teams',
        'versions',
        'create',
        TEAM_ID,
        '--lead',
        'Summariser',
        '--member',
        'researcher',
      ],
      { route: platform(relead) },
    );
    expect(relead.find((call) => call.method === 'POST')?.body).toMatchObject({
      // `local` points at version 1 of the lead.
      lead: { agentId: IDS.agent, agentVersionId: versionId(IDS.agent, 1) },
    });
  });

  it('versions create needs --lead for a team with no version yet, and at least one --member', async () => {
    const empty = { ...TEAM, latestVersion: null };
    const noLead = await runCli(
      ['agent-teams', 'versions', 'create', 'Research', '--member', 'researcher'],
      {
        route: platform([], [empty]),
      },
    );
    expect(noLead.code).toBe(EXIT_CODE.usage);
    const noMember = await runCli(['agent-teams', 'versions', 'create', 'Research'], {
      route: platform([]),
    });
    expect(noMember.stderr).toContain('--member');
  });

  it('versions list walks every page, newest first, as a table or --json', async () => {
    const seen: Seen[] = [];
    const structured = await runCli(['agent-teams', 'versions', 'list', 'Research', '--json'], {
      route: platform(seen),
    });
    expect(
      AgentTeamVersionSchema.array()
        .parse(stdoutJson(structured))
        .map((v) => v.version),
    ).toEqual([2, 1]);
    expect(seen.filter((call) => call.path.includes('/versions')).map((call) => call.path)).toEqual(
      [`/api/agent-teams/${TEAM_ID}/versions`, `/api/agent-teams/${TEAM_ID}/versions?cursor=more`],
    );
    const human = await runCli(['agent-teams', 'versions', 'list', 'Research'], {
      route: platform([]),
    });
    expect(human.stdout.split('\n')[0]).toMatch(/^version\s+lead\s+members\s+createdAt$/u);
    expect(human.stdout).toContain('researcher');
  });

  it('refuses a flag a command does not take', async () => {
    const run = await runCli(['agent-teams', 'list', '--member', 'x'], { route: platform([]) });
    expect(run.code).toBe(EXIT_CODE.usage);
  });

  it('run starts the team by name with the prompt, the session and the Idempotency-Key', async () => {
    const seen: Seen[] = [];
    const run = await runCli(
      [
        'agent-teams',
        'run',
        'Research',
        'Write the launch note.',
        '--idempotency-key',
        'note-1',
        '--json',
      ],
      { route: platform(seen) },
    );
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toMatchObject({ id: IDS.run });
    expect(seen.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: `/api/agent-teams/${TEAM_ID}/runs`,
        body: {
          prompt: 'Write the launch note.',
          sessionId: null,
          modelConnectionId: null,
          model: null,
        },
      },
    ]);
    expect(run.calls.at(-1)?.headers.get('idempotency-key')).toBe('note-1');
  });

  it('run refuses an empty prompt and --wait with --follow before any request', async () => {
    const empty = await runCli(['agent-teams', 'run', 'Research', ' '], { route: platform([]) });
    expect(empty.code).toBe(EXIT_CODE.usage);
    const both = await runCli(['agent-teams', 'run', 'Research', 'x', '--wait', '--follow'], {
      route: platform([]),
    });
    expect(both.code).toBe(EXIT_CODE.usage);
    expect(both.calls).toEqual([]);
  });
});
