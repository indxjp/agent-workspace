import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { json } from '../testing.js';
import {
  agentFile,
  aw,
  problem,
  project,
  projectYaml,
  sentEngine,
} from './project.fixture.test-support.js';

export function describeProjectConfiguration(): void {
  it("prints the server's 403 policy_cannot_widen as it answers, and exits 1 (C14)", async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(403, 'policy_cannot_widen', ['permissions.runCommands']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      'agents/assistant.ts: 403 policy_cannot_widen [permissions.runCommands]\n',
    );
  });

  it('never computes a widening itself: a server that answers 200 gets no 403 printed', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml('policy:\n  permissions:\n    runCommands: false\n'),
      'agents/assistant.ts': agentFile(', permissions: { runCommands: true }'),
    });
    const run = await aw(root, ['check']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(run.stdout + run.stderr).not.toContain('403');
  });

  it("checks an agent that names no engine on the project's engine, and keeps an agent's own (C12)", async () => {
    const yaml = projectYaml('engine: pi\n');
    const plain = await project({
      'agent-workspace.yaml': yaml,
      'agents/assistant.ts': agentFile(),
    });
    const run = await aw(plain, ['check']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(sentEngine(run)).toBe('pi');
    const own = await project({
      'agent-workspace.yaml': yaml,
      'agents/assistant.ts': agentFile(", engine: 'claude-agent-sdk'"),
    });
    expect(sentEngine(await aw(own, ['check']))).toBe('claude-agent-sdk');
  });

  it('withholds a secret the project file names from the definition files', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml(
        'connectors:\n  github:\n    url: https://mcp.example.com\n    auth:\n      scheme: bearer\n      credential:\n        secret: ORDERS_TOKEN\n',
      ),
      'agents/assistant.ts': `console.error('token=' + String(process.env.ORDERS_TOKEN));\n${agentFile()}`,
    });
    const run = await aw(root, ['check'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        ORDERS_TOKEN: 'never-seen',
      },
    });
    expect(run.stderr).toContain('token=undefined');
  });

  it('says models and connectors are applied by aw dev only when pushing to another workspace (SD7)', async () => {
    const models =
      'models:\n  default:\n    provider: anthropic\n    credential:\n      secret: ANTHROPIC_API_KEY\n';
    const notice = 'models and connectors are applied by aw dev only';
    const declared = await project({
      'agent-workspace.yaml': projectYaml(models),
      'agents/assistant.ts': agentFile(),
    });
    expect((await aw(declared, ['push'])).stderr).toContain(`${notice}\n`);
    const local = await aw(declared, ['push'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
    });
    expect(local.code, local.stderr).toBe(EXIT_CODE.ok);
    expect(local.stderr).not.toContain(notice);
    const slash = await aw(declared, ['push'], undefined, {
      env: {
        AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000/',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
      },
    });
    expect(slash.code, slash.stderr).toBe(EXIT_CODE.ok);
    expect(slash.stderr).not.toContain(notice);
    const none = await project({
      'agent-workspace.yaml': projectYaml(),
      'agents/assistant.ts': agentFile(),
    });
    expect((await aw(none, ['push'])).stderr).not.toContain(notice);
  });

  it('refuses a malformed agent-workspace.yaml at its line and column, before any request', async () => {
    const root = await project({
      'agent-workspace.yaml': projectYaml('surprise: true\n'),
      'agents/assistant.ts': agentFile(),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toMatch(/^error: agent-workspace\.yaml:\d+:\d+: /u);
    expect(run.calls).toEqual([]);
  });
}
