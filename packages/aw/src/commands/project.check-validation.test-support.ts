import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, stdoutJson, tempDirectory, tempFile } from '../testing.js';
import {
  DEFINE,
  agentFile,
  aw,
  directories,
  emptyServer,
  missingReferences,
  problem,
  project,
  requests,
  server,
  surfaceFile,
} from './project.fixture.test-support.js';

export function describeProjectCheckValidation(): void {
  it('refuses a model id its connection does not offer, before any dry run (BH061-019)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", model: { connection: 'anthropic', id: 'claude-y' }"),
    });
    const inner = server(emptyServer());
    const run = await aw(root, ['check'], (request) => {
      const { pathname } = request.url;
      if (pathname === '/api/model-connections') {
        return json(200, { models: [FIXTURES.modelConnection] });
      }
      if (pathname === '/api/models') return json(200, { models: [FIXTURES.discoveredModel] });
      return inner(request);
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "agents/assistant.ts: local model_not_found [model 'claude-y' is not offered by the connection 'anthropic' (did you mean 'claude-x'?)]\n",
    );
    expect(requests(run)).not.toContain('POST /api/agents');
  });

  it('says how to name a model when model: names a connection the workspace lacks (BH061-019)', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", model: 'claude-haiku-4-5'"),
    });
    const run = await aw(root, ['check'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : missingReferences(['model-connection:claude-haiku-4-5']),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      "agents/assistant.ts: 422 agent_definition_references_missing [model-connection:claude-haiku-4-5]; model: 'claude-haiku-4-5' names a model connection the workspace lacks; to choose a model, write model: { connection: 'default', id: 'claude-haiku-4-5' }\n",
    );
  });

  it("attributes a server's surfaces.<i> issue to that surface's file", async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/a.ts': surfaceFile('a'),
      'surfaces/b.ts': surfaceFile('b'),
    });
    const run = await aw(root, ['check', '--json'], (request) =>
      request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(400, 'invalid_agent_version', [
            'surfaces.1.theme: is not a theme',
            'definition.agent.name: is taken',
          ]),
    );
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      ok: false,
      problems: [
        {
          file: 'surfaces/b.ts',
          status: 400,
          code: 'invalid_agent_version',
          details: ['surfaces.1.theme: is not a theme'],
        },
        {
          file: 'agents/assistant.ts',
          status: 400,
          code: 'invalid_agent_version',
          details: ['definition.agent.name: is taken'],
        },
      ],
    });
  });

  it('refuses an enum with Node’s reason, before any request', async () => {
    const root = await project({
      'agents/assistant.ts': `${agentFile()}\nenum Tone { Calm }\n`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe(
      '✗ agents/assistant.ts:5:1  TypeScript enum is not supported in strip-only mode\n',
    );
    expect(run.calls).toEqual([]);
  });

  it('refuses a file with no default export, and one whose export is not a definition', async () => {
    const root = await project({
      'agents/assistant.ts': `${DEFINE}\nexport const agent = 1;\n`,
      'agents/other.ts': `export default { name: 'other', instructions: 'x' };\n`,
      'surfaces/main.ts': `export default { name: 'main', agent: 'assistant' };\n`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: local default_export_missing [the file must `export default` its definition]',
      'agents/other.ts: local not_a_definition [the default export must be made by defineAgent()]',
      'surfaces/main.ts: local not_a_definition [the default export must be made by defineSurface()]',
      '',
    ]);
    expect(run.stderr).toBe('error: 3 problems\n');
    expect(run.calls).toEqual([]);
  });

  it('refuses every import but the define subpath, static or dynamic', async () => {
    const root = await project({
      'agents/assistant.ts': `import { readFileSync } from 'node:fs';\n${agentFile()}`,
      'agents/helper.ts': `import { x } from './shared.ts';\n${agentFile('', 'helper')}`,
      'agents/dynamic.ts': `await import('node:fs');\n${agentFile('', 'dynamic')}`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: local import_refused [node:fs]',
      'agents/dynamic.ts: local import_refused [import()]',
      'agents/helper.ts: local import_refused [./shared.ts]',
      '',
    ]);
    expect(run.calls).toEqual([]);
  });

  it('reports a DefinitionError as the 400 the server would give', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(", permissions: { readFiles: 'yes' }"),
    });
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      ok: false,
      problems: [{ file: 'agents/assistant.ts', status: 400, code: 'invalid_agent_version' }],
    });
    expect(run.calls).toEqual([]);
  });

  it('reads .md instructions beside the file, and refuses a missing or escaping one', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: { file: './assistant.md' }",
      ),
      'agents/assistant.md': '# Be kind\n',
      'agents/missing.ts': agentFile('', 'missing').replace(
        "instructions: 'Help people.'",
        "instructions: { file: './missing.md' }",
      ),
      'agents/linked.ts': agentFile('', 'linked').replace(
        "instructions: 'Help people.'",
        "instructions: { file: './outside/secret.md' }",
      ),
    });
    const outside = await tempDirectory();
    directories.push(outside);
    await tempFile(outside, 'secret.md', 'not the project’s\n');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(outside, path.join(root, 'agents', 'outside'), 'junction');
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'agents/linked.ts: local instructions_unreadable [./outside/secret.md is outside the project]',
      'agents/missing.ts: local instructions_unreadable [./missing.md]',
      '',
    ]);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.version.body.definition.agent.instructions).toBe('# Be kind\n');
  });

  it('refuses a surface naming an unknown agent, and duplicate surface and agent names', async () => {
    const root = await project({
      'agents/a.ts': agentFile(),
      'agents/b.ts': agentFile(),
      'surfaces/main.ts': surfaceFile('main'),
      'surfaces/other.ts': surfaceFile('main'),
      'surfaces/stray.ts': surfaceFile('stray', 'nobody'),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/b.ts: local agent_name_duplicate [assistant]',
      'surfaces/other.ts: local surface_name_duplicate [main]',
      'surfaces/stray.ts: local surface_agent_unknown [nobody]',
      '',
    ]);
    expect(run.calls).toEqual([]);
  });

  it('sends the files’ console output to stderr, keeping --json clean', async () => {
    const root = await project({
      'agents/assistant.ts': `console.log('hello from the agent');\n${agentFile()}`,
    });
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('hello from the agent');
    expect(stdoutJson(run)).toMatchObject({ ok: true });
  });

  it('refuses a directory with no agents/*.ts', async () => {
    const root = await project({ 'surfaces/main.ts': surfaceFile('main') });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('no agents/*.ts or agents/*.agent.md in this directory');
    expect(run.calls).toEqual([]);
  });
}
