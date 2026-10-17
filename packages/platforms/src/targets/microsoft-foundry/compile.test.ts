import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import {
  PORTABLE_AGENT_LIST_MAX,
  PortableProjectSchema,
  type PortableAgentInput,
  type PortableProject,
  type PortableProjectInput,
} from '@indx-workspace/contracts/portable-agent';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  assertVerdictInvariants,
  expectGoldenFiles,
  runPlatformConformance,
} from '../../testing/index.js';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import { PLATFORM_TARGETS } from '../../registry.js';
import { fitConnectionName } from './compile.js';
import { microsoftFoundryTarget } from './index.js';
import {
  FoundryAgentVersionBodySchema,
  FoundryEndpointPatchSchema,
  FoundryPublishPlanSchema,
} from './wire.js';

const MODEL_OPTIONS = { modelDeployment: 'claude-sonnet-4-6' };
const ROOT = 'support-triage';

function golden(name: string): string {
  return fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url));
}

function goldenOptions(name: string): unknown {
  return JSON.parse(readFileSync(join(golden(name), 'options.json'), 'utf8'));
}

function parse(input: PortableProjectInput): PortableProject {
  return PortableProjectSchema.parse(input);
}

/** The sample with `patch` applied to the root agent. */
function sampleWith(
  patch: Partial<PortableAgentInput>,
  base: PortableProjectInput = SAMPLE_PORTABLE_PROJECT,
): PortableProject {
  return parse({
    ...base,
    agents: base.agents.map((agent) => (agent.name === ROOT ? { ...agent, ...patch } : agent)),
  });
}

function compile(project: PortableProject, options: unknown = MODEL_OPTIONS) {
  const result = compileForPlatform(microsoftFoundryTarget, project, options);
  if (!result.ok)
    throw new Error(`refused: ${result.refusal.code} ${result.refusal.details.join()}`);
  assertVerdictInvariants(microsoftFoundryTarget, project, result);
  return result;
}

function refusalOf(project: PortableProject, options: unknown = MODEL_OPTIONS) {
  const result = compileForPlatform(microsoftFoundryTarget, project, options);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
}

function fileText(result: ReturnType<typeof compile>, path: string): string {
  const file = result.files.find((candidate) => candidate.path === path);
  if (typeof file?.content !== 'string') throw new Error(`no text file ${path}`);
  return file.content;
}

function versionOf(result: ReturnType<typeof compile>, agent = ROOT) {
  return FoundryAgentVersionBodySchema.parse(
    JSON.parse(fileText(result, `agents/${agent}.version.json`)),
  );
}

function verdictAt(result: ReturnType<typeof compile>, path: string): FieldVerdict {
  const verdict = result.report.find((entry) => entry.path === path);
  if (verdict === undefined) throw new Error(`no verdict at ${path}`);
  return verdict;
}

const sample = parse(SAMPLE_PORTABLE_PROJECT);

const ORDERS_SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders/{id}': { get: { operationId: 'getOrder' } },
    '/refunds': { post: { operationId: 'createRefund' } },
  },
});
const ORDERS_TOOL = {
  kind: 'openapi',
  name: 'orders-api',
  specRef: 'openapi/orders.json',
} as const;

function ordersProject(allow?: readonly string[], bundled = true): PortableProject {
  return parse({
    ...SAMPLE_PORTABLE_PROJECT,
    agents: SAMPLE_PORTABLE_PROJECT.agents.map((agent) =>
      agent.name === ROOT
        ? { ...agent, tools: [allow === undefined ? ORDERS_TOOL : { ...ORDERS_TOOL, allow }] }
        : agent,
    ),
    openapiSpecs: bundled ? [{ ref: 'openapi/orders.json', content: ORDERS_SPEC }] : [],
  });
}

