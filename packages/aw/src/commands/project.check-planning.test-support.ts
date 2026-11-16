import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { IDS, json, stdoutJson, tempFile } from '../testing.js';
import {
  agentFile,
  aw,
  CODE_TOOL_PROJECT,
  emptyServer,
  problem,
  project,
  requests,
  server,
  surfaceFile,
  writes,
} from './project.fixture.test-support.js';

export function describeProjectCheckPlanning(): void {
  it('dry-runs a new agent through POST /api/agents and prints the number it would get', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/main.ts': surfaceFile('main'),
    });
    const run = await aw(root, ['check']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 1)\n');
    expect(requests(run)).toEqual(['GET /api/agents', 'POST /api/agents']);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.dryRun).toBe(true);
    expect(sent.version.via).toBe('aw-push');
    expect(sent.version.summary).toBe('aw push: agents/assistant.ts');
    expect(sent.version.body.definition.agent.instructions).toBe('Help people.');
    expect(sent.version.body.surfaces).toEqual([
      { name: 'main', agent: 'assistant', title: 'Ask us' },
    ]);
  });

  it('reports each tool before the agents, a code tool as (code), and the bundle a push would upload', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['check'], server(state));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toMatch(
      /^tools\/get-order\.ts: get_order \(code\) ok\ntools\/get-order\.ts: tool bundle "get_order" \(\d+ bytes, sha256 [0-9a-f]{64}\) would be uploaded\nagents\/assistant\.ts: ok \(would be version 1\)\n$/u,
    );
    expect(writes(run)).toEqual([]);
    expect(state.bundles.size).toBe(0);
    const sent = CreateAgentFromVersionRequestSchema.parse(
      run.calls.find((call) => call.method === 'POST')?.json,
    );
    expect(sent.version.body.toolBundles?.map(({ tool }) => tool)).toEqual(['get_order']);
    expect(sent.version.body.toolBundles?.[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('dry-runs an agent the workspace has through its versions route', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['check', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(requests(run)).toEqual([
      'GET /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `GET /api/agents/${IDS.agent}/versions`,
    ]);
    expect(writes(run)).toEqual([]);
    expect(stdoutJson(run)).toEqual({
      ok: true,
      problems: [],
      tools: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: IDS.agent,
          action: 'none',
          version: 1,
          local: { from: 1, to: 1 },
        },
      ],
    });
  });

  it('says an agent pushed unchanged is unchanged, as aw push does (#559)', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['check'], server(state));
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (unchanged, local 1)\n');
    expect(requests(run)).toEqual([
      'GET /api/agents',
      `POST /api/agents/${IDS.agent}/versions`,
      `GET /api/agents/${IDS.agent}/versions`,
    ]);
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push'], server(state));
    expect(push.stdout).toBe('agents/assistant.ts: "assistant" is unchanged (local 1)\n');

    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    expect(state.versions).toHaveLength(2);
    const again = await aw(root, ['check'], server(state));
    expect(again.code).toBe(EXIT_CODE.ok);
    expect(again.stdout).toBe('agents/assistant.ts: ok (unchanged, local 2)\n');
    expect(writes(again)).toEqual([]);
  });

  it('prints the version a changed body would be saved as, the one aw push plans', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 2)\n');
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push', '--json'], server(state));
    expect(stdoutJson(push)).toMatchObject({
      agents: [{ action: 'version', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('says local would move to a newer version that already holds the body', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const first = state.versions[0];
    if (first === undefined) throw new Error('the first push saved no version');
    state.versions.push({ ...first, id: 'v-2', number: 2 });
    state.local = 1;
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'agents/assistant.ts: ok (version 2 already holds this definition; local would move from 1 to 2)\n',
    );
    expect(writes(run)).toEqual([]);
    const push = await aw(root, ['push', '--json'], server(state));
    expect(stdoutJson(push)).toMatchObject({
      agents: [{ action: 'point', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('says a version would be applied again over an edit made outside aw push', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    if (state.agent === null) throw new Error('the first push created no agent');
    state.agent = { ...state.agent, updatedAt: '2026-10-03T00:00:00.000Z' };
    state.materialised = null;
    const run = await aw(root, ['check'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe(
      'agents/assistant.ts: ok (edited outside aw push; version 1 would be applied again)\n',
    );
    expect(writes(run)).toEqual([]);
  });

  it('reports a refused versions read as a problem on that file, and exits 1', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const allowed = server(state);
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET' && request.url.pathname === `/api/agents/${IDS.agent}/versions`
        ? problem(403, 'forbidden')
        : allowed(request),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 403 forbidden\n');
    expect(run.stderr).toBe('error: 1 problem\n');
    expect(writes(run)).toEqual([]);
  });

  it('prints the 422 of an mcp() tool on an engine without mcp, and exits 1', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile(", tools: [mcp('github')]") });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'engine_capability_unsupported', ['mcp']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 422 engine_capability_unsupported [mcp]\n');
    expect(run.stderr).toBe('error: 1 problem\n');
  });

  it("prints a Viewer's 403, and exits 1", async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET' ? json(200, { agents: [] }) : problem(403, 'forbidden'),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('agents/assistant.ts: 403 forbidden\n');
  });
}
