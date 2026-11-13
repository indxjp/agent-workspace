import {
  AgentGrantsSchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
} from '@indx-workspace/contracts/agents';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { FIXTURES, IDS, json, runCli, stdoutJson } from '../testing.js';
describe('aw agents', () => {
  it('list --json round-trips and the table shows the chosen columns', async () => {
    const structured = await runCli(['agents', 'list', '--json'], {
      route: () => json(200, { agents: [FIXTURES.agent] }),
    });
    expect(AgentResourceSchema.array().parse(stdoutJson(structured))).toEqual([FIXTURES.agent]);
    const human = await runCli(['agents', 'list'], {
      route: () => json(200, { agents: [FIXTURES.agent] }),
    });
    expect(human.stdout.split('\n')[0]).toMatch(
      /^id\s+name\s+model\s+modelConnectionId\s+runtimeProfileId\s+updatedAt\s+builtin$/u,
    );
    expect(human.stdout).toContain('Summariser  claude-x');
    const jsonl = await runCli(['agents', 'list', '--jsonl'], {
      route: () => json(200, { agents: [FIXTURES.agent] }),
    });
    expect(jsonl.stdout).toBe(`${JSON.stringify(FIXTURES.agent)}\n`);
  });

  it('list shows a built-in as "Built-in", last, and keeps `builtin` in --json (#1848)', async () => {
    const builder = { ...FIXTURES.agent, id: IDS.run, name: 'builder', builtin: 'builder' };
    const route = () => json(200, { agents: [FIXTURES.agent, builder] });
    const human = await runCli(['agents', 'list'], { route });
    const rows = human.stdout.trimEnd().split('\n');
    expect(rows).toHaveLength(4);
    expect(rows[2]).not.toContain('Built-in');
    expect(rows[3]).toMatch(/builder\s.*\sBuilt-in$/u);
    const structured = await runCli(['agents', 'list', '--json'], { route });
    expect(stdoutJson(structured)).toEqual([FIXTURES.agent, builder]);
  });

  it('get shows who made the agent and when it was archived, and nothing for a person-made one (#1851)', async () => {
    const made = {
      ...FIXTURES.agent,
      createdByAgent: { agentId: IDS.agent, version: 2, runId: 'run_abc' },
      archivedAt: '2026-09-22T10:00:00.000Z',
    };
    const route = () => json(200, made);
    const human = await runCli(['agents', 'get', IDS.agent], { route });
    expect(human.stdout).toMatch(/createdByAgent\s.*run_abc/u);
    expect(human.stdout).toMatch(/archivedAt\s+2026-09-22T10:00:00\.000Z/u);
    const structured = await runCli(['agents', 'get', IDS.agent, '--json'], { route });
    expect(AgentResourceSchema.parse(stdoutJson(structured))).toEqual(made);

    const person = await runCli(['agents', 'get', IDS.agent], {
      route: () => json(200, FIXTURES.agent),
    });
    expect(person.stdout).not.toContain('createdByAgent');
    expect(person.stdout).not.toContain('archivedAt');
  });

  it('get, create from stdin, update from a runtime switch, and remove', async () => {
    const get = await runCli(['agents', 'get', IDS.agent, '--json'], {
      route: () => json(200, FIXTURES.agent),
    });
    expect(AgentResourceSchema.parse(stdoutJson(get))).toEqual(FIXTURES.agent);

    const body = {
      name: 'Summariser',
      instructions: 'Summarise.',
      modelConnectionId: IDS.connection,
      model: 'claude-x',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    };
    const create = await runCli(['agents', 'create', '--file', '-'], {
      stdin: JSON.stringify(body),
      route: () => json(201, FIXTURES.agent),
    });
    expect(create.code).toBe(EXIT_CODE.ok);
    expect(create.calls[0]?.json).toEqual(body);

    const update = await runCli(['agents', 'update', IDS.agent, '--file', '-'], {
      stdin: '{"runtimeProfileId":"rp-1"}',
      route: () => json(200, { ...FIXTURES.agent, runtimeProfileId: 'rp-1' }),
    });
    expect(update.calls[0]?.method).toBe('PATCH');
    expect(update.calls[0]?.json).toEqual({ runtimeProfileId: 'rp-1' });

    const remove = await runCli(['agents', 'remove', IDS.agent], { route: () => json(204, null) });
    expect(remove.code).toBe(EXIT_CODE.ok);
  });

  it('restore posts to the restore path, prints the name without control or format characters (bidi, zero-width), and keeps the agent for --json (#1851)', async () => {
    const route = () => json(200, { ...FIXTURES.agent, name: 'Tri\u001b[2Jage\u0007\u202e\u200b' });
    const human = await runCli(['agents', 'restore', IDS.agent], { route });
    expect(human.code).toBe(EXIT_CODE.ok);
    expect(human.calls[0]?.method).toBe('POST');
    expect(human.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/restore`);
    expect(human.stdout).toBe('Tri[2Jage\n');
    const machine = await runCli(['agents', 'restore', IDS.agent, '--json'], { route });
    expect(AgentResourceSchema.parse(stdoutJson(machine)).id).toBe(FIXTURES.agent.id);
  });

  it('assignments get and set', async () => {
    const get = await runCli(['agents', 'assignments', 'get', IDS.agent, '--json'], {
      route: () => json(200, { assignments: FIXTURES.assignments }),
    });
    expect(get.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/resources`);
    expect(AgentResourceAssignmentsSchema.parse(stdoutJson(get))).toEqual(FIXTURES.assignments);
    const set = await runCli(['agents', 'assignments', 'set', IDS.agent, '--file', '-', '--json'], {
      stdin: JSON.stringify(FIXTURES.assignments),
      route: () => json(200, { assignments: FIXTURES.assignments }),
    });
    expect(set.calls[0]?.method).toBe('PUT');
    expect(set.calls[0]?.json).toEqual(FIXTURES.assignments);
    const bad = await runCli(['agents', 'assignments', 'set', IDS.agent, '--file', '-'], {
      stdin: '{"files":[{"fileId":"f","access":"execute"}],"skillIds":[],"connectorIds":[]}',
    });
    expect(bad.code).toBe(EXIT_CODE.usage);
  });

  it('grants get and set use principal ids and preserve JSON output', async () => {
    const principalIds = ['99999999-9999-4999-8999-999999999999'];
    const get = await runCli(['agents', 'grants', 'get', IDS.agent, '--json'], {
      route: () => json(200, { principalIds }),
    });
    expect(get.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/grants`);
    expect(AgentGrantsSchema.parse({ principalIds: stdoutJson(get) })).toEqual({ principalIds });

    const set = await runCli(['agents', 'grants', 'set', IDS.agent, '--file', '-', '--json'], {
      stdin: JSON.stringify({ principalIds }),
      route: () => json(200, { principalIds }),
    });
    expect(set.code).toBe(EXIT_CODE.ok);
    expect(set.calls[0]?.method).toBe('PUT');
    expect(set.calls[0]?.json).toEqual({ principalIds });
    expect(stdoutJson(set)).toEqual(principalIds);

    const human = await runCli(['agents', 'grants', 'get', IDS.agent], {
      route: () => json(200, { principalIds }),
    });
    expect(human.stdout).toBe(`${principalIds[0]}\n`);
  });
});