describe('microsoftFoundryTarget', () => {
  it('is registered and passes the platform conformance kit', () => {
    expect(PLATFORM_TARGETS).toContain(microsoftFoundryTarget);
    expect(() => runPlatformConformance(microsoftFoundryTarget)).not.toThrow();
  });

  it('matches the golden for the shared sample', () => {
    expectGoldenFiles(
      compileForPlatform(microsoftFoundryTarget, sample, goldenOptions('full')),
      golden('full'),
    );
  });

  it('accepts the publish-only projectEndpoint and compiles the same bytes', () => {
    const options = {
      ...(goldenOptions('full') as Record<string, unknown>),
      projectEndpoint: 'https://acme.services.ai.azure.com/api/projects/support',
    };
    expectGoldenFiles(compileForPlatform(microsoftFoundryTarget, sample, options), golden('full'));
  });

  it('matches the golden for the sample without a tool endpoint', () => {
    const project = parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT);
    expectGoldenFiles(
      compileForPlatform(microsoftFoundryTarget, project, goldenOptions('no-tool-endpoint')),
      golden('no-tool-endpoint'),
    );
  });

  it('is deterministic and every emitted file parses with its wire schema', () => {
    const first = compile(sample);
    expect(compile(sample)).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([
      'agents/billing-specialist.endpoint.json',
      'agents/billing-specialist.version.json',
      'agents/support-triage.version.json',
      'project.plan.json',
    ]);
    for (const file of first.files) {
      const body: unknown = JSON.parse(typeof file.content === 'string' ? file.content : '');
      if (file.path.endsWith('.version.json')) FoundryAgentVersionBodySchema.parse(body);
      else if (file.path.endsWith('.endpoint.json')) FoundryEndpointPatchSchema.parse(body);
      else FoundryPublishPlanSchema.parse(body);
    }
  });

  it('keeps secret names in the plan only and never a value', () => {
    const result = compile(sample);
    for (const file of result.files) {
      const text = typeof file.content === 'string' ? file.content : '';
      const named = text.includes('ZENDESK_TOKEN') || text.includes('ACME_TOOL_ENDPOINT_TOKEN');
      expect(named).toBe(file.path === 'project.plan.json');
    }
  });
});

