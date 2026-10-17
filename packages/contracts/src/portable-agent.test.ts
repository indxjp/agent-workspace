import { describe, expect, it } from 'vitest';

import {
  PORTABLE_AGENT_API_VERSION,
  PortableAgentSchema,
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProjectInput,
} from './portable-agent.js';

const permissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const minimal = {
  apiVersion: PORTABLE_AGENT_API_VERSION,
  kind: 'Agent',
  name: 'support-triage',
  instructions: 'Triage tickets.',
  permissions,
} as const;

const sample: PortableAgentInput = {
  ...minimal,
  description: 'Answers billing and refund questions.',
  model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
  engine: 'claude-agent-sdk',
  tools: [
    {
      kind: 'mcp',
      name: 'crm',
      transport: 'streamable-http',
      url: 'https://crm.example.com/mcp',
      auth: { scheme: 'bearer', secretRef: 'CRM_TOKEN' },
    },
    { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'http://localhost:8080/sse' },
    { kind: 'mcp', name: 'local-files', transport: 'stdio', command: 'npx', args: ['-y', 'files'] },
    {
      kind: 'code',
      name: 'lookup',
      description: 'Looks up an order.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
    {
      kind: 'openapi',
      name: 'orders',
      specRef: 'https://api.example.com/openapi.json',
      allow: ['GET /orders/*', 'operationId:getOrder'],
      baseUrl: 'https://api.example.com',
      auth: { secretRef: 'ORDERS_KEY', header: 'X-Api-Key' },
    },
    { kind: 'openapi', name: 'local-spec', specRef: 'specs/orders.yaml' },
    { kind: 'builtin', id: 'web_search' },
    { kind: 'builtin', id: 'web_fetch' },
    { kind: 'builtin', id: 'code_execution' },
    { kind: 'builtin', id: 'file_access' },
  ],
  skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
  knowledge: [
    { kind: 'files', paths: ['docs/faq.md', 'docs/policies/refunds.md'] },
    { kind: 'url', url: 'https://example.com/help' },
    { kind: 'connector', name: 'sharepoint' },
  ],
  subagents: [{ name: 'billing-specialist' }],
  limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
  extensions: {
    engines: { 'claude-agent-sdk': { thinking: true } },
    platforms: { 'copilot-studio': { schemaName: 'x' } },
  },
};

function parse(value: unknown) {
  return PortableAgentSchema.safeParse(value);
}

/** The dotted path of the first issue, or `undefined` when the value parses. */
function firstPath(result: {
  success: boolean;
  error?: { issues: readonly { path: PropertyKey[] }[] };
}) {
  return result.error?.issues[0]?.path.join('.');
}

describe('PortableAgentSchema', () => {
  it('parses an agent that uses every tool, knowledge and extension kind', () => {
    expect(parse(sample).success).toBe(true);
  });

  it('parses a minimal agent and defaults the lists to empty', () => {
    const result = parse(minimal);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ tools: [], skills: [], knowledge: [], subagents: [] });
  });

  it.each([
    ['the root', { ...minimal, extra: 1 }, ''],
    ['model', { ...minimal, model: { id: 'm', extra: 1 } }, 'model'],
    [
      'an MCP tool',
      {
        ...minimal,
        tools: [{ kind: 'mcp', name: 'a', transport: 'stdio', command: 'x', extra: 1 }],
      },
      'tools.0',
    ],
    ['extensions', { ...minimal, extensions: { extra: {} } }, 'extensions'],
  ])('refuses an unknown key in %s', (_where, value, path) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe(path);
  });

  it('refuses missing permissions', () => {
    expect(firstPath(parse({ ...minimal, permissions: undefined }))).toBe('permissions');
  });

  it.each([
    ['a name with a space and capitals', { name: 'Support Triage' }, 'name'],
    ['a 1025-character description', { description: 'x'.repeat(1_025) }, 'description'],
    ['maxTurns 0', { limits: { maxTurns: 0 } }, 'limits.maxTurns'],
    ['maxBudgetUsd -1', { limits: { maxBudgetUsd: -1 } }, 'limits.maxBudgetUsd'],
  ])('refuses %s', (_what, override, path) => {
    const result = parse({ ...minimal, ...override });
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe(path);
  });

  it.each([
    ['a user name and password', 'https://user:pass@crm.example.com/mcp'],
    ['an api_key query parameter', 'https://crm.example.com/mcp?api_key=abc'],
  ])('refuses an MCP url with %s', (_what, url) => {
    const result = parse({
      ...minimal,
      tools: [{ kind: 'mcp', name: 'crm', transport: 'streamable-http', url }],
    });
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('tools.0.url');
  });

  it.each([
    [
      'a lower-case secretRef',
      { scheme: 'bearer', secretRef: 'lowercase' },
      'tools.0.auth.secretRef',
    ],
    ['the basic scheme', { scheme: 'basic', secretRef: 'CRM_TOKEN' }, 'tools.0.auth.scheme'],
  ])('refuses %s', (_what, auth, path) => {
    const result = parse({
      ...minimal,
      tools: [{ kind: 'mcp', name: 'crm', transport: 'sse', url: 'https://crm.example.com', auth }],
    });
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe(path);
  });

  it.each([
    [
      'a stdio tool with a url',
      { kind: 'mcp', name: 'a', transport: 'stdio', command: 'x', url: 'https://a.example.com' },
    ],
    [
      'a streamable-http tool with a command',
      {
        kind: 'mcp',
        name: 'a',
        transport: 'streamable-http',
        url: 'https://a.example.com',
        command: 'x',
      },
    ],
  ])('refuses %s at the tool', (_what, tool) => {
    const result = parse({ ...minimal, tools: [tool] });
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('tools.0');
  });

  it('reports a bad field of a nested discriminated tool at its own path', () => {
    const result = parse({
      ...minimal,
      tools: [{ kind: 'mcp', name: 'a', transport: 'websocket', url: 'https://a.example.com' }],
    });
    expect(result.success).toBe(false);
    expect(firstPath(result)).toBe('tools.0.transport');
    expect(firstPath(parse({ ...minimal, tools: [{ kind: 'rpc' }] }))).toBe('tools.0.kind');
  });

  it('refuses a builtin id that is not offered', () => {
    const result = parse({ ...minimal, tools: [{ kind: 'builtin', id: 'browser' }] });
    expect(firstPath(result)).toBe('tools.0.id');
  });

  it('refuses a knowledge url that is not https', () => {
    const result = parse({ ...minimal, knowledge: [{ kind: 'url', url: 'http://example.com' }] });
    expect(firstPath(result)).toBe('knowledge.0.url');
  });

  it.each(['../x', '/etc/x', 'a\\b', 'a/./b', 'a//b', 'C:x', 'a\u0000b'])(
    'refuses the knowledge path %j',
    (path) => {
      const result = parse({ ...minimal, knowledge: [{ kind: 'files', paths: [path] }] });
      expect(firstPath(result)).toBe('knowledge.0.paths.0');
    },
  );

  it('parses a knowledge files source with an access, and refuses an unknown one', () => {
    const files = (access: unknown) => ({
      ...minimal,
      knowledge: [{ kind: 'files', paths: ['docs/a.md'], access }],
    });
    expect(parse(files('read-write')).success).toBe(true);
    expect(parse(files('read')).success).toBe(true);
    expect(firstPath(parse(files('write')))).toBe('knowledge.0.access');
    // Absent still parses, and stays absent.
    const absent = parse({ ...minimal, knowledge: [{ kind: 'files', paths: ['docs/a.md'] }] });
    expect(absent.success && absent.data.knowledge[0]).toEqual({
      kind: 'files',
      paths: ['docs/a.md'],
    });
  });

  it('refuses an openapi specRef that is neither an https URL nor a relative path', () => {
    for (const specRef of [
      'http://a.example.com/o.json',
      'https://u:p@a.example.com/o.json',
      '../o.json',
    ]) {
      const result = parse({ ...minimal, tools: [{ kind: 'openapi', name: 'o', specRef }] });
      expect(firstPath(result)).toBe('tools.0.specRef');
    }
  });

  it('refuses a duplicate tool name, but lets a code tool and an MCP tool share one', () => {
    const mcp = { kind: 'mcp', name: 'crm', transport: 'stdio', command: 'x' } as const;
    const code = { kind: 'code', name: 'crm', description: 'd', inputSchema: {} } as const;
    expect(parse({ ...minimal, tools: [mcp, code] }).success).toBe(true);
    expect(firstPath(parse({ ...minimal, tools: [mcp, mcp] }))).toBe('tools.1');
    expect(firstPath(parse({ ...minimal, tools: [code, code] }))).toBe('tools.1');
  });

  it('refuses a duplicate skill and a duplicate knowledge connector', () => {
    const skill = { name: 'a', path: 'skills/a' };
    expect(firstPath(parse({ ...minimal, skills: [skill, skill] }))).toBe('skills.1');
    const connector = { kind: 'connector', name: 'sp' };
    expect(firstPath(parse({ ...minimal, knowledge: [connector, connector] }))).toBe('knowledge.1');
  });

  it('refuses a subagent that is the agent itself, a duplicate, and more than 20', () => {
    expect(firstPath(parse({ ...minimal, subagents: [{ name: 'support-triage' }] }))).toBe(
      'subagents.0',
    );
    expect(firstPath(parse({ ...minimal, subagents: [{ name: 'a' }, { name: 'a' }] }))).toBe(
      'subagents.1',
    );
    const many = Array.from({ length: 21 }, (_, index) => ({ name: `sub-${index}` }));
    expect(firstPath(parse({ ...minimal, subagents: many }))).toBe('subagents');
  });

  it('refuses an unknown engine extension and accepts a platform extension', () => {
    expect(firstPath(parse({ ...minimal, extensions: { engines: { unknown: {} } } }))).toBe(
      'extensions.engines',
    );
    expect(parse({ ...minimal, extensions: { platforms: { 'copilot-studio': {} } } }).success).toBe(
      true,
    );
    expect(parse({ ...minimal, extensions: { platforms: { copilot: {} } } }).success).toBe(false);
  });
});

