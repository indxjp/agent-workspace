import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FieldVerdict, PlatformFile } from '@indx-workspace/contracts/platforms';
import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import type { PlatformImportResult } from '../../port.js';
import { SAMPLE_PORTABLE_PROJECT } from '../../testing/sample.js';
import { importFoundry } from './import.js';
import { microsoftFoundryTarget } from './index.js';

const GOLDEN = join(fileURLToPath(new URL('.', import.meta.url)), '__golden__');
const FIXTURES = join(GOLDEN, 'vendor-fixtures');
const MODEL_OPTIONS = { modelDeployment: 'claude-sonnet-4-6' };

function imported(files: readonly PlatformFile[]) {
  const result = importFoundry(files);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  return result;
}

function refusal(files: readonly PlatformFile[]) {
  const result: PlatformImportResult = importFoundry(files);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function compiledSample(): PlatformFile[] {
  const result = compileForPlatform(
    microsoftFoundryTarget,
    PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
    MODEL_OPTIONS,
  );
  if (!result.ok) throw new Error('compile refused');
  return [...result.files];
}

/** A vendor fixture with the shell placeholders of its `curl` body filled in. */
function vendorFixture(file: string): Record<string, unknown> {
  const text = readFileSync(join(FIXTURES, file), 'utf8')
    .replaceAll("'$FOUNDRY_MODEL_DEPLOYMENT_NAME'", 'gpt-5')
    .replaceAll(
      "'$FOUNDRY_PROJECT_ENDPOINT'",
      'https://acme.services.ai.azure.com/api/projects/demo',
    )
    .replaceAll('<AGENT_NAME>', 'docs-agent')
    .replaceAll('<version>', '1');
  return JSON.parse(text) as Record<string, unknown>;
}

function entryAt(report: readonly FieldVerdict[], path: string): FieldVerdict {
  const entry = report.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no verdict at ${path}`);
  return entry;
}

function versionFile(path: string, body: unknown): PlatformFile {
  return { path, content: JSON.stringify(body) };
}

function version(tools: unknown[], extra: Record<string, unknown> = {}) {
  return { definition: { kind: 'prompt', model: 'gpt-5', instructions: 'Help.', tools }, ...extra };
}

describe('importFoundry', () => {
  const goldenPath = join(GOLDEN, 'import/expected.project.json');

  it('imports what compile emitted to the golden project', () => {
    const { project } = imported(compiledSample());
    if (process.env['UPDATE_GOLDEN'] === '1') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, `${JSON.stringify(project, null, 2)}\n`);
    }
    expect(JSON.parse(JSON.stringify(project))).toEqual(
      JSON.parse(readFileSync(goldenPath, 'utf8')),
    );
  });

  it('restores the root, the subagent and the model, and reports what it dropped', () => {
    const { project, report } = imported(compiledSample());
    const original = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT).agents;
    expect(project.root).toBe('support-triage');
    expect(project.agents[0]).toMatchObject({
      name: 'support-triage',
      instructions: original[0]?.instructions,
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      subagents: [{ name: 'billing-specialist' }],
    });
    expect(entryAt(report, 'support-triage.model')).toMatchObject({ verdict: 'mapped' });
    expect(entryAt(report, 'support-triage.model').note).toContain('aw.model');
    expect(report).toContainEqual(
      expect.objectContaining({ verdict: 'dropped', code: 'field_unsupported' }),
    );
  });

  it('finds the root without the plan: the agent no a2a tool points at', () => {
    const files = compiledSample().filter((file) => file.path !== 'project.plan.json');
    expect(imported([...files].reverse()).project.root).toBe('support-triage');
  });

  it('restores a subagent whose a2a connection name was fitted', () => {
    const subagent = 'b'.repeat(60);
    const result = compileForPlatform(
      microsoftFoundryTarget,
      PortableProjectSchema.parse({
        ...SAMPLE_PORTABLE_PROJECT,
        agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent) =>
          agent.name === 'support-triage'
            ? { ...agent, subagents: [{ name: subagent }] }
            : agent.name === 'billing-specialist'
              ? { ...agent, name: subagent }
              : agent,
        ),
      }),
      MODEL_OPTIONS,
    );
    if (!result.ok) throw new Error('compile refused');
    const files = result.files.filter((file) => file.path !== 'project.plan.json');
    const { project } = imported([...files].reverse());
    expect(project.root).toBe('support-triage');
    expect(project.agents[0]?.subagents).toEqual([{ name: subagent }]);
  });

  it('keeps a model id that holds a slash but names no provider', () => {
    const { project, report } = imported([
      versionFile('a.version.json', version([], { metadata: { 'aw.model': 'meta/llama-4' } })),
    ]);
    expect(project.agents[0]?.model).toEqual({ id: 'meta/llama-4' });
    expect(entryAt(report, 'a.model').note).toContain('aw.model');
  });

  it('reads the root from a plan of another shape, and notes a root it cannot use', () => {
    const files = [
      versionFile('a.version.json', version([])),
      versionFile('b.version.json', version([])),
    ];
    const plan = (body: unknown) => versionFile('project.plan.json', body);
    const stale = imported([...files, plan({ root: 'b', agents: [], extra: true })]);
    expect(stale.project.root).toBe('b');
    expect(stale.report.some((entry) => entry.path === 'import.root')).toBe(false);
    for (const body of [{ root: 'missing' }, { root: 7 }, 'not a plan']) {
      const unusable = imported([...files, plan(body)]);
      expect(unusable.project.root).toBe('a');
      expect(entryAt(unusable.report, 'import.root').note).toContain('project.plan.json');
    }
  });

  it('keeps no subagent on a non-root agent', () => {
    const { project, report } = imported([
      versionFile(
        'a.version.json',
        version([{ type: 'a2a', project_connection_id: 'aw-agent-b' }]),
      ),
      versionFile(
        'b.version.json',
        version([{ type: 'a2a', project_connection_id: 'aw-agent-a' }]),
      ),
    ]);
    expect(project.root).toBe('a');
    expect(project.agents.find((agent) => agent.name === 'b')?.subagents).toEqual([]);
    expect(report).toContainEqual(
      expect.objectContaining({ path: 'b.tools.0', code: 'subagents_unsupported' }),
    );
    expect(report).toContainEqual(expect.objectContaining({ path: 'import.root' }));
  });

  describe('vendor fixtures', () => {
    it('imports the Learn MCP agent: a remote server whose credential is not imported', () => {
      const { project, report } = imported([
        versionFile('mcp.version.json', vendorFixture('learn-mcp-agent.txt')),
      ]);
      expect(project.root).toBe('docs-agent-mcp');
      expect(project.agents[0]).toMatchObject({
        description: 'MCP agent',
        model: { id: 'gpt-5' },
        tools: [
          {
            kind: 'mcp',
            name: 'toolbox',
            transport: 'streamable-http',
            url: 'https://acme.services.ai.azure.com/api/projects/demo/toolboxes/mcp-server-toolbox/versions/1/mcp?api-version=v1',
          },
        ],
      });
      expect(entryAt(report, 'docs-agent-mcp.tools.0')).toMatchObject({ verdict: 'mapped' });
      expect(entryAt(report, 'docs-agent-mcp.tools.0').note).toContain('mcp-server-toolbox-conn');
    });

    it('drops the Learn OpenAPI tool: an inline spec has no portable form', () => {
      const { tools } = vendorFixture('learn-openapi-tool.txt');
      const { project, report } = imported([
        versionFile('weather.version.json', version(tools as unknown[])),
      ]);
      expect(project.agents[0]?.tools).toEqual([]);
      expect(report).toContainEqual(
        expect.objectContaining({
          path: 'weather.tools.0',
          verdict: 'dropped',
          code: 'field_unsupported',
        }),
      );
    });

    it('imports an OpenAPI tool that references its spec', () => {
      const { project } = imported([
        versionFile(
          'orders.version.json',
          version([
            {
              type: 'openapi',
              openapi: { name: 'orders-api', spec: { $ref: 'openapi/orders.json' } },
            },
          ]),
        ),
      ]);
      expect(project.agents[0]?.tools).toEqual([
        { kind: 'openapi', name: 'orders-api', specRef: 'openapi/orders.json' },
      ]);
    });

    it('imports the Learn A2A tool as a subagent of the root', () => {
      const root = vendorFixture('learn-a2a-version.hand-rendered.txt');
      const { project } = imported([
        versionFile('helper.version.json', root),
        versionFile('billing-specialist.version.json', version([])),
      ]);
      expect(project.root).toBe('helper');
      expect(project.agents[0]?.subagents).toEqual([{ name: 'billing-specialist' }]);
    });

    it('drops an A2A tool that points at an agent that was not imported', () => {
      const root = vendorFixture('learn-a2a-version.hand-rendered.txt');
      const { project, report } = imported([versionFile('helper.version.json', root)]);
      expect(project.agents[0]?.subagents).toEqual([]);
      expect(report).toContainEqual(
        expect.objectContaining({ path: 'helper.tools.0', code: 'subagents_unsupported' }),
      );
    });

    it('drops file_search with its vector store id, flat or nested', () => {
      const flat = vendorFixture('file-search-direct.hand-rendered.txt');
      const nested = version([
        { type: 'file_search', file_search: { vector_store_ids: ['vs_two'] } },
      ]);
      for (const [body, id] of [
        [flat, 'vs_example'],
        [nested, 'vs_two'],
      ] as const) {
        const { report } = imported([versionFile('search.version.json', body)]);
        expect(entryAt(report, 'search.tools.0')).toMatchObject({ code: 'knowledge_unsupported' });
        expect(entryAt(report, 'search.tools.0').note).toContain(id);
      }
    });
  });

  it('maps the built-in tools and drops a tool type it does not know', () => {
    const { project, report } = imported([
      versionFile(
        'tools.version.json',
        version([
          { type: 'web_search' },
          { type: 'code_interpreter', container: { type: 'auto' } },
          { type: 'bing_grounding' },
        ]),
      ),
    ]);
    expect(project.agents[0]?.tools).toEqual([
      { kind: 'builtin', id: 'web_search' },
      { kind: 'builtin', id: 'code_execution' },
    ]);
    expect(report).toContainEqual(
      expect.objectContaining({ path: 'tools.tools.2', code: 'builtin_unsupported' }),
    );
  });

  it('does not rebuild the shared aw-tools server into code tools', () => {
    const { project, report } = imported([
      versionFile(
        'x.version.json',
        version([
          { type: 'mcp', server_label: 'aw-tools', server_url: 'https://tools.example.com/mcp' },
        ]),
      ),
    ]);
    expect(project.agents[0]?.tools).toEqual([]);
    expect(report).toContainEqual(
      expect.objectContaining({ path: 'x.tools.0', code: 'field_unsupported' }),
    );
  });

  describe('refusals', () => {
    it('refuses files that hold no agent version', () => {
      expect(refusal([{ path: 'README.md', content: '# hi' }])).toMatchObject({
        code: 'platform_agent_not_found',
      });
    });

    it.each([
      ['not JSON', { path: 'a.version.json', content: '{' }, 'a.version.json: is not valid JSON'],
      [
        'not UTF-8',
        { path: 'a.version.json', content: new Uint8Array([0xff, 0xfe]) },
        'a.version.json: is not valid UTF-8',
      ],
      [
        'a hosted agent',
        versionFile('a.version.json', { definition: { kind: 'hosted', model: 'm' } }),
        'a.version.json: definition.kind',
      ],
      [
        'a name that is not a portable name',
        versionFile('Not_Kebab.version.json', version([])),
        'Not_Kebab.version.json: name',
      ],
    ])('refuses %s, naming the file and the field only', (_label, file, detail) => {
      const result = refusal([file]);
      expect(result.code).toBe('platform_options_invalid');
      expect(result.details).toEqual([detail]);
    });

    it('names the invalid path of a version and never echoes its value', () => {
      const result = refusal([
        versionFile('a.version.json', {
          definition: { kind: 'prompt', model: 7, secret: 'hunter2' },
        }),
      ]);
      expect(result.details).toEqual(['a.version.json: definition.model']);
      expect(JSON.stringify(result)).not.toContain('hunter2');
    });

    it('refuses a files argument that is not a file list', () => {
      expect(refusal(null as unknown as PlatformFile[])).toMatchObject({
        code: 'platform_options_invalid',
      });
    });
  });
});
