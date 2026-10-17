import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PlatformFile } from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import type { PlatformCompileResult } from '../../port.js';
import {
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/sample.js';
import { copilotStudioTarget } from './index.js';

const GOLDEN = join(fileURLToPath(new URL('.', import.meta.url)), '__golden__');
const OPTIONS = { publisherPrefix: 'acme' };

// Not project.json: Nx would read that file as a project configuration.
function loadGoldenProject(dir: string): PortableProject {
  return PortableProjectSchema.parse(
    JSON.parse(readFileSync(join(dir, 'portable-project.json'), 'utf8')),
  );
}

function build(
  edit: {
    root?: Partial<PortableAgentInput>;
    child?: Partial<PortableAgentInput>;
    project?: Partial<PortableProjectInput>;
  } = {},
): PortableProject {
  const [root, child] = SAMPLE_PORTABLE_PROJECT.agents;
  if (root === undefined || child === undefined) throw new Error('the sample lost its agents');
  return PortableProjectSchema.parse({
    ...SAMPLE_PORTABLE_PROJECT,
    ...edit.project,
    agents: [
      { ...root, ...edit.root },
      { ...child, ...edit.child },
    ],
  });
}

function compile(project: PortableProject, options: unknown = OPTIONS): PlatformCompileResult {
  return compileForPlatform(copilotStudioTarget, project, options);
}

function compiled(project: PortableProject, options: unknown = OPTIONS) {
  const result = compile(project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  return result;
}

function refusal(project: PortableProject, options: unknown = OPTIONS) {
  const result = compile(project, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function textOf(file: PlatformFile): string {
  return typeof file.content === 'string' ? file.content : '';
}

const SEED_TOPIC = 'kind: AdaptiveDialog\nbeginDialog:\n  kind: OnRecognizedIntent\n';

describe('copilot-studio goldens', () => {
  it.each(['full', 'no-tool-endpoint'])('compiles %s to its golden', (name) => {
    const dir = join(GOLDEN, name);
    const project = loadGoldenProject(dir);
    const options: unknown = JSON.parse(readFileSync(join(dir, 'options.json'), 'utf8'));
    const result = compile(project, options);
    expectGoldenFiles(result, dir);
    assertVerdictInvariants(copilotStudioTarget, project, result);
  });

  it('keeps the golden inputs equal to the shared sample', () => {
    expect(loadGoldenProject(join(GOLDEN, 'full'))).toEqual(
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT),
    );
    expect(loadGoldenProject(join(GOLDEN, 'no-tool-endpoint'))).toEqual(
      PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT),
    );
  });
});

describe('copilot-studio conformance', () => {
  it('passes the platform kit, including the import round trip', () => {
    runPlatformConformance(copilotStudioTarget, OPTIONS);
  });

  it('refuses missing or invalid options without echoing a value', () => {
    for (const options of [{}, { publisherPrefix: 'Not Valid Value' }]) {
      const result = compile(build(), options);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.refusal.code).toBe('platform_options_invalid');
      expect(JSON.stringify(result.refusal)).not.toContain('Not Valid Value');
    }
  });
});

describe('copilot-studio refusals', () => {
  it('accepts 8000 characters of instructions and refuses 8001, for the root and a child', () => {
    expect(compile(build({ root: { instructions: 'x'.repeat(8_000) } })).ok).toBe(true);
    expect(compile(build({ child: { instructions: 'x'.repeat(8_000) } })).ok).toBe(true);

    const root = refusal(build({ root: { instructions: 'x'.repeat(8_001) } }));
    expect(root.code).toBe('platform_limit_exceeded');
    expect(root.details).toEqual([
      'instructionsChars: max 8000, actual 8001, agent support-triage',
    ]);
    const child = refusal(build({ child: { instructions: 'x'.repeat(8_001) } }));
    expect(child.details).toEqual([
      'instructionsChars: max 8000, actual 8001, agent billing-specialist',
    ]);
  });

  function filesProject(count: number, urls = 0): PortableProject {
    const paths = Array.from({ length: count }, (_, index) => `k/f${index}.md`);
    const chunks = Array.from({ length: Math.ceil(count / 100) }, (_, index) =>
      paths.slice(index * 100, index * 100 + 100),
    );
    return build({
      root: {
        knowledge: [
          ...chunks.map((chunk) => ({ kind: 'files' as const, paths: chunk })),
          ...Array.from({ length: urls }, (_, index) => ({
            kind: 'url' as const,
            url: `https://docs.example.com/${index}`,
          })),
        ],
      },
      project: { knowledgeFiles: paths.map((path) => ({ path, content: 'x' })) },
    });
  }

  it('accepts 500 knowledge sources and refuses 501', () => {
    expect(compile(filesProject(500)).ok).toBe(true);
    expect(compile(filesProject(400, 100)).ok).toBe(true);
    expect(refusal(filesProject(400, 101)).details).toEqual([
      'knowledgeSources: max 500, actual 501',
    ]);
  });

  it('counts a repeated knowledge URL once', () => {
    const project = filesProject(499, 1);
    const [root, child] = project.agents;
    if (root === undefined || child === undefined) throw new Error('missing agents');
    const repeated = { kind: 'url' as const, url: 'https://docs.example.com/0' };
    const knowledge = [...root.knowledge, repeated];
    expect(compile({ ...project, agents: [{ ...root, knowledge }, child] }).ok).toBe(true);
  });

  it('refuses more than 500 uploaded files', () => {
    const result = refusal(filesProject(501));
    expect(result.code).toBe('platform_limit_exceeded');
    expect(result.details).toEqual(['uploadedFiles: max 500, actual 501']);
  });

  it('accepts 1000 topics and refuses 1001', () => {
    const topics = (count: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`t${index}`, SEED_TOPIC]));
    expect(compile(build(), { ...OPTIONS, topics: topics(1_000) }).ok).toBe(true);
    const result = refusal(build(), { ...OPTIONS, topics: topics(1_001) });
    expect(result.code).toBe('platform_limit_exceeded');
    expect(result.details).toEqual(['topics: max 1000, actual 1001']);
  });

  it('refuses a subagent that is not in the project', () => {
    const project = build();
    const [root, child] = project.agents;
    if (root === undefined || child === undefined) throw new Error('missing agents');
    const broken = { ...project, agents: [{ ...root, subagents: [{ name: 'ghost' }] }, child] };
    const result = refusal(broken);
    expect(result.code).toBe('platform_agent_not_found');
    expect(result.details).toEqual(['ghost']);
  });

  it('refuses a topic whose kind is not AdaptiveDialog, naming only the stem', () => {
    const result = refusal(build(), {
      ...OPTIONS,
      topics: { good: SEED_TOPIC, bad: 'kind: TaskDialog\n', broken: 'a: [' },
    });
    expect(result.code).toBe('platform_options_invalid');
    expect(result.details).toEqual([
      'topics.bad: kind must be AdaptiveDialog',
      'topics.broken: is not valid YAML',
    ]);
  });

  it('refuses two knowledge files that share a file name, naming both paths', () => {
    const result = refusal(
      build({
        root: { knowledge: [{ kind: 'files', paths: ['a/faq.md', 'b/faq.md'] }] },
        project: {
          knowledgeFiles: [
            { path: 'a/faq.md', content: 'a' },
            { path: 'b/faq.md', content: 'b' },
          ],
        },
      }),
    );
    expect(result.code).toBe('platform_options_invalid');
    expect(result.details).toEqual([
      'knowledge files a/faq.md and b/faq.md share the file name faq.md',
    ]);
  });

  it('refuses a knowledge file the project does not carry', () => {
    const result = refusal(build({ project: { knowledgeFiles: [] } }));
    expect(result.details).toEqual(['knowledge file knowledge/faq.md is not in the project']);
  });

  it('refuses an MCP or tool endpoint URL with a query string', () => {
    const [, ...rest] = SAMPLE_PORTABLE_PROJECT.agents[0]?.tools ?? [];
    const mcp = refusal(
      build({
        root: {
          tools: [
            {
              kind: 'mcp',
              name: 'zendesk',
              transport: 'streamable-http',
              url: 'https://mcp.example.com/zendesk?tenant=1',
            },
            ...rest,
          ],
        },
      }),
    );
    expect(mcp.code).toBe('platform_options_invalid');
    expect(mcp.details).toEqual([
      'tools.0: the MCP URL of zendesk: a Power Platform connector host and base path cannot carry a query string',
    ]);

    const endpoint = refusal(
      build({
        project: {
          toolEndpoint: {
            url: 'https://aw.example.com/mcp?project=acme',
            auth: { scheme: 'bearer', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
          },
        },
      }),
    );
    expect(endpoint.details).toEqual([
      'toolEndpoint: the URL: a Power Platform connector host and base path cannot carry a query string',
    ]);
  });

  it('reserves the MCP tool name aw-tools only while the tool endpoint is emitted', () => {
    const awTools = {
      kind: 'mcp' as const,
      name: 'aw-tools',
      transport: 'streamable-http' as const,
      url: 'https://mcp.example.com/aw-tools',
    };
    const codeTool = {
      kind: 'code' as const,
      name: 'get_order',
      description: 'd',
      inputSchema: {},
    };
    const reserved = refusal(build({ root: { tools: [awTools, codeTool] } }));
    expect(reserved.code).toBe('platform_options_invalid');
    expect(reserved.details).toEqual(['tools.0: the MCP tool name aw-tools is reserved']);

    const withoutEndpoint = build({
      root: { tools: [awTools, codeTool] },
      project: { toolEndpoint: undefined },
    });
    expect(compile(withoutEndpoint).ok).toBe(true);
  });
});

