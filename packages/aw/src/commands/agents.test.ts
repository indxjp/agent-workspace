import {
  AgentGrantsSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsSchema,
  AgentResourceSchema,
  CreateAgentWithAssignmentsResponseSchema,
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

  describe('policy (S-13, issue #234)', () => {
    it('get --json round-trips and the table shows something', async () => {
      const structured = await runCli(['agents', 'policy', 'get', IDS.agent, '--json'], {
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(structured.calls[0]?.method).toBe('GET');
      expect(structured.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/policy`);
      expect(AgentPolicySchema.parse(stdoutJson(structured))).toEqual(FIXTURES.policy);

      const human = await runCli(['agents', 'policy', 'get', IDS.agent], {
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(human.code).toBe(EXIT_CODE.ok);
      expect(human.stdout.length).toBeGreaterThan(0);
    });

    it('set --file - puts the body parsed against AgentPolicySchema and reads what was stored', async () => {
      const set = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-', '--json'], {
        stdin: JSON.stringify(FIXTURES.policy),
        route: () => json(200, { policy: FIXTURES.policy }),
      });
      expect(set.code).toBe(EXIT_CODE.ok);
      expect(set.calls[0]?.method).toBe('PUT');
      expect(set.calls[0]?.url.pathname).toBe(`/api/agents/${IDS.agent}/policy`);
      expect(set.calls[0]?.json).toEqual(FIXTURES.policy);
      expect(AgentPolicySchema.parse(stdoutJson(set))).toEqual(FIXTURES.policy);
    });

    it('set refuses a body that does not match AgentPolicySchema before any request is sent', async () => {
      const bad = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-'], {
        stdin: JSON.stringify({ engine: 'other-sdk' }),
      });
      expect(bad.code).toBe(EXIT_CODE.usage);
      expect(bad.calls).toHaveLength(0);
    });

    it('surfaces skill_not_assigned by exit code and message', async () => {
      const conflict = await runCli(['agents', 'policy', 'set', IDS.agent, '--file', '-'], {
        stdin: JSON.stringify(FIXTURES.policy),
        route: () =>
          json(409, {
            error: {
              code: 'skill_not_assigned',
              message: 'The policy allowlists an unassigned skill.',
            },
          }),
      });
      expect(conflict.code).toBe(EXIT_CODE.problem);
      expect(conflict.stderr).toContain('skill_not_assigned');
    });
  });

  describe('create with assignment flags (K-2, issue #234)', () => {
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

    it('without any assignment flag, posts the bare agent body as always (one request)', async () => {
      const create = await runCli(['agents', 'create', '--file', '-'], {
        stdin: JSON.stringify(body),
        route: () => json(201, FIXTURES.agent),
      });
      expect(create.code).toBe(EXIT_CODE.ok);
      expect(create.calls).toHaveLength(1);
      expect(create.calls[0]?.json).toEqual(body);
    });

    it('--skill/--connector/--grant-file compose one POST body of { agent, assignments }', async () => {
      const create = await runCli(
        [
          'agents',
          'create',
          '--file',
          '-',
          '--skill',
          'release-notes',
          '--connector',
          'c-1',
          '--grant-file',
          'f-1',
          '--grant-file',
          'f-2:read-write',
          '--json',
        ],
        {
          stdin: JSON.stringify(body),
          route: () => json(201, { agent: FIXTURES.agent, assignments: FIXTURES.assignments }),
        },
      );
      expect(create.code).toBe(EXIT_CODE.ok);
      expect(create.calls).toHaveLength(1);
      expect(create.calls[0]?.method).toBe('POST');
      expect(create.calls[0]?.url.pathname).toBe('/api/agents');
      expect(create.calls[0]?.json).toEqual({
        agent: body,
        assignments: {
          files: [
            { fileId: 'f-1', access: 'read' },
            { fileId: 'f-2', access: 'read-write' },
          ],
          skillIds: ['release-notes'],
          connectorIds: ['c-1'],
        },
      });
      expect(CreateAgentWithAssignmentsResponseSchema.parse(stdoutJson(create))).toEqual({
        agent: FIXTURES.agent,
        assignments: FIXTURES.assignments,
      });
    });

    it('refuses a malformed --grant-file access before any request is sent', async () => {
      const bad = await runCli(['agents', 'create', '--file', '-', '--grant-file', 'f-1:execute'], {
        stdin: JSON.stringify(body),
      });
      expect(bad.code).toBe(EXIT_CODE.usage);
      expect(bad.calls).toHaveLength(0);
    });
  });

  describe('--engine (ENG-02c, issue #319)', () => {
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
    const AGENT_PATH = `/api/agents/${IDS.agent}`;
    const POLICY_PATH = `${AGENT_PATH}/policy`;

    /** The routes `--engine` touches, answered as the real control plane would answer them. */
    function engineAwareRoute(request: { readonly url: URL; readonly method: string }): Response {
      if (request.url.pathname === '/api/engines') return json(200, { engines: [FIXTURES.engine] });
      if (request.url.pathname === '/api/agents') return json(201, FIXTURES.agent);
      if (request.url.pathname === POLICY_PATH) return json(200, { policy: FIXTURES.policy });
      if (request.url.pathname === AGENT_PATH) return json(200, FIXTURES.agent);
      return json(500, { error: { code: 'unexpected', message: request.url.pathname } });
    }

    /** `METHOD /path` for every request the run made, in order. */
    function trace(run: { readonly calls: readonly { url: URL; method: string }[] }): string[] {
      return run.calls.map((call) => `${call.method} ${call.url.pathname}`);
    }

    it('create sets policy.engine through the policy route, after asking the catalogue', async () => {
      const create = await runCli(
        ['agents', 'create', '--file', '-', '--engine', 'claude-agent-sdk'],
        { stdin: JSON.stringify(body), route: engineAwareRoute },
      );

      expect(create.code).toBe(EXIT_CODE.ok);
      expect(trace(create)).toEqual([
        'GET /api/engines',
        'POST /api/agents',
        `GET ${POLICY_PATH}`,
        `PUT ${POLICY_PATH}`,
      ]);
      // Exactly one field of the stored policy differs from the one the server already had.
      expect(create.calls[3]?.json).toEqual({ ...FIXTURES.policy, engine: 'claude-agent-sdk' });
    });

    it('update with --engine alone changes the policy arm and sends no PATCH', async () => {
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'claude-agent-sdk'], {
        route: engineAwareRoute,
      });

      expect(update.code).toBe(EXIT_CODE.ok);
      expect(trace(update)).toEqual([
        'GET /api/engines',
        `GET ${AGENT_PATH}`,
        `GET ${POLICY_PATH}`,
        `PUT ${POLICY_PATH}`,
      ]);
    });

    it('update with --engine and a patch still sends the patch', async () => {
      const update = await runCli(
        ['agents', 'update', IDS.agent, '--name', 'Renamed', '--engine', 'claude-agent-sdk'],
        { route: engineAwareRoute },
      );

      expect(trace(update)).toEqual([
        'GET /api/engines',
        `PATCH ${AGENT_PATH}`,
        `GET ${POLICY_PATH}`,
        `PUT ${POLICY_PATH}`,
      ]);
      expect(update.calls[1]?.json).toEqual({ name: 'Renamed' });
    });

    const OPENAI_ENGINE = {
      ...FIXTURES.engine,
      id: 'openai-agents',
      displayName: 'OpenAI Agents SDK',
    };

    /** `engineAwareRoute`, with openai-agents installed and the stored policy replaced. */
    function openAiRoute(
      policy: unknown,
      put?: () => Response,
    ): (request: { readonly url: URL; readonly method: string }) => Response {
      return (request) => {
        if (request.url.pathname === '/api/engines') {
          return json(200, { engines: [FIXTURES.engine, OPENAI_ENGINE] });
        }
        if (request.url.pathname === POLICY_PATH && request.method === 'GET') {
          return json(200, { policy });
        }
        if (request.url.pathname === POLICY_PATH && put !== undefined) return put();
        return engineAwareRoute(request);
      };
    }

    it('update --engine openai-agents carries the Claude denials into withheld switches (ADR-0074 D12)', async () => {
      // ENG-09 (#308): the Claude arm's `tools` is that engine's own grammar and the openai-agents
      // arm is strict, so it is not copied — but what it denied is carried, never dropped (PR #339).
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'openai-agents'], {
        route: openAiRoute(FIXTURES.policy),
      });

      expect(update.code, update.stderr).toBe(EXIT_CODE.ok);
      expect(update.calls.at(-1)?.method).toBe('PUT');
      expect(update.calls.at(-1)?.json).toEqual({
        engine: 'openai-agents',
        withheldPermissions: ['runCommands'],
        skills: FIXTURES.policy.skills,
        limits: FIXTURES.policy.limits,
      });
      // Shown before it is applied.
      expect(update.stderr).toContain('engine switch claude-agent-sdk -> openai-agents:');
      expect(update.stderr).toContain('carried  Bash -> withholds shell');
    });

    it('update --engine openai-agents shows a plan mode and a tool with no equivalent', async () => {
      const policy = {
        ...FIXTURES.policy,
        tools: { ...FIXTURES.policy.tools, deny: ['WebFetch'], permissionMode: 'plan' },
      };
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'openai-agents'], {
        route: openAiRoute(policy),
      });

      expect(update.code, update.stderr).toBe(EXIT_CODE.ok);
      expect(update.stderr).toContain(
        'carried  permissionMode: plan -> withholds apply_patch, shell',
      );
      expect(update.stderr).toContain('absent   WebFetch');
      expect(update.calls.at(-1)?.json).toMatchObject({
        withheldPermissions: ['writeFiles', 'runCommands'],
      });
    });

    it('update --engine pi names a carried unrestrictedNetwork as network egress, not an empty list', async () => {
      const piEngine = { ...FIXTURES.engine, id: 'pi', displayName: 'pi coding agent' };
      const policy = {
        engine: 'openai-agents',
        withheldPermissions: ['unrestrictedNetwork'],
        skills: FIXTURES.policy.skills,
        limits: FIXTURES.policy.limits,
      };
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'pi'], {
        route: (request) =>
          request.url.pathname === '/api/engines'
            ? json(200, { engines: [FIXTURES.engine, OPENAI_ENGINE, piEngine] })
            : openAiRoute(policy)(request),
      });

      expect(update.code, update.stderr).toBe(EXIT_CODE.ok);
      expect(update.stderr).toContain('engine switch openai-agents -> pi:');
      expect(update.stderr).toContain(
        'carried  withheldPermissions: unrestrictedNetwork -> withholds (network egress)',
      );
      expect(update.calls.at(-1)?.json).toMatchObject({
        engine: 'pi',
        withheldPermissions: ['unrestrictedNetwork'],
      });
    });

    it('update --engine mastra carries a Claude denial into withheld Mastra workspace tools (ENG-10, #309)', async () => {
      const mastraEngine = { ...FIXTURES.engine, id: 'mastra', displayName: 'Mastra' };
      const policy = {
        ...FIXTURES.policy,
        tools: { ...FIXTURES.policy.tools, deny: ['Bash'] },
      };
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'mastra'], {
        route: (request) =>
          request.url.pathname === '/api/engines'
            ? json(200, { engines: [FIXTURES.engine, mastraEngine] })
            : openAiRoute(policy)(request),
      });

      expect(update.code, update.stderr).toBe(EXIT_CODE.ok);
      expect(update.stderr).toContain('engine switch claude-agent-sdk -> mastra:');
      expect(update.stderr).toContain(
        'carried  Bash -> withholds mastra_workspace_execute_command',
      );
      expect(update.calls.at(-1)?.json).toMatchObject({
        engine: 'mastra',
        withheldPermissions: ['runCommands'],
      });
    });

    it('update --engine openai-agents refuses an MCP denial it cannot carry, and writes nothing', async () => {
      const policy = {
        ...FIXTURES.policy,
        tools: { ...FIXTURES.policy.tools, deny: ['Bash', 'mcp__github__delete_repo'] },
      };
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'openai-agents'], {
        route: openAiRoute(policy),
      });

      expect(update.code).toBe(EXIT_CODE.usage);
      expect(update.stderr).toContain('refused  mcp__github__delete_repo');
      expect(update.stderr).toContain('engine_switch_would_widen');
      expect(update.calls.map((call) => call.method)).not.toContain('PUT');
    });

    it("surfaces the server's typed engine_switch_would_widen refusal", async () => {
      // The route is the authority: a policy that changed between this GET and the PUT is refused
      // there, and the CLI reports the server's code rather than a generic failure.
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'openai-agents'], {
        route: openAiRoute(FIXTURES.policy, () =>
          json(422, {
            error: {
              code: 'engine_switch_would_widen',
              message: 'would drop a denial',
              details: ['mcp__github__delete_repo'],
            },
          }),
        ),
      });

      expect(update.code).not.toBe(EXIT_CODE.ok);
      expect(update.stderr).toContain('engine_switch_would_widen');
    });

    it('refuses to move an openai-agents policy to claude-agent-sdk without a tool policy', async () => {
      const onOpenAi = {
        engine: 'openai-agents',
        skills: FIXTURES.policy.skills,
        limits: FIXTURES.policy.limits,
      };
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'claude-agent-sdk'], {
        route: (request) =>
          request.url.pathname === POLICY_PATH
            ? json(200, { policy: onOpenAi })
            : engineAwareRoute(request),
      });

      expect(update.code).toBe(EXIT_CODE.usage);
      expect(update.stderr).toContain('aw agents policy set');
      expect(update.calls.map((call) => call.method)).not.toContain('PUT');
    });

    it('--engine pi surfaces unsupported_engine and creates nothing', async () => {
      const create = await runCli(['agents', 'create', '--file', '-', '--engine', 'pi'], {
        stdin: JSON.stringify(body),
        route: engineAwareRoute,
      });

      expect(create.code).toBe(EXIT_CODE.usage);
      expect(create.stderr).toContain('unsupported_engine');
      expect(create.stderr).toContain('claude-agent-sdk');
      // The catalogue was read, and nothing else: no agent exists to be left on a wrong engine.
      expect(trace(create)).toEqual(['GET /api/engines']);
    });

    it('refuses an engine the catalogue lists but this deployment has not installed', async () => {
      const update = await runCli(['agents', 'update', IDS.agent, '--engine', 'claude-agent-sdk'], {
        route: (request) =>
          request.url.pathname === '/api/engines'
            ? json(200, { engines: [{ ...FIXTURES.engine, installed: false }] })
            : engineAwareRoute(request),
      });

      expect(update.code).toBe(EXIT_CODE.usage);
      expect(update.stderr).toContain('unsupported_engine');
      expect(update.stderr).toContain('no engine at all');
      expect(trace(update)).toEqual(['GET /api/engines']);
    });

    it('refuses a locally malformed command before asking the catalogue', async () => {
      const create = await runCli(['agents', 'create', '--engine', 'claude-agent-sdk'], {
        route: engineAwareRoute,
      });
      const update = await runCli(['agents', 'update', '--engine', 'claude-agent-sdk'], {
        route: engineAwareRoute,
      });

      expect(create.code).toBe(EXIT_CODE.usage);
      expect(trace(create)).toEqual([]);
      expect(update.code).toBe(EXIT_CODE.usage);
      expect(trace(update)).toEqual([]);
    });

    it('names the created agent and the recovery command when the policy write fails', async () => {
      const create = await runCli(
        ['agents', 'create', '--file', '-', '--engine', 'claude-agent-sdk'],
        {
          stdin: JSON.stringify(body),
          route: (request) =>
            request.method === 'PUT' && request.url.pathname === POLICY_PATH
              ? json(403, { error: { code: 'forbidden', message: 'not allowed' } })
              : engineAwareRoute(request),
        },
      );

      expect(create.code).toBe(EXIT_CODE.problem);
      expect(create.stderr).toContain(`aw agents update ${IDS.agent} --engine claude-agent-sdk`);
      expect(create.stderr).toContain('forbidden');
    });

    it('without --engine, neither the catalogue nor the policy route is touched', async () => {
      const create = await runCli(['agents', 'create', '--file', '-'], {
        stdin: JSON.stringify(body),
        route: engineAwareRoute,
      });

      expect(trace(create)).toEqual(['POST /api/agents']);
    });
  });
});