describe('options and refusals', () => {
  it('refuses an unknown option key and an empty deployment name', () => {
    expect(refusalOf(sample, { extra: true }).code).toBe('platform_options_invalid');
    expect(refusalOf(sample, { modelDeployment: '' }).code).toBe('platform_options_invalid');
  });

  it('refuses a projectEndpoint that is not https', () => {
    const options = { ...MODEL_OPTIONS, projectEndpoint: 'http://acme.services.ai.azure.com' };
    expect(refusalOf(sample, options).code).toBe('platform_options_invalid');
  });

  it('refuses a projectEndpoint with a query or a fragment, as publish does', () => {
    const endpoint = 'https://acme.services.ai.azure.com/api/projects/support';
    for (const projectEndpoint of [`${endpoint}?x=1`, `${endpoint}#x`]) {
      const options = { ...MODEL_OPTIONS, projectEndpoint };
      expect(refusalOf(sample, options).code).toBe('platform_options_invalid');
    }
  });

  it('refuses when no deployment is named and an agent has no model', () => {
    const project = sampleWith({ model: undefined });
    const refusal = refusalOf(project, {});
    expect(refusal.code).toBe('platform_options_invalid');
    expect(refusal.details).toEqual([`modelDeployment: required when agent ${ROOT} has no model`]);
    expect(versionOf(compile(project), ROOT).definition.model).toBe('claude-sonnet-4-6');
  });

  it('refuses a name Foundry does not accept, and a 64-character name', () => {
    const rename = (name: string): PortableProject => ({
      ...sample,
      root: name,
      agents: sample.agents.map((agent) => (agent.name === ROOT ? { ...agent, name } : agent)),
    });
    const refusal = refusalOf(rename('Support_Triage'));
    expect(refusal.code).toBe('platform_limit_exceeded');
    expect(refusal.details).toEqual(['agents[0].name']);
    expect(refusalOf(rename('a'.repeat(64))).code).toBe('platform_limit_exceeded');
    expect(compile(rename('a'.repeat(63))).files).toHaveLength(4);
  });

  it('refuses a subagent or a root that is not in the project', () => {
    const ghost = {
      ...sample,
      agents: sample.agents.map((a, i) => (i === 0 ? { ...a, subagents: [{ name: 'ghost' }] } : a)),
    };
    expect(refusalOf(ghost).code).toBe('platform_agent_not_found');
    expect(refusalOf({ ...sample, root: 'ghost' }).code).toBe('platform_agent_not_found');
    expect(
      microsoftFoundryTarget.compile({ ...sample, root: 'ghost' }, { requireApproval: 'always' })
        .ok,
    ).toBe(false);
  });

  it('compiles an agent on a non-Anthropic model', () => {
    const result = compile(sampleWith({ model: { provider: 'openai', id: 'gpt-5-mini' } }), {});
    const body = versionOf(result);
    expect(body.definition.model).toBe('gpt-5-mini');
    expect(body.metadata['aw.model']).toBe('openai/gpt-5-mini');
  });

  it('refuses a body that breaks a vendor limit instead of emitting it', () => {
    const name = 'x'.repeat(64);
    const rootAgent = SAMPLE_PORTABLE_PROJECT.agents.filter((agent) => agent.name === ROOT);
    const refusal = refusalOf(
      parse({
        ...SAMPLE_PORTABLE_PROJECT,
        root: name,
        agents: rootAgent.map((agent) => ({ ...agent, name, subagents: [] })),
      }),
    );
    expect(refusal.code).toBe('platform_limit_exceeded');
  });

  // V3 is pinned as "no limit known": the Learn pages state no maximum for instructions or tool
  // count, so the translator passes the portable maximums through. If Microsoft publishes a limit,
  // this test fails and the limit moves into FoundryAgentVersionBodySchema.
  // https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/model-context-protocol
  it('passes the portable maximum instructions and tool count through (V3: no limit known)', () => {
    const tools = Array.from({ length: PORTABLE_AGENT_LIST_MAX }, (_, index) => ({
      kind: 'mcp' as const,
      name: `m${index}`,
      transport: 'streamable-http' as const,
      url: `https://mcp.example.com/${index}`,
    }));
    const result = compile(sampleWith({ instructions: 'x'.repeat(100_000), tools }));
    const body = versionOf(result);
    expect(body.definition.instructions).toHaveLength(100_000);
    // the shared aw-tools server comes on top of the agent's own tools
    expect(body.definition.tools).toHaveLength(PORTABLE_AGENT_LIST_MAX + 1);
  });

  it('never exceeds the 16 metadata pairs', () => {
    expect(Object.keys(versionOf(compile(sample)).metadata).length).toBeLessThanOrEqual(16);
  });
});