const skillFile = { path: 'SKILL.md', content: '# Refunds' };
const child = { ...minimal, name: 'billing-specialist', instructions: 'Bill.' } as const;
const parent = { ...minimal, name: 'support-triage', subagents: [{ name: 'billing-specialist' }] };
const project: PortableProjectInput = {
  root: 'support-triage',
  agents: [{ ...parent, skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }] }, child],
  skills: [
    {
      name: 'refund-policy',
      files: [skillFile, { path: 'data.bin', content: new Uint8Array([1, 2, 3]) }],
    },
  ],
  knowledgeFiles: [
    { path: 'docs/faq.md', content: 'FAQ' },
    { path: 'docs/logo.png', content: new Uint8Array([137, 80]) },
  ],
  openapiSpecs: [{ ref: 'specs/orders.yaml', content: 'openapi: 3.1.0' }],
  toolEndpoint: {
    url: 'https://tools.example.com',
    auth: { scheme: 'oauth2', secretRef: 'TOOLS_SECRET' },
  },
};

function parseProject(value: unknown) {
  return PortableProjectSchema.safeParse(value);
}

describe('PortableProjectSchema', () => {
  it('parses a project whose content is text and bytes', () => {
    const result = parseProject(project);
    expect(result.success).toBe(true);
    expect(result.data?.knowledgeFiles[1]?.content).toBeInstanceOf(Uint8Array);
  });

  it('defaults skills, knowledge files and specs to empty', () => {
    const result = parseProject({ root: 'support-triage', agents: [minimal] });
    expect(result.data).toMatchObject({ skills: [], knowledgeFiles: [], openapiSpecs: [] });
  });

  it('refuses a root that is not an agent', () => {
    expect(firstPath(parseProject({ ...project, root: 'nobody' }))).toBe('root');
  });

  it('refuses a subagent that names a missing agent', () => {
    const result = parseProject({ root: 'support-triage', agents: [parent] });
    expect(firstPath(result)).toBe('agents.0.subagents.0');
  });

  it('refuses nested subagents at the second level', () => {
    const a = { ...minimal, name: 'agent-a', subagents: [{ name: 'agent-b' }] };
    const b = { ...minimal, name: 'agent-b', subagents: [{ name: 'agent-c' }] };
    const c = { ...minimal, name: 'agent-c' };
    const result = parseProject({ root: 'agent-a', agents: [a, b, c] });
    expect(firstPath(result)).toBe('agents.1.subagents.0');
  });

  it('refuses a skill reference with no skill entry', () => {
    const agent = { ...minimal, skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }] };
    expect(firstPath(parseProject({ root: 'support-triage', agents: [agent] }))).toBe(
      'agents.0.skills.0.name',
    );
  });

  it('refuses a skill without SKILL.md, or with two', () => {
    const without = { name: 'refund-policy', files: [{ path: 'notes.md', content: 'x' }] };
    expect(firstPath(parseProject({ ...project, skills: [without] }))).toBe('skills.0.files');
    const twice = { name: 'refund-policy', files: [skillFile, skillFile] };
    expect(firstPath(parseProject({ ...project, skills: [twice] }))).toBe('skills.0.files');
  });

  it('refuses a duplicate skill name', () => {
    const skill = { name: 'refund-policy', files: [skillFile] };
    expect(firstPath(parseProject({ ...project, skills: [skill, skill] }))).toBe('skills.1.name');
  });

  it('refuses duplicate agent names', () => {
    expect(firstPath(parseProject({ root: 'support-triage', agents: [minimal, minimal] }))).toBe(
      'agents.1.name',
    );
  });

  it('refuses a toolEndpoint over http and an api-key scheme', () => {
    const endpoint = project.toolEndpoint;
    expect(
      firstPath(
        parseProject({ ...project, toolEndpoint: { ...endpoint, url: 'http://t.example.com' } }),
      ),
    ).toBe('toolEndpoint.url');
    expect(
      firstPath(
        parseProject({
          ...project,
          toolEndpoint: { ...endpoint, auth: { scheme: 'api-key', secretRef: 'TOOLS_SECRET' } },
        }),
      ),
    ).toBe('toolEndpoint.auth.scheme');
  });

  it('refuses more than 21 agents', () => {
    const agents = Array.from({ length: 22 }, (_, index) => ({
      ...minimal,
      name: `agent-${index}`,
    }));
    expect(firstPath(parseProject({ root: 'agent-0', agents }))).toBe('agents');
  });
});
