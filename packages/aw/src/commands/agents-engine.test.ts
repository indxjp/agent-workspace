import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { FIXTURES, IDS, json, runCli } from '../testing.js';

import {
  AGENT_PATH,
  OPENAI_ENGINE,
  POLICY_PATH,
  body,
  engineAwareRoute,
  openAiRoute,
  trace,
} from './agents.scenarios.test-support.js';
describe('aw agents', () => {
  describe('--engine (ENG-02c, issue #319)', () => {
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
