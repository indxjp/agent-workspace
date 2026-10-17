import { describe, expect, it } from 'vitest';

import type { PortableAgentInput } from '@indx-workspace/contracts/portable-agent';
import { ProjectDocumentSchema } from '@indx-workspace/contracts/project-file';

import {
  defineAgent,
  defineTool,
  mcp,
  openapiTool,
  secret,
  skill,
  toAgentVersionBody,
  toolDefinitionsOf,
  z,
} from '../define/index.js';
import {
  formatAgentMarkdown,
  loadPortableProject,
  PortableProjectError,
  type LoadPortableProjectInput,
  type PortableCodeToolDeclaration,
  type PortableProjectSource,
} from './index.js';

const PROJECT = ProjectDocumentSchema.parse({
  apiVersion: 'agentworkspace.dev/v2',
  kind: 'Project',
  name: 'support-desk',
  models: { anthropic: { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } } },
  connectors: {
    zendesk: {
      url: 'https://zendesk.example.com/mcp',
      auth: { scheme: 'bearer', credential: { secret: 'ZENDESK_TOKEN' } },
    },
  },
  environments: { local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } } },
});

const PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const SENTINEL = 'sk-live-SENTINEL-0123456789';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
const TOOL_ENDPOINT = {
  url: 'https://tools.example.com/mcp',
  auth: { scheme: 'bearer' as const, secretRef: 'TOOLS_TOKEN' },
};

const encoder = new TextEncoder();

/** An in-memory project: `listFiles` is recursive and sorted, `readFile` answers null for a missing path. */
function sourceOf(files: Readonly<Record<string, string | Uint8Array>>): PortableProjectSource {
  const bytes = new Map(
    Object.entries(files).map(([path, content]) => [
      path,
      typeof content === 'string' ? encoder.encode(content) : content,
    ]),
  );
  return {
    readFile: (path) => Promise.resolve(bytes.get(path) ?? null),
    listFiles: (directory) =>
      Promise.resolve([...bytes.keys()].filter((path) => path.startsWith(`${directory}/`)).sort()),
  };
}

function markdownAgent(name: string, extra: Partial<PortableAgentInput> = {}): string {
  return formatAgentMarkdown({
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'Agent',
    name,
    instructions: `I am ${name}.`,
    permissions: PERMISSIONS,
    ...extra,
  });
}

const getOrder = defineTool({
  name: 'get_order',
  description: 'Look up an order by its id',
  input: z.object({ id: z.string() }),
  run: './tools/get-order.run.ts',
});
const GET_ORDER: PortableCodeToolDeclaration = {
  name: 'get_order',
  description: 'Look up an order by its id',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};
const TOOL_A: PortableCodeToolDeclaration = {
  name: 'tool_a',
  description: 'The first tool',
  inputSchema: { type: 'object' },
};
const TOOL_B: PortableCodeToolDeclaration = {
  name: 'tool_b',
  description: 'The second tool',
  inputSchema: { type: 'object' },
};

const TRIAGE = defineAgent({
  name: 'support-triage',
  instructions: 'Triage tickets.',
  tools: [mcp('zendesk'), getOrder],
  skills: [skill('refund-policy')],
});
const TRIAGE_BODY = toAgentVersionBody(TRIAGE);

function codeToolAgent(name: string, tool: string) {
  const code = defineTool({
    name: tool,
    description: 'x',
    input: z.object({}),
    run: `./tools/${tool}.run.ts`,
  });
  return toAgentVersionBody(defineAgent({ name, instructions: `I am ${name}.`, tools: [code] }));
}

