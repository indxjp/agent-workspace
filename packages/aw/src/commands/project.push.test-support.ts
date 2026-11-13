import {
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
} from '@indx-workspace/contracts/agent-versions';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, stdoutJson, tempFile, type Route } from '../testing.js';
import {
  agentFile,
  aw,
  emptyServer,
  isDryRun,
  problem,
  project,
  server,
  surfaceFile,
  versionOf,
  writes,
} from './project.fixture.test-support.js';

export function describeProjectPush(): void {
  it('without --yes, shows the plan and sends only reads and dry runs', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(run.stdout).toBe(
      [
        'agents/assistant.ts: create "assistant" at version 1 (local none → 1)',
        '  + (root)',
        '',
      ].join('\n'),
    );
    expect(run.stderr).toContain('nothing was saved');
  });

  it('with --yes, creates a new agent from its first version and sends no PUT', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual(['POST /api/agents']);
    expect(stdoutJson(run)).toEqual({
      saved: true,
      problems: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: IDS.agent,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
          changes: [{ op: '+', path: '(root)' }],
          saved: true,
          surfaces: [],
        },
      ],
    });
    expect(state.local).toBe(1);
  });

  it("names each agent's surfaces in body order, the names aw dev prints lines for", async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/b.ts': surfaceFile('zeta'),
      'surfaces/a.ts': surfaceFile('alpha'),
    });
    const run = await aw(root, ['push', '--json']);
    expect(run.code, run.stderr).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toMatchObject({ agents: [{ surfaces: ['alpha', 'zeta'] }] });
  });

  it('a second push --yes of an unchanged body saves nothing and sends no PUT', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const run = await aw(root, ['push', '--yes'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(state.versions).toHaveLength(1);
    expect(run.stdout).toBe('agents/assistant.ts: "assistant" is unchanged (local 1)\n');
  });

  it('applies the newest version again when the agent was edited after local moved', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    // A legacy edit (the UI, PATCH) moves the agent row after the pointer, and saves no version.
    if (state.agent === null) throw new Error('the first push created no agent');
    state.agent = { ...state.agent, updatedAt: '2026-10-03T00:00:00.000Z' };
    state.materialised = null;
    const plan = await aw(root, ['push'], server(state));
    expect(writes(plan)).toEqual([]);
    expect(plan.stdout).toBe(
      'agents/assistant.ts: "assistant" was edited outside aw push; version 1 is applied again (local 1 → 1)\n',
    );
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([`PUT /api/agents/${IDS.agent}/pointers`]);
    expect(SetAgentPointerRequestSchema.parse(run.calls.at(-1)?.json)).toEqual({
      environment: 'local',
      version: 1,
    });
    expect(state.versions).toHaveLength(1);
    expect(stdoutJson(run)).toMatchObject({
      saved: true,
      agents: [
        {
          action: 'point',
          version: 1,
          local: { from: 1, to: 1 },
          changes: [],
          saved: true,
          surfaces: [],
        },
      ],
    });
  });

  it('reports which agents were written when a later one is refused', async () => {
    const root = await project({
      'agents/a.ts': agentFile('', 'one'),
      'agents/b.ts': agentFile('', 'two'),
    });
    let creates = 0;
    const run = await aw(root, ['push', '--yes', '--json'], (request) => {
      if (request.method === 'GET') return json(200, { agents: [] });
      if (isDryRun(request.json)) return json(200, { ok: true, number: 1 });
      creates += 1;
      if (creates > 1) return problem(409, 'agent_name_conflict');
      const body = CreateAgentFromVersionRequestSchema.parse(request.json);
      const version = versionOf(emptyServer(), body.version);
      return json(201, {
        agent: { ...FIXTURES.agent, modelConnectionId: null, name: 'one' },
        version,
      });
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'agents/b.ts', status: 409, code: 'agent_name_conflict' }],
      agents: [{ file: 'agents/a.ts', action: 'create', saved: true, surfaces: [] }],
    });
  });

  it('names the folder to upload into when the server refuses a files() grant, and --json does not', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const refuse: Route = (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'agent_definition_references_missing', ['file:contracts']);
    const run = await aw(root, ['push'], refuse);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(
      'agents/assistant.ts: 422 agent_definition_references_missing [file:contracts]; upload a file into contracts (aw files upload <folder>/<name> <local-file>), then save again or run aw push --yes\n',
    );
    const machine = await aw(root, ['push', '--json'], refuse);
    expect(machine.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(machine)).toMatchObject({
      problems: [
        {
          file: 'agents/assistant.ts',
          status: 422,
          code: 'agent_definition_references_missing',
          details: ['file:contracts'],
        },
      ],
    });
    expect(JSON.stringify(stdoutJson(machine))).not.toContain('upload a file');
  });

  it('points local at the newest version when it already holds the body', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    const first = state.versions[0];
    if (first === undefined) throw new Error('the first push saved no version');
    state.versions.push({ ...first, id: 'v-2', number: 2 });
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([`PUT /api/agents/${IDS.agent}/pointers`]);
    expect(SetAgentPointerRequestSchema.parse(run.calls.at(-1)?.json)).toEqual({
      environment: 'local',
      version: 2,
    });
    expect(stdoutJson(run)).toMatchObject({
      saved: true,
      agents: [{ action: 'point', version: 2, local: { from: 1, to: 2 } }],
    });
  });

  it('saves a changed body as a version via aw-push, then points local at it', async () => {
    const state = emptyServer();
    const root = await project({ 'agents/assistant.ts': agentFile() });
    expect((await aw(root, ['push', '--yes'], server(state))).code).toBe(EXIT_CODE.ok);
    await tempFile(
      root,
      'agents/assistant.ts',
      agentFile().replace('Help people.', 'Help people kindly.'),
    );
    const plan = await aw(root, ['push'], server(state));
    expect(plan.code).toBe(EXIT_CODE.ok);
    expect(writes(plan)).toEqual([]);
    expect(plan.stdout).toContain('agents/assistant.ts: version 2 of "assistant" (local 1 → 2)\n');
    expect(plan.stdout).toContain('  ~ definition.agent.instructions\n');

    const run = await aw(root, ['push', '--yes', '--summary', 'Kinder'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([
      `POST /api/agents/${IDS.agent}/versions`,
      `PUT /api/agents/${IDS.agent}/pointers`,
    ]);
    const saved = CreateAgentVersionRequestSchema.parse(
      run.calls.find((call) => call.method === 'POST' && !isDryRun(call.json))?.json,
    );
    expect(saved.via).toBe('aw-push');
    expect(saved.summary).toBe('Kinder');
    expect(state.versions).toHaveLength(2);
    expect(state.local).toBe(2);
  });

  it('writes nothing when the check finds a problem', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--yes', '--json'], (request) =>
      request.method === 'GET' ? json(200, { agents: [] }) : problem(403, 'forbidden'),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(writes(run)).toEqual([]);
    expect(stdoutJson(run)).toEqual({
      saved: false,
      problems: [{ file: 'agents/assistant.ts', status: 403, code: 'forbidden', details: [] }],
      agents: [],
    });
  });

  it('refuses an invalid --summary as a usage error, before loading anything', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push', '--summary', ' padded ']);
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls).toEqual([]);
  });

  it('keeps a transport failure as exit 4 rather than a problem', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile() });
    const run = await aw(root, ['push'], () => Promise.reject(new TypeError('fetch failed')));
    expect(run.code).toBe(EXIT_CODE.transport);
  });
}