describe('copilot-studio verdicts', () => {
  const verdictOf = (project: PortableProject, path: string) =>
    compiled(project).report.find((entry) => entry.path === path);

  it('drops an SSE MCP tool with field_unsupported and emits nothing for it', () => {
    const project = build({
      root: {
        tools: [{ kind: 'mcp', name: 'old', transport: 'sse', url: 'https://mcp.example.com/old' }],
      },
    });
    expect(verdictOf(project, 'support-triage.tools.0')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
    const paths = compiled(project).files.map((file) => file.path);
    expect(paths.some((path) => path.includes('old'))).toBe(false);
  });

  it('drops a true permission and maps a false one', () => {
    const permissions = {
      readFiles: false,
      writeFiles: true,
      runCommands: false,
      unrestrictedNetwork: false,
    };
    const project = build({ root: { permissions } });
    expect(verdictOf(project, 'support-triage.permissions.writeFiles')).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    expect(verdictOf(project, 'support-triage.permissions.readFiles')?.verdict).toBe('mapped');
  });

  it('drops a child model that differs from the root, and a child permission that is true', () => {
    const project = build({
      child: {
        model: { provider: 'anthropic', id: 'claude-opus-4-1' },
        permissions: {
          readFiles: false,
          writeFiles: false,
          runCommands: true,
          unrestrictedNetwork: false,
        },
      },
    });
    expect(verdictOf(project, 'billing-specialist.model')).toMatchObject({
      code: 'subagents_unsupported',
    });
    expect(verdictOf(project, 'billing-specialist.permissions.runCommands')).toMatchObject({
      code: 'permissions_unsupported',
    });
  });

  it('drops a child code tool, by the endpoint rule first when there is no endpoint', () => {
    const child = {
      tools: [{ kind: 'code' as const, name: 'child_tool', description: 'd', inputSchema: {} }],
    };
    expect(verdictOf(build({ child }), 'billing-specialist.tools.0')).toMatchObject({
      code: 'subagents_unsupported',
    });
    const withoutEndpoint = build({ child, project: { toolEndpoint: undefined } });
    expect(verdictOf(withoutEndpoint, 'billing-specialist.tools.0')).toMatchObject({
      code: 'code_tool_needs_public_mcp',
    });
  });

  it('pins the model only through the option', () => {
    const pinned = compiled(build(), { ...OPTIONS, modelNameHint: 'my-model' });
    const agent = pinned.files.find((file) => file.path === 'agent/agent.mcs.yml');
    expect(agent === undefined ? '' : textOf(agent)).toContain('modelNameHint: my-model');
    const plain = compiled(build());
    expect(plain.files.map(textOf).join('\n')).not.toContain('modelNameHint');
    expect(plain.report.find((entry) => entry.path === 'support-triage.model')?.note).toContain(
      'environment default model',
    );
  });

  it('emits no actions and no connectors for an agent with no tools', () => {
    const project = build({
      root: { tools: [] },
      project: { toolEndpoint: undefined },
    });
    const result = compiled(project);
    const paths = result.files.map((file) => file.path);
    expect(paths.some((path) => path.startsWith('agent/actions/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('connectors/'))).toBe(false);
    assertVerdictInvariants(copilotStudioTarget, project, compile(project));
  });

  it('drops every field of an agent the root does not reach, and emits nothing for it', () => {
    const base = build();
    const [root, child] = base.agents;
    if (root === undefined || child === undefined) throw new Error('missing agents');
    const orphan = {
      ...root,
      name: 'orphan',
      tools: root.tools.filter((tool) => tool.kind !== 'mcp' || tool.transport !== 'stdio'),
      subagents: [{ name: 'billing-specialist' }],
      limits: undefined,
    };
    const project = { ...base, agents: [root, child, orphan] };
    const result = compiled(project);
    const verdicts = result.report.filter((entry) => entry.path.startsWith('orphan.'));
    expect(verdicts.length).toBeGreaterThan(0);
    for (const entry of verdicts) {
      expect(entry, entry.path).toMatchObject({
        verdict: 'dropped',
        code: 'subagents_unsupported',
      });
    }
    expect(result.files.some((file) => file.path.includes('orphan'))).toBe(false);
    assertVerdictInvariants(copilotStudioTarget, project, compile(project));
  });

  it('drops the tool endpoint when no root code tool uses it', () => {
    const project = build({ root: { tools: [] } });
    expect(compiled(project).report.find((entry) => entry.path === 'toolEndpoint')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
  });
});

describe('copilot-studio auth schemes', () => {
  type Scheme = 'bearer' | 'api-key' | 'oauth2';
  const zendesk = (scheme: Scheme) => ({
    kind: 'mcp' as const,
    name: 'zendesk',
    transport: 'streamable-http' as const,
    url: 'https://mcp.example.com/zendesk',
    auth: { scheme, secretRef: 'ZENDESK_TOKEN' },
  });
  const verdictOf = (project: PortableProject, path: string) =>
    compiled(project).report.find((entry) => entry.path === path);

  it.each(['api-key', 'oauth2'] as const)(
    'drops a %s MCP tool, naming the scheme, and emits no action or connector',
    (scheme) => {
      const project = build({
        root: { tools: [zendesk(scheme)] },
        project: { toolEndpoint: undefined },
      });
      const entry = verdictOf(project, 'support-triage.tools.0');
      expect(entry).toMatchObject({ verdict: 'dropped', code: 'field_unsupported' });
      expect(entry?.note).toContain(`auth scheme ${scheme}`);
      expect(entry?.note).toContain('ZENDESK_TOKEN');
      const paths = compiled(project).files.map((file) => file.path);
      expect(paths.some((path) => path.includes('zendesk'))).toBe(false);
      assertVerdictInvariants(copilotStudioTarget, project, compile(project));
    },
  );

  it('still maps a bearer MCP tool', () => {
    const project = build({ root: { tools: [zendesk('bearer')] } });
    expect(verdictOf(project, 'support-triage.tools.0')?.verdict).toBe('mapped');
  });

  it('drops an oauth2 tool endpoint and the root code tool, and emits no aw-tools files', () => {
    const project = build({
      project: {
        toolEndpoint: {
          url: 'https://aw.example.com/mcp/projects/acme-support',
          auth: { scheme: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
        },
      },
    });
    expect(verdictOf(project, 'toolEndpoint')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
    expect(verdictOf(project, 'toolEndpoint')?.note).toContain('auth scheme oauth2');
    expect(verdictOf(project, 'support-triage.tools.2')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
    const paths = compiled(project).files.map((file) => file.path);
    expect(paths.some((path) => path.includes('aw-tools'))).toBe(false);
    assertVerdictInvariants(copilotStudioTarget, project, compile(project));
  });

  it('does not refuse a dropped tool for its URL or reserved name', () => {
    const tool = { ...zendesk('oauth2'), name: 'aw-tools', url: 'https://mcp.example.com/z?t=1' };
    const project = build({ root: { tools: [tool] }, project: { toolEndpoint: undefined } });
    expect(compile(project).ok).toBe(true);
  });
});

describe('copilot-studio secrets', () => {
  const SECRETS = {
    ZENDESK_TOKEN: 'sentinel-7f3a91c2e8',
    ACME_TOOL_ENDPOINT_TOKEN: 'sentinel-b41d',
  };

  it('never emits a secret value, and names a secretRef only in its apiProperties.json', () => {
    const { files, report } = compiled(build());
    for (const file of files) {
      for (const value of Object.values(SECRETS)) expect(textOf(file)).not.toContain(value);
    }
    for (const name of Object.keys(SECRETS)) {
      const naming = files.filter((file) => textOf(file).includes(name)).map((file) => file.path);
      expect(naming).toEqual([
        name === 'ZENDESK_TOKEN'
          ? 'connectors/zendesk/apiProperties.json'
          : 'connectors/aw-tools/apiProperties.json',
      ]);
      expect(report.some((entry) => entry.note.includes(name))).toBe(true);
    }
  });
});