const MIXED_FILES = {
  'agents/lead.agent.md': markdownAgent('lead', {
    subagents: [{ name: 'support-triage' }],
    skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
    knowledge: [{ kind: 'files', paths: ['docs/faq.md', 'docs/missing.md'] }],
    tools: [
      { kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json', allow: ['GET /orders/*'] },
      { kind: 'openapi', name: 'remote', specRef: 'https://api.example.com/openapi.json' },
    ],
  }),
  'skills/refund-policy/SKILL.md': `# Refund policy\n\nKey: ${SENTINEL}\n`,
  'skills/refund-policy/assets/diagram.png': PNG,
  'docs/faq.md': '# FAQ',
  'openapi/orders.json': '{"openapi":"3.1.0"}',
};

function inputOf(
  files: Readonly<Record<string, string | Uint8Array>>,
  rest: Partial<LoadPortableProjectInput> = {},
): LoadPortableProjectInput {
  return {
    project: PROJECT,
    bodies: [TRIAGE_BODY],
    catalogTools: toolDefinitionsOf(TRIAGE),
    codeTools: [GET_ORDER],
    codeToolNames: { 'support-triage': ['get_order'] },
    root: 'lead',
    source: sourceOf(files),
    ...rest,
  };
}

async function refused(run: Promise<unknown>): Promise<PortableProjectError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof PortableProjectError) return error;
    throw error;
  }
  throw new Error('expected a PortableProjectError');
}

describe('loadPortableProject', () => {
  it('mixed sources: a markdown root with a TS subagent, with every referenced byte read', async () => {
    const { project, dropped } = await loadPortableProject(inputOf(MIXED_FILES));
    expect(dropped).toEqual([]);
    expect(project.root).toBe('lead');
    expect(project.agents.map((agent) => agent.name)).toEqual(['lead', 'support-triage']);
    expect(project.agents[1]?.tools.map((tool) => tool.kind)).toEqual(['mcp', 'code']);
    expect(project.skills).toEqual([
      {
        name: 'refund-policy',
        files: [
          { path: 'SKILL.md', content: `# Refund policy\n\nKey: ${SENTINEL}\n` },
          { path: 'assets/diagram.png', content: PNG },
        ],
      },
    ]);
    expect(project.skills[0]?.files[1]?.content).toBeInstanceOf(Uint8Array);
    expect(project.knowledgeFiles).toEqual([{ path: 'docs/faq.md', content: '# FAQ' }]);
    expect(project.openapiSpecs).toEqual([
      { ref: 'openapi/orders.json', content: '{"openapi":"3.1.0"}' },
    ]);
  });

  it('refuses an agent defined in both sources', async () => {
    const error = await refused(
      loadPortableProject(
        inputOf({
          ...MIXED_FILES,
          'agents/support-triage.agent.md': markdownAgent('support-triage'),
        }),
      ),
    );
    expect(error.code).toBe('portable_agent_duplicate');
    expect(error.details).toEqual(['support-triage']);
  });

  it('refuses an unknown root, naming the known agents sorted', async () => {
    const error = await refused(loadPortableProject(inputOf(MIXED_FILES, { root: 'nobody' })));
    expect(error.code).toBe('portable_root_unknown');
    expect(error.details).toEqual(['nobody', 'lead', 'support-triage']);
  });

  it('refuses a markdown file whose name differs from its agent', async () => {
    const error = await refused(
      loadPortableProject(inputOf({ 'agents/x.agent.md': markdownAgent('y') })),
    );
    expect(error.code).toBe('portable_markdown_invalid');
    expect(error.details).toEqual(['agents/x.agent.md', 'file name must be y.agent.md']);
  });

  it('refuses invalid front matter with its line and column', async () => {
    const error = await refused(
      loadPortableProject(inputOf({ 'agents/x.agent.md': 'no front matter' })),
    );
    expect(error.code).toBe('portable_markdown_invalid');
    expect(error.details).toHaveLength(1);
    expect(error.details[0]).toMatch(/^agents\/x\.agent\.md line \d+, column \d+: /u);
  });

  it('refuses a markdown file that is not UTF-8', async () => {
    const error = await refused(
      loadPortableProject(inputOf({ 'agents/x.agent.md': new Uint8Array([0xff, 0xfe]) })),
    );
    expect(error.code).toBe('portable_markdown_invalid');
    expect(error.details).toEqual(['agents/x.agent.md']);
  });

  it('ignores a markdown file that is not directly in agents/', async () => {
    const { project } = await loadPortableProject(
      inputOf({ ...MIXED_FILES, 'agents/old/z.agent.md': 'not read' }),
    );
    expect(project.agents).toHaveLength(2);
  });

  it('a missing skill directory drops the reference and still gives a valid project', async () => {
    const { project, dropped } = await loadPortableProject(
      inputOf(
        {
          'agents/lead.agent.md': markdownAgent('lead', {
            skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
          }),
        },
        { bodies: [] },
      ),
    );
    expect(dropped).toEqual([
      { path: 'lead.skills.0', reason: 'skills/refund-policy/ is not in the project' },
    ]);
    expect(project.agents.at(0)?.skills).toEqual([]);
    expect(project.skills).toEqual([]);
  });

  it('closure: an agent the root does not reach is left out', async () => {
    const { project } = await loadPortableProject(
      inputOf({ ...MIXED_FILES, 'agents/orphan.agent.md': markdownAgent('orphan') }),
    );
    expect(project.agents.map((agent) => agent.name)).toEqual(['lead', 'support-triage']);
  });

  it('closure: drops of a TS agent the root does not reach are not reported', async () => {
    const orphan = toAgentVersionBody(
      defineAgent({ name: 'orphan', instructions: 'x', tools: [mcp('undeclared')] }),
    );
    const { project, dropped } = await loadPortableProject(
      inputOf(MIXED_FILES, {
        bodies: [TRIAGE_BODY, orphan],
        codeToolNames: { 'support-triage': ['get_order'], orphan: ['missing'] },
      }),
    );
    expect(project.agents.map((agent) => agent.name)).toEqual(['lead', 'support-triage']);
    expect(dropped).toEqual([]);
  });

  it('keeps a leading BOM in a text file', async () => {
    const { project } = await loadPortableProject(
      inputOf({ ...MIXED_FILES, 'docs/faq.md': '﻿# FAQ' }),
    );
    expect(project.knowledgeFiles).toEqual([{ path: 'docs/faq.md', content: '﻿# FAQ' }]);
  });

  it('closure: a nested subagent is refused at the nested path', async () => {
    const error = await refused(
      loadPortableProject(
        inputOf(
          {
            'agents/lead.agent.md': markdownAgent('lead', { subagents: [{ name: 'middle' }] }),
            'agents/middle.agent.md': markdownAgent('middle', { subagents: [{ name: 'leaf' }] }),
            'agents/leaf.agent.md': markdownAgent('leaf'),
          },
          { bodies: [] },
        ),
      ),
    );
    expect(error.code).toBe('portable_project_invalid');
    expect(error.details).toEqual([
      'agents.1.subagents.0: the subagent leaf is not one of the agents',
    ]);
  });

  it('passes the tool endpoint through unchanged, and leaves it out when absent', async () => {
    const withEndpoint = await loadPortableProject(
      inputOf(MIXED_FILES, { toolEndpoint: TOOL_ENDPOINT }),
    );
    expect(withEndpoint.project.toolEndpoint).toEqual(TOOL_ENDPOINT);
    const without = await loadPortableProject(inputOf(MIXED_FILES));
    expect(without.project).not.toHaveProperty('toolEndpoint');
  });

  it('prefixes a conversion drop with its agent name', async () => {
    const body = toAgentVersionBody(
      defineAgent({ name: 'ts-agent', instructions: 'x', tools: [mcp('undeclared')] }),
    );
    const { dropped } = await loadPortableProject(
      inputOf({}, { bodies: [body], root: 'ts-agent', codeToolNames: {} }),
    );
    expect(dropped).toEqual([
      {
        path: 'ts-agent.definition.resources.connectors.0',
        reason:
          'connector "undeclared" is not declared in agent-workspace.yaml connectors:, so its URL is unknown',
      },
    ]);
  });

  it('gives each TS agent only the code tools it lists, and reports one with no declaration', async () => {
    const { project, dropped } = await loadPortableProject(
      inputOf(
        {
          'agents/lead.agent.md': markdownAgent('lead', {
            subagents: [{ name: 'agent-a' }, { name: 'agent-b' }],
          }),
        },
        {
          bodies: [codeToolAgent('agent-a', 'tool_a'), codeToolAgent('agent-b', 'tool_b')],
          codeTools: [TOOL_A, TOOL_B],
          codeToolNames: { 'agent-a': ['tool_a', 'ghost'], 'agent-b': ['tool_b'] },
        },
      ),
    );
    const toolsOf = (name: string) =>
      project.agents
        .find((agent) => agent.name === name)
        ?.tools.map((tool) => (tool.kind === 'code' ? tool.name : tool.kind));
    expect(toolsOf('agent-a')).toEqual(['tool_a']);
    expect(toolsOf('agent-b')).toEqual(['tool_b']);
    expect(dropped).toEqual([
      {
        path: 'agent-a.codeTools.ghost',
        reason: 'no declaration was given for the code tool ghost',
      },
    ]);
  });

  it('reports the dev-tools connector of an agent with no codeToolNames entry as dropped', async () => {
    const { project, dropped } = await loadPortableProject(
      inputOf(MIXED_FILES, { codeToolNames: {} }),
    );
    expect(project.agents[1]?.tools.map((tool) => tool.kind)).toEqual(['mcp']);
    expect(dropped).toContainEqual({
      path: 'support-triage.definition.resources.connectors.1',
      reason:
        'the code tools of support-triage could not be resolved: codeToolNames has no entry for it',
    });
  });

  describe('a stored version with no project to list code tools from', () => {
    const DIGEST = 'a'.repeat(64);
    const bodyWith = (toolBundles: NonNullable<(typeof TRIAGE_BODY)['toolBundles']>) => ({
      ...codeToolAgent('stored', 'get_order'),
      toolBundles,
    });
    const storedInput = (body: ReturnType<typeof bodyWith>): LoadPortableProjectInput => ({
      project: { connectors: PROJECT.connectors, models: {} },
      bodies: [body],
      catalogTools: [],
      root: 'stored',
      source: sourceOf({}),
    });

    it("carries the body's recorded tool bundle as a code tool", async () => {
      const { project, dropped } = await loadPortableProject(
        storedInput(
          bodyWith([
            {
              tool: 'get_order',
              digest: DIGEST,
              description: GET_ORDER.description,
              inputSchema: GET_ORDER.inputSchema,
            },
          ]),
        ),
      );
      expect(dropped).toEqual([]);
      expect(project.agents[0]?.tools).toEqual([
        {
          kind: 'code',
          name: 'get_order',
          description: GET_ORDER.description,
          inputSchema: GET_ORDER.inputSchema,
        },
      ]);
    });

    it('drops a bundle pinned before its declaration was recorded', async () => {
      const { project, dropped } = await loadPortableProject(
        storedInput(bodyWith([{ tool: 'get_order', digest: DIGEST }])),
      );
      expect(project.agents[0]?.tools).toEqual([]);
      expect(dropped).toEqual([
        {
          path: 'stored.toolBundles.0',
          reason: 'pinned before its declaration was recorded; push the agent again',
        },
      ]);
    });

    it('resolves an MCP tool from the connectors alone', async () => {
      const { project, dropped } = await loadPortableProject({
        ...storedInput(bodyWith([])),
        bodies: [
          toAgentVersionBody(
            defineAgent({ name: 'stored', instructions: 'x', tools: [mcp('zendesk')] }),
          ),
        ],
      });
      expect(dropped).toEqual([]);
      expect(project.agents[0]?.tools.map((tool) => tool.kind)).toEqual(['mcp']);
    });
  });

  it('reports an OpenAPI spec file the project lacks, naming its path', async () => {
    const files = Object.fromEntries(
      Object.entries(MIXED_FILES).filter(([path]) => path !== 'openapi/orders.json'),
    );
    const { dropped } = await loadPortableProject(inputOf(files));
    expect(dropped).toContainEqual({
      path: 'lead.tools.0',
      reason: 'the OpenAPI spec file openapi/orders.json is not in the project',
    });
  });

  it('refuses a non-UTF-8 OpenAPI document', async () => {
    const error = await refused(
      loadPortableProject(
        inputOf({ ...MIXED_FILES, 'openapi/orders.json': new Uint8Array([0xff]) }),
      ),
    );
    expect(error.code).toBe('portable_project_invalid');
    expect(error.details).toEqual(['openapi/orders.json: must be UTF-8 text']);
  });

  it('refuses a listing outside the directory without echoing it', async () => {
    for (const listed of ['elsewhere/leaked-name.md', '../leaked-name']) {
      const source: PortableProjectSource = {
        readFile: () => Promise.resolve(null),
        listFiles: () => Promise.resolve([listed]),
      };
      const error = await refused(loadPortableProject(inputOf({}, { source })));
      expect(error.code).toBe('portable_project_invalid');
      expect(error.details).toEqual(['agents: the source returned an invalid answer']);
      expect(error.message).not.toContain('leaked-name');
    }
  });

  it('refuses a read that is not bytes without echoing it', async () => {
    const source: PortableProjectSource = {
      readFile: () => Promise.resolve(SENTINEL as never),
      listFiles: () => Promise.resolve(['agents/x.agent.md']),
    };
    const error = await refused(loadPortableProject(inputOf({}, { source })));
    expect(error.code).toBe('portable_project_invalid');
    expect(error.details).toEqual(['agents/x.agent.md: the source returned an invalid answer']);
    expect(error.message).not.toContain(SENTINEL);
  });

  it('carries secret names only: file contents stay in their file, never in drops or errors', async () => {
    const keyed = defineAgent({
      name: 'keyed',
      instructions: 'x',
      tools: [
        mcp('zendesk'),
        openapiTool({
          name: 'orders-api',
          spec: './openapi/orders.json',
          allow: ['GET /orders/*'],
          auth: secret('ORDERS_TOKEN'),
        }),
      ],
    });
    const load = await loadPortableProject(
      inputOf(MIXED_FILES, {
        bodies: [toAgentVersionBody(keyed)],
        catalogTools: toolDefinitionsOf(keyed),
        codeToolNames: {},
        root: 'keyed',
      }),
    );
    const agents = JSON.stringify(load.project.agents);
    expect(agents).toContain('ZENDESK_TOKEN');
    expect(agents).toContain('ORDERS_TOKEN');
    expect(agents).not.toContain(SENTINEL);
    expect(JSON.stringify(load.dropped)).not.toContain(SENTINEL);

    const error = await refused(loadPortableProject({ ...inputOf(MIXED_FILES), root: 'nobody' }));
    expect(error.message).not.toContain(SENTINEL);
    expect(JSON.stringify(error.details)).not.toContain(SENTINEL);
  });

  it('does not mutate its input, and freezes its answer', async () => {
    const input = inputOf(MIXED_FILES, { toolEndpoint: TOOL_ENDPOINT });
    const before = structuredClone({
      project: input.project,
      bodies: input.bodies,
      catalogTools: input.catalogTools,
      codeTools: input.codeTools,
      codeToolNames: input.codeToolNames,
    });
    const load = await loadPortableProject(input);
    expect({
      project: input.project,
      bodies: input.bodies,
      catalogTools: input.catalogTools,
      codeTools: input.codeTools,
      codeToolNames: input.codeToolNames,
    }).toEqual(before);
    expect(Object.isFrozen(load)).toBe(true);
    expect(Object.isFrozen(load.project)).toBe(true);
    expect(Object.isFrozen(load.dropped)).toBe(true);
  });
});
