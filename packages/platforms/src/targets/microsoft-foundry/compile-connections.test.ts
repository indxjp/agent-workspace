import { type PortableAgentInput } from '@indx-workspace/contracts/portable-agent';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
} from '../../testing/index.js';
import { expect, it } from 'vitest';

import { fitConnectionName } from './compile.js';

import {
  MODEL_OPTIONS,
  ROOT,
  parse,
  sampleWith,
  compile,
  refusalOf,
  versionOf,
  verdictAt,
  sample,
  planOf,
} from '../../testing/foundry-compile.fixture.test-support.js';

it.each([
  ['a long tool name', 'x'.repeat(64)],
  ['a long hyphenated tool name', `${'y'.repeat(40)}-${'z'.repeat(40)}`.slice(0, 64)],
])('shortens the connection of %s deterministically to 63 characters', (_label, name) => {
  const project = sampleWith({
    tools: [
      {
        kind: 'mcp',
        name,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/long',
        auth: { scheme: 'bearer', secretRef: 'LONG_TOKEN' },
      },
    ],
  });
  const connectionOf = (result: ReturnType<typeof compile>) => {
    const tool = versionOf(result).definition.tools?.[0];
    return tool?.type === 'mcp' ? tool.project_connection_id : undefined;
  };
  const id = connectionOf(compile(project));
  expect(id).toBeDefined();
  expect(id).toHaveLength(63);
  expect(id).toBe(connectionOf(compile(project)));
  expect(planOf(compile(project)).connections.map((connection) => connection.name)).toContain(id);
});

it('keeps two long names that share a prefix apart', () => {
  const prefix = 'p'.repeat(62);
  const tool = (name: string, secretRef: string) => ({
    kind: 'mcp' as const,
    name,
    transport: 'streamable-http' as const,
    url: `https://mcp.example.com/${name}`,
    auth: { scheme: 'bearer' as const, secretRef },
  });
  const result = compile(
    sampleWith({ tools: [tool(`${prefix}a`, 'A_TOKEN'), tool(`${prefix}b`, 'B_TOKEN')] }),
  );
  const names = planOf(result).connections.map((connection) => connection.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names.every((name) => name.length <= 63)).toBe(true);
});

it('fits the a2a connection of a long subagent name', () => {
  const subagent = 'b'.repeat(60);
  const result = compile(
    parse({
      ...SAMPLE_PORTABLE_PROJECT,
      agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent) =>
        agent.name === ROOT
          ? { ...agent, subagents: [{ name: subagent }] }
          : agent.name === 'billing-specialist'
            ? { ...agent, name: subagent }
            : agent,
      ),
    }),
  );
  const id = fitConnectionName(`aw-agent-${subagent}`);
  expect(id).toHaveLength(63);
  expect(id.startsWith('aw-agent-')).toBe(true);
  expect(versionOf(result).definition.tools?.at(-1)).toMatchObject({
    type: 'a2a',
    project_connection_id: id,
  });
});

it('suffixes and fits a long name two agents use with different secrets', () => {
  const name = 'c'.repeat(64);
  const project = parse({
    ...SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
    agents: SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT.agents.map((agent) => ({
      ...agent,
      tools: [
        {
          kind: 'mcp' as const,
          name,
          transport: 'streamable-http' as const,
          url: 'https://mcp.example.com/crm',
          auth: {
            scheme: 'bearer' as const,
            secretRef: agent.name === ROOT ? 'A_TOKEN' : 'B_TOKEN',
          },
        },
      ],
    })),
  });
  const ids = [ROOT, 'billing-specialist'].map((agent) => {
    const tool = versionOf(compile(project), agent).definition.tools?.[0];
    return tool?.type === 'mcp' ? tool.project_connection_id : undefined;
  });
  // billing-specialist compiles first and keeps the plain name; the root is suffixed.
  expect(ids).toEqual([fitConnectionName(`aw-${name}-${ROOT}`), fitConnectionName(`aw-${name}`)]);
  expect(ids.every((id) => id !== undefined && id.length <= 63)).toBe(true);
  expect(ids[0]).not.toBe(ids[1]);
});

it('sends a kebab-case server_label unchanged (V4: charset undocumented)', () => {
  const result = compile(
    sampleWith({
      tools: [
        {
          kind: 'mcp',
          name: 'zendesk-v2',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/zendesk',
        },
      ],
    }),
  );
  expect(versionOf(result).definition.tools?.[0]).toMatchObject({ server_label: 'zendesk-v2' });
});

