import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { stdoutJson, tempDirectory, tempFile } from '../testing.js';
import {
  agentFile,
  aw,
  directories,
  emptyServer,
  project,
  sentInstructions,
  server,
  surfaceFile,
} from './project.fixture.test-support.js';

export function describeProjectCheckFiles(): void {
  it('withholds the API key from the definition files', async () => {
    const root = await project({
      'agents/assistant.ts': `console.error('key=' + String(process.env.AGENT_WORKSPACE_API_KEY));\n${agentFile()}`,
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('key=undefined');
  });

  it("withholds every profile's apiKeyRef variable from the definition files", async () => {
    const home = await tempDirectory();
    directories.push(home);
    await tempFile(
      home,
      '.config/agent-workspace/profiles.json',
      JSON.stringify({ prod: { url: 'https://prod.example.com', apiKeyRef: 'AW_PROD_KEY' } }),
    );
    const root = await project({
      'agents/assistant.ts': `console.error('prod=' + String(process.env.AW_PROD_KEY) + ' other=' + String(process.env.AW_OTHER));\n${agentFile()}`,
    });
    const run = await aw(root, ['check'], server(emptyServer()), {
      homeDir: home,
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        AW_PROD_KEY: 'ak_live_profile_ref',
        AW_OTHER: 'kept',
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('prod=undefined other=kept');
  });

  it('gives import.meta the url, filename and dirname node gives a module', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: [import.meta.url, import.meta.filename, import.meta.dirname].join('|')",
      ),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    const file = path.join(root, 'agents', 'assistant.ts');
    expect(sentInstructions(run)).toBe(
      [pathToFileURL(file).href, file, path.join(root, 'agents')].join('|'),
    );
  });

  it('reads an instructions file in the project whose name starts with two dots', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile().replace(
        "instructions: 'Help people.'",
        "instructions: { file: './up/..prompt.md' }",
      ),
      '..prompt.md': 'From the root.\n',
    });
    // The SDK refuses a `..` segment, so only a link reaches the root; a junction needs no privilege.
    await symlink(root, path.join(root, 'agents', 'up'), 'junction');
    const run = await aw(root, ['check']);
    expect(run.stdout).toBe('agents/assistant.ts: ok (would be version 1)\n');
    expect(sentInstructions(run)).toBe('From the root.\n');
  });

  it('follows a linked definition file inside the project and refuses the others', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'shared/helper.ts': agentFile('', 'helper'),
    });
    const outside = await tempDirectory();
    directories.push(outside);
    await tempFile(outside, 'far.ts', agentFile('', 'far'));
    await mkdir(path.join(root, 'shared', 'folder.ts'));
    await symlink(
      path.join(root, 'shared', 'helper.ts'),
      path.join(root, 'agents', 'helper.ts'),
      'file',
    );
    await symlink(path.join(outside, 'far.ts'), path.join(root, 'agents', 'far.ts'), 'file');
    await symlink(path.join(root, 'missing.ts'), path.join(root, 'agents', 'gone.ts'), 'file');
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(
      path.join(root, 'shared', 'folder.ts'),
      path.join(root, 'agents', 'folder.ts'),
      'junction',
    );
    const run = await aw(root, ['check', '--json']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toEqual({
      ok: false,
      problems: [
        {
          file: 'agents/far.ts',
          status: null,
          code: 'file_link_refused',
          details: ['the link points outside the project'],
        },
        {
          file: 'agents/folder.ts',
          status: null,
          code: 'file_link_refused',
          details: ["the link's target is not a file"],
        },
        {
          file: 'agents/gone.ts',
          status: null,
          code: 'file_link_refused',
          details: ["the link's target does not exist"],
        },
      ],
      tools: [],
      agents: [
        {
          file: 'agents/assistant.ts',
          name: 'assistant',
          agentId: null,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
        },
        {
          file: 'agents/helper.ts',
          name: 'helper',
          agentId: null,
          action: 'create',
          version: 1,
          local: { from: null, to: 1 },
        },
      ],
    });
  });

  it('refuses a file name the loader cannot be handed, and still checks the others', async () => {
    const root = await project({
      'agents/assistant.ts': agentFile(),
      'surfaces/a\u200db.ts': surfaceFile('main'),
    });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout.split('\n')).toEqual([
      'agents/assistant.ts: ok (would be version 1)',
      'surfaces/a\u200db.ts: local file_name_unsupported [the name must not contain a control or format character, a backslash or a colon]',
      '',
    ]);
  });

  it.each([
    [4000, 'gateway'],
    [8080, 'runner'],
  ] as const)(
    "refuses a project file on the runtime's %i port (its %s) at its line, before any request (issue #560)",
    async (port, service) => {
      const root = await project({
        'agent-workspace.yaml': [
          'apiVersion: agentworkspace.dev/v2',
          'kind: Project',
          'name: demo',
          'environments:',
          '  local:',
          '    cloud: local',
          '    identity:',
          '      bootstrapAdmin: admin@localhost.test',
          `    port: ${String(port)}`,
          '',
        ].join('\n'),
        'agents/assistant.ts': agentFile(),
      });
      // No URL from the flags or the environment, so the project step reads the file.
      const run = await aw(root, ['check'], server(emptyServer()), { env: {} });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr.split('\n')[0]).toBe(
        `error: agent-workspace.yaml:9:5: environments.local.port is reserved by the local runtime's ${service} (${String(port)}); choose another port`,
      );
      expect(run.calls).toEqual([]);
    },
  );

  it('cuts the default summary of a long file name to the contract length', async () => {
    const name = 'a'.repeat(190);
    const root = await project({ [`agents/${name}.ts`]: agentFile() });
    const run = await aw(root, ['check']);
    expect(run.code).toBe(EXIT_CODE.ok);
    const sent = CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json);
    expect(sent.version.summary).toHaveLength(200);
    expect(sent.version.summary).toBe(`aw push: agents/${name.slice(0, 183)}…`);
  });
}