describe('mapping table', () => {
  const report = compile(sample).report;
  const at = (path: string) => report.find((entry) => entry.path === path);

  it('maps description, instructions and the model', () => {
    expect(at(`${ROOT}.description`)?.verdict).toBe('native');
    expect(at(`${ROOT}.instructions`)?.verdict).toBe('native');
    expect(at(`${ROOT}.model`)?.verdict).toBe('mapped');
    const body = versionOf(compile(sample));
    expect(body.description).toBe('Triages customer support tickets and drafts replies.');
    expect(body.definition.model).toBe('claude-sonnet-4-6');
    expect(body.metadata).toEqual({
      'aw.apiVersion': 'agentworkspace.dev/v1',
      'aw.model': 'anthropic/claude-sonnet-4-6',
    });
  });

  it('notes the assumed deployment when none is named', () => {
    const result = compile(sample, {});
    expect(verdictAt(result, `${ROOT}.model`).note).toContain('modelDeployment');
  });

  it('maps a false permission and drops a true one', () => {
    expect(at(`${ROOT}.permissions.readFiles`)).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    for (const key of ['writeFiles', 'runCommands', 'unrestrictedNetwork']) {
      expect(at(`${ROOT}.permissions.${key}`)?.verdict).toBe('mapped');
    }
  });

  it('maps a bearer MCP server to a tool and a plan connection', () => {
    expect(at(`${ROOT}.tools.0`)?.verdict).toBe('mapped');
    const body = versionOf(compile(sample));
    expect(body.definition.tools?.[0]).toEqual({
      type: 'mcp',
      server_label: 'zendesk',
      server_url: 'https://mcp.example.com/zendesk',
      require_approval: 'always',
      project_connection_id: 'aw-zendesk',
    });
  });

  it('drops a stdio MCP server', () => {
    expect(at(`${ROOT}.tools.1`)).toMatchObject({
      verdict: 'dropped',
      code: 'stdio_mcp_unsupported',
    });
  });

  it('maps code tools to one shared aw-tools server, or drops them without an endpoint', () => {
    expect(at(`${ROOT}.tools.2`)?.verdict).toBe('mapped');
    expect(versionOf(compile(sample)).definition.tools?.[1]).toMatchObject({
      server_label: 'aw-tools',
      allowed_tools: ['get_order'],
      project_connection_id: 'aw-tools',
    });
    const bare = compile(parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT));
    expect(verdictAt(bare, `${ROOT}.tools.2`)).toMatchObject({
      verdict: 'dropped',
      code: 'code_tool_needs_public_mcp',
    });
    expect(JSON.stringify(versionOf(bare))).not.toContain('aw-tools');
  });

  it('warns when a code tool schema uses anyOf', () => {
    const base = SAMPLE_PORTABLE_PROJECT.agents[0];
    const tools = (base?.tools ?? []).map((tool) =>
      tool.kind === 'code'
        ? { ...tool, inputSchema: { anyOf: [{ type: 'string' }, { type: 'number' }] } }
        : tool,
    );
    const result = compile(sampleWith({ tools }));
    expect(verdictAt(result, `${ROOT}.tools.2`)).toMatchObject({ verdict: 'mapped' });
    expect(verdictAt(result, `${ROOT}.tools.2`).note).toContain('Invalid tool schema');
  });

  it('maps an OpenAPI tool by $ref, with or without a connection', () => {
    const sample = ordersProject();
    const anonymous = versionOf(compile(sample)).definition.tools?.[0];
    expect(anonymous).toEqual({
      type: 'openapi',
      openapi: {
        name: 'orders-api',
        spec: { $ref: 'openapi/orders.json' },
        auth: { type: 'anonymous' },
      },
    });
    expect(verdictAt(compile(sample), `${ROOT}.tools.0`).verdict).toBe('mapped');
    const connected = versionOf(
      compile(sample, { ...MODEL_OPTIONS, connections: { 'orders-api': 'orders-conn' } }),
    );
    expect(connected.definition.tools?.[0]).toMatchObject({
      openapi: {
        auth: { type: 'connection', security_scheme: { project_connection_id: 'orders-conn' } },
      },
    });
    const plan = FoundryPublishPlanSchema.parse(
      JSON.parse(fileText(compile(sample), 'project.plan.json')),
    );
    expect(plan.openapiSpecs).toEqual([
      { agent: ROOT, tool: 'orders-api', specRef: 'openapi/orders.json' },
    ]);
  });

  it('inlines a spec narrowed to the allowed operations and plans no $ref to replace', () => {
    const result = compile(ordersProject(['GET /orders/*']));
    const tool = versionOf(result).definition.tools?.[0];
    expect(tool).toMatchObject({ type: 'openapi', openapi: { name: 'orders-api' } });
    const spec = tool?.type === 'openapi' ? tool.openapi.spec : {};
    expect(Object.keys(spec['paths'] as object)).toEqual(['/orders/{id}']);
    expect(JSON.stringify(spec)).not.toContain('/refunds');
    expect(
      FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')))
        .openapiSpecs,
    ).toEqual([]);
    expect(verdictAt(result, `${ROOT}.tools.0`).verdict).toBe('mapped');
  });

  it.each([
    ['the spec is not bundled', ['GET /orders/*'], false],
    ['allow admits no operation', ['GET /nothing'], true],
  ])('drops the OpenAPI tool when %s', (_name, allow, bundled) => {
    const result = compile(ordersProject(allow, bundled));
    expect(verdictAt(result, `${ROOT}.tools.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    expect(versionOf(result).definition.tools?.some((tool) => tool.type === 'openapi')).toBe(false);
  });

  it('maps the builtin tools', () => {
    expect(at(`${ROOT}.tools.4`)?.verdict).toBe('native');
    expect(at(`${ROOT}.tools.5`)?.verdict).toBe('native');
    const tools = versionOf(compile(sample)).definition.tools;
    expect(tools).toContainEqual({ type: 'web_search' });
    expect(tools).toContainEqual({ type: 'code_interpreter', container: { type: 'auto' } });
  });

  it('drops web_fetch and file_access', () => {
    const result = compile(
      sampleWith({
        tools: [
          { kind: 'builtin', id: 'web_fetch' },
          { kind: 'builtin', id: 'file_access' },
        ],
      }),
    );
    for (const index of [0, 1]) {
      expect(verdictAt(result, `${ROOT}.tools.${index}`)).toMatchObject({
        verdict: 'dropped',
        code: 'builtin_unsupported',
      });
    }
  });

  it('maps an SSE MCP server with the unconfirmed-support note', () => {
    const result = compile(
      sampleWith({
        tools: [
          { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
        ],
      }),
    );
    expect(verdictAt(result, `${ROOT}.tools.0`)).toMatchObject({ verdict: 'mapped' });
    expect(verdictAt(result, `${ROOT}.tools.0`).note).toContain('V2');
    expect(versionOf(result).definition.tools?.[0]).not.toHaveProperty('project_connection_id');
  });

  it.each(['api-key', 'oauth2'] as const)(
    'plans a %s MCP connection by secret name and leaves the ARM authType to the publish step',
    (scheme) => {
      const result = compile(
        sampleWith({
          tools: [
            {
              kind: 'mcp',
              name: 'keyed',
              transport: 'streamable-http',
              url: 'https://mcp.example.com/keyed',
              auth: { scheme, secretRef: 'KEYED_SECRET' },
            },
          ],
        }),
      );
      expect(verdictAt(result, `${ROOT}.tools.0`).note).toContain(`scheme ${scheme}`);
      expect(versionOf(result).definition.tools?.[0]).toMatchObject({
        project_connection_id: 'aw-keyed',
      });
      const plan = FoundryPublishPlanSchema.parse(
        JSON.parse(fileText(result, 'project.plan.json')),
      );
      expect(plan.connections).toContainEqual({
        name: 'aw-keyed',
        kind: 'mcp',
        target: 'https://mcp.example.com/keyed',
        auth: { type: scheme, secretRef: 'KEYED_SECRET' },
      });
      expect(plan.notes.map((note) => note.id)).toContain('V6');
    },
  );

  it('plans an oauth2 tool endpoint credential the same way', () => {
    const project = parse({
      ...SAMPLE_PORTABLE_PROJECT,
      toolEndpoint: {
        url: 'https://aw.example.com/mcp/projects/acme-support',
        auth: { scheme: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
      },
    });
    const result = compile(project);
    const plan = FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')));
    expect(plan.connections).toContainEqual(
      expect.objectContaining({
        name: 'aw-tools',
        auth: { type: 'oauth2', secretRef: 'ACME_TOOL_ENDPOINT_TOKEN' },
      }),
    );
    expect(verdictAt(result, 'toolEndpoint').note).toContain('scheme oauth2');
  });

  it('notes V5 only for an Anthropic model and V6 only when an MCP connection is planned', () => {
    const notesOf = (project: PortableProject) =>
      FoundryPublishPlanSchema.parse(
        JSON.parse(fileText(compile(project, {}), 'project.plan.json')),
      ).notes.map((note) => note.id);
    expect(notesOf(sample)).toEqual(['V5', 'V6']);
    const plain = parse({
      root: 'plain',
      agents: [
        {
          apiVersion: 'agentworkspace.dev/v1',
          kind: 'Agent',
          name: 'plain',
          instructions: 'Help.',
          model: { provider: 'openai', id: 'gpt-5-mini' },
          permissions: {
            readFiles: false,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
      ],
    });
    expect(notesOf(plain)).toEqual([]);
  });

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
    expect(
      FoundryPublishPlanSchema.parse(
        JSON.parse(fileText(compile(project), 'project.plan.json')),
      ).connections.map((connection) => connection.name),
    ).toContain(id);
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
    const names = FoundryPublishPlanSchema.parse(
      JSON.parse(fileText(result, 'project.plan.json')),
    ).connections.map((connection) => connection.name);
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
    const plan = FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')));
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
    const plan = FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')));
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

  it('drops skills, url and connector knowledge, and files without a vector store', () => {
    expect(at(`${ROOT}.skills.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'skills_unsupported',
    });
    expect(at(`${ROOT}.knowledge.0`)).toMatchObject({
      verdict: 'dropped',
      code: 'knowledge_unsupported',
    });
    expect(at(`${ROOT}.knowledge.1`)).toMatchObject({
      verdict: 'dropped',
      code: 'knowledge_unsupported',
    });
    const connector = compile(sampleWith({ knowledge: [{ kind: 'connector', name: 'drive' }] }));
    expect(verdictAt(connector, `${ROOT}.knowledge.0`).code).toBe('knowledge_unsupported');
  });

  it('maps files knowledge to one file_search tool over the single vector store', () => {
    const result = compile(
      sampleWith({
        knowledge: [
          { kind: 'files', paths: ['knowledge/faq.md'] },
          { kind: 'files', paths: ['knowledge/more.md'] },
        ],
      }),
      { ...MODEL_OPTIONS, vectorStores: { [ROOT]: 'vs_1' } },
    );
    const searches = (versionOf(result).definition.tools ?? []).filter(
      (tool) => tool.type === 'file_search',
    );
    expect(searches).toEqual([{ type: 'file_search', vector_store_ids: ['vs_1'] }]);
    expect(verdictAt(result, `${ROOT}.knowledge.0`).verdict).toBe('mapped');
    expect(verdictAt(result, `${ROOT}.knowledge.1`).verdict).toBe('mapped');
  });

  it('maps a subagent to an a2a tool, a plan connection and an endpoint file', () => {
    const result = compile(sample);
    expect(at(`${ROOT}.subagents.0`)?.verdict).toBe('mapped');
    expect(versionOf(result).definition.tools?.at(-1)).toEqual({
      type: 'a2a',
      a2a_version: '1.0',
      project_connection_id: 'aw-agent-billing-specialist',
    });
    const plan = FoundryPublishPlanSchema.parse(JSON.parse(fileText(result, 'project.plan.json')));
    expect(plan.connections).toContainEqual({
      name: 'aw-agent-billing-specialist',
      kind: 'a2a',
      targetPath: '/agents/billing-specialist/endpoint/protocols/a2a',
      auth: { type: 'agentic-identity', audience: 'https://ai.azure.com' },
    });
    expect(plan.agents.map((entry) => entry.name)).toEqual(['billing-specialist', ROOT]);
    expect(plan.agents[0]?.endpoint).toBe('agents/billing-specialist.endpoint.json');
    expect(plan.agents[1]).not.toHaveProperty('endpoint');
  });

  it('drops limits, engine and engine extensions, and reads only its own platform block', () => {
    const result = compile(
      sampleWith({
        engine: 'claude-agent-sdk',
        extensions: {
          engines: { 'claude-agent-sdk': { effort: 'high' } },
          platforms: { 'microsoft-foundry': { modelDeployment: 'x' }, 'copilot-studio': {} },
        },
      }),
    );
    expect(verdictAt(result, `${ROOT}.limits.maxTurns`)).toMatchObject({
      code: 'limits_unsupported',
    });
    expect(verdictAt(result, `${ROOT}.limits.maxBudgetUsd`)).toMatchObject({
      code: 'limits_unsupported',
    });
    expect(verdictAt(result, `${ROOT}.engine`)).toMatchObject({ code: 'field_unsupported' });
    expect(verdictAt(result, `${ROOT}.extensions.engines.claude-agent-sdk`).code).toBe(
      'field_unsupported',
    );
    expect(verdictAt(result, `${ROOT}.extensions.platforms.microsoft-foundry`).verdict).toBe(
      'mapped',
    );
    expect(verdictAt(result, `${ROOT}.extensions.platforms.copilot-studio`).code).toBe(
      'field_unsupported',
    );
  });

  it('reports the tool endpoint as mapped, used or not', () => {
    expect(at('toolEndpoint')?.verdict).toBe('mapped');
    const unused = compile(sampleWith({ tools: [] }));
    expect(verdictAt(unused, 'toolEndpoint').note).toBe('no code tool uses it');
  });
});