it('applies requireApproval to every MCP tool', () => {
  const tools =
    versionOf(compile(sample, { ...MODEL_OPTIONS, requireApproval: 'never' })).definition.tools ??
    [];
  const mcp = tools.filter((tool) => tool.type === 'mcp');
  expect(mcp).toHaveLength(2);
  expect(mcp.every((tool) => tool.require_approval === 'never')).toBe(true);
});

it('lets the connections option rename the project connection and the plan entry', () => {
  const result = compile(sample, { ...MODEL_OPTIONS, connections: { zendesk: 'zd-conn' } });
  expect(versionOf(result).definition.tools?.[0]).toMatchObject({
    project_connection_id: 'zd-conn',
  });
  const plan = planOf(result);
  expect(plan.connections.map((connection) => connection.name)).toContain('zd-conn');
  expect(plan.connections.map((connection) => connection.name)).not.toContain('aw-zendesk');
});

it('keeps one agent’s secret from reaching another agent’s server', () => {
  const shared = (url: string, secretRef: string): PortableAgentInput['tools'] => [
    {
      kind: 'mcp',
      name: 'crm',
      transport: 'streamable-http',
      url,
      auth: { scheme: 'bearer', secretRef },
    },
  ];
  const project = parse({
    ...SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
    agents: SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT.agents.map((agent) => ({
      ...agent,
      tools: shared(
        `https://${agent.name}.example.com/mcp`,
        `${agent.name.toUpperCase().replaceAll('-', '_')}_TOKEN`,
      ),
    })),
  });
  const result = compile(project);
  const plan = planOf(result);
  const names = plan.connections.map((connection) => connection.name);
  expect(new Set(names).size).toBe(names.length);
  const used = [ROOT, 'billing-specialist'].map(
    (agent) => versionOf(result, agent).definition.tools?.[0],
  );
  expect(
    new Set(used.map((tool) => (tool?.type === 'mcp' ? tool.project_connection_id : ''))).size,
  ).toBe(2);
});

it('never lets two agents’ connections share a name, whatever their auth scheme', () => {
  const crm = (
    url: string,
    scheme: 'bearer' | 'api-key',
    secretRef: string,
  ): PortableAgentInput['tools'] => [
    { kind: 'mcp', name: 'crm', transport: 'streamable-http', url, auth: { scheme, secretRef } },
  ];
  for (const [rootScheme, otherScheme] of [
    ['bearer', 'api-key'],
    ['api-key', 'bearer'],
  ] as const) {
    const project = parse({
      ...SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
      agents: SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT.agents.map((agent) =>
        agent.name === ROOT
          ? { ...agent, tools: crm('https://a.example/mcp', rootScheme, 'A_TOKEN') }
          : { ...agent, tools: crm('https://b.example/mcp', otherScheme, 'B_KEY') },
      ),
    });
    const result = compile(project);
    const ids = [ROOT, 'billing-specialist'].map((agent) => {
      const tool = versionOf(result, agent).definition.tools?.[0];
      return tool?.type === 'mcp' ? tool.project_connection_id : undefined;
    });
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]);
  }
});

it('names the suffixed aw-tools connection in the tool endpoint verdict', () => {
  const result = compile(
    sampleWith({
      tools: [
        {
          kind: 'mcp',
          name: 'tools',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/tools',
          auth: { scheme: 'bearer', secretRef: 'TOOLS_TOKEN' },
        },
        ...(SAMPLE_PORTABLE_PROJECT.agents.find((agent) => agent.name === ROOT)?.tools ?? []),
      ],
    }),
  );
  const endpoint = (versionOf(result).definition.tools ?? []).find(
    (tool) => tool.type === 'mcp' && tool.server_label === 'aw-tools',
  );
  expect(endpoint).toMatchObject({ project_connection_id: `aw-tools-${ROOT}` });
  expect(verdictAt(result, 'toolEndpoint').note).toContain(
    `held by project connection aw-tools-${ROOT}`,
  );
});

it('refuses an MCP tool whose label repeats the aw-tools server label', () => {
  const tools = SAMPLE_PORTABLE_PROJECT.agents.find((agent) => agent.name === ROOT)?.tools ?? [];
  const refusal = refusalOf(
    sampleWith({
      tools: [
        {
          kind: 'mcp',
          name: 'aw-tools',
          transport: 'streamable-http',
          url: 'https://mcp.example.com/other',
        },
        ...tools,
      ],
    }),
  );
  expect(refusal.code).toBe('platform_limit_exceeded');
  expect(refusal.details.some((detail) => detail.includes('server_label'))).toBe(true);
});
