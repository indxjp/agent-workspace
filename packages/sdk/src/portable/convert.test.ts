import { describe, expect, it } from 'vitest';

import {
  AgentVersionBodySchema,
  AgentVersionToolBundleSchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import { claudeBaseToolPolicyFor } from '@indx-workspace/contracts/agents';
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import type { PortableAgentInput } from '@indx-workspace/contracts/portable-agent';
import {
  ProjectDocumentSchema,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import {
  CODE_TOOL_DEFAULT_TIMEOUT_MS,
  DefinitionError,
  defineAgent,
  defineSurface,
  defineTool,
  files,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  skill,
  toAgentVersionBody,
  toolDefinitionsOf,
  z,
  type DefineAgentInput,
  type OpenApiToolDefinition,
} from '../define/index.js';
import {
  defineAgentFromPortable,
  portableFromAgentVersionBody,
  toPortableAgent,
  type PortableAgentContext,
} from './index.js';

const [claude, openai, pi, mastra] = ENGINE_IDS;

const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};
const ALL_PERMISSIONS = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

const PROJECT: ProjectDocument = ProjectDocumentSchema.parse({
  apiVersion: 'agentworkspace.dev/v2',
  kind: 'Project',
  name: 'support-desk',
  models: {
    anthropic: { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } },
    'azure-gpt': {
      provider: 'azure-openai',
      credential: { secret: 'AZURE_KEY' },
      baseUrl: 'https://azure.example.com',
      deployment: 'gpt',
      apiVersion: '2024-01-01',
    },
    'claude-eu': { provider: 'anthropic', credential: { secret: 'EU_KEY' } },
  },
  connectors: {
    zendesk: {
      url: 'https://zendesk.example.com/mcp',
      auth: { scheme: 'bearer', credential: { secret: 'ZENDESK_TOKEN' } },
    },
    events: { url: 'https://events.example.com/sse', transport: 'sse' },
    plain: { url: 'https://plain.example.com/mcp', transport: 'http' },
    keyed: {
      url: 'https://keyed.example.com/mcp',
      auth: { scheme: 'api-key', credential: { secret: 'KEYED_TOKEN' } },
    },
  },
  environments: {
    local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
  },
});

const MINIMAL: DefineAgentInput = { name: 'assistant', instructions: 'Answer briefly.' };

const getOrder = defineTool({
  name: 'get_order',
  description: 'Look up an order by its id',
  input: z.object({ id: z.string() }),
  run: './tools/get-order.run.ts',
});

const ordersApi = openapiTool({
  name: 'orders-api',
  spec: 'openapi/orders.json',
  allow: ['GET /orders/*'],
  baseUrl: 'https://api.example.com',
  auth: secret('ORDERS_TOKEN'),
});

const SAMPLE_PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: true,
};

const SAMPLE = defineAgent({
  name: 'support-triage',
  instructions: 'Triage tickets.',
  model: { connection: 'anthropic', id: 'claude-sonnet-4-6' },
  permissions: SAMPLE_PERMISSIONS,
  tools: [mcp('zendesk'), ordersApi, getOrder],
  skills: [skill('refund-policy')],
  limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
});

/** The body of the minimal agent: the base the hand-edited bodies below start from. */
const BASE_BODY = toAgentVersionBody(defineAgent(MINIMAL));

/** `body` with the given keys of its `definition` replaced, and optionally other top-level keys. */
function bodyWith(
  body: AgentVersionBody,
  definition: Record<string, unknown>,
  rest: Record<string, unknown> = {},
): AgentVersionBody {
  return AgentVersionBodySchema.parse({
    ...body,
    ...rest,
    definition: { ...body.definition, ...definition },
  });
}

function thrown(run: () => unknown): DefinitionError {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

function namesOf(tools: readonly { readonly kind: string }[]): readonly string[] {
  return tools.flatMap((tool) =>
    'name' in tool && typeof tool.name === 'string' ? [tool.name] : [],
  );
}

const DIGEST = 'a'.repeat(64);
const BUNDLE_KEYS = Object.keys(AgentVersionToolBundleSchema.unwrap().shape);

const ORDERS_DEFINITION: OpenApiToolDefinition = toolDefinitionsOf(
  defineAgent({ ...MINIMAL, tools: [ordersApi] }),
).flatMap((tool) => (tool.kind === 'openapi' ? [tool] : []))[0] as OpenApiToolDefinition;

describe('toPortableAgent: the sample', () => {
  it('turns support-triage into the expected PortableAgent with no drops', () => {
    const { value, dropped } = toPortableAgent(SAMPLE, { project: PROJECT });
    expect(dropped).toEqual([]);
    expect(value).toEqual({
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'Agent',
      name: 'support-triage',
      instructions: 'Triage tickets.',
      model: { provider: 'anthropic', id: 'claude-sonnet-4-6' },
      engine: claude,
      permissions: SAMPLE_PERMISSIONS,
      tools: [
        {
          kind: 'mcp',
          name: 'zendesk',
          transport: 'streamable-http',
          url: 'https://zendesk.example.com/mcp',
          auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
        },
        {
          kind: 'openapi',
          name: 'orders-api',
          specRef: 'openapi/orders.json',
          allow: ['GET /orders/*'],
          baseUrl: 'https://api.example.com',
          auth: { secretRef: 'ORDERS_TOKEN' },
        },
        {
          kind: 'code',
          name: 'get_order',
          description: 'Look up an order by its id',
          inputSchema: getOrder.inputSchema,
        },
      ],
      skills: [{ name: 'refund-policy', path: 'skills/refund-policy' }],
      knowledge: [],
      subagents: [],
      limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
      extensions: { engines: { [claude]: { tools: claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS) } } },
    });
  });

  it('gives the model no provider when the project does not declare the connection', () => {
    const { value } = toPortableAgent(SAMPLE, {
      project: ProjectDocumentSchema.parse({ ...PROJECT, models: undefined }),
    });
    expect(value.model).toEqual({ id: 'claude-sonnet-4-6' });
  });

  it('is purity-safe: the input is not changed and the output is frozen', () => {
    const before = structuredClone(toAgentVersionBody(SAMPLE));
    const result = toPortableAgent(SAMPLE, { project: PROJECT });
    expect(toAgentVersionBody(SAMPLE)).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.dropped)).toBe(true);

    const dropping = toPortableAgent(defineAgent({ ...MINIMAL, files: [files('docs/a.md')] }));
    expect(dropping.dropped).toHaveLength(1);
    expect(Object.isFrozen(dropping.dropped[0])).toBe(true);
  });

  it('accounts for every field of the body: carried in value, or listed in dropped', () => {
    const surface = defineSurface({ name: 'main', agent: 'support-triage' });
    const agent = defineAgent({
      ...MINIMAL,
      name: 'support-triage',
      files: [files('docs/a.md')],
      tools: [mcp('zendesk')],
      skills: [skill('refund-policy')],
    });
    const body = bodyWith(
      toAgentVersionBody(agent, { surfaces: [surface] }),
      {
        agent: { ...toAgentVersionBody(agent).definition.agent, runtimeProfileName: 'profile' },
        resources: {
          ...toAgentVersionBody(agent).definition.resources,
          connectors: ['zendesk', 'aw-dev-tools'],
        },
      },
      {
        description: 'Triages tickets.',
        subagents: [{ name: 'billing' }],
        knowledge: [{ kind: 'connector', name: 'zendesk' }],
        toolBundles: [
          {
            tool: 'full_tool',
            digest: DIGEST,
            description: 'A code tool the agent uses.',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            timeoutMs: 1000,
            secrets: ['ORPHAN_TOKEN'],
            allowedDomains: ['api.example.com'],
          },
        ],
      },
    );
    const context: PortableAgentContext = { connectors: PROJECT.connectors };
    const { value, dropped } = portableFromAgentVersionBody(body, context);

    // A field not listed here fails the test, so a field added to the body needs a verdict.
    const verdicts: Record<string, 'carried' | 'dropped' | 'pin'> = {
      'definition.apiVersion': 'carried',
      'definition.kind': 'carried',
      'definition.policySource': 'carried',
      'definition.agent.name': 'carried',
      'definition.agent.instructions': 'carried',
      'definition.agent.permissions': 'carried',
      'definition.agent.model': 'carried',
      'definition.agent.modelConnectionName': 'carried',
      'definition.agent.runtimeProfileName': 'dropped',
      'definition.policy.engine': 'carried',
      'definition.policy.tools': 'carried',
      'definition.policy.skills': 'carried',
      'definition.policy.limits': 'carried',
      'definition.resources.files': 'dropped',
      'definition.resources.skills': 'carried',
      'definition.resources.connectors': 'carried',
      surfaces: 'dropped',
      description: 'carried',
      subagents: 'carried',
      knowledge: 'carried',
      'toolBundles.0.tool': 'carried',
      'toolBundles.0.digest': 'pin',
      'toolBundles.0.description': 'carried',
      'toolBundles.0.inputSchema': 'carried',
      'toolBundles.0.outputSchema': 'dropped',
      'toolBundles.0.timeoutMs': 'dropped',
      'toolBundles.0.secrets': 'dropped',
      'toolBundles.0.allowedDomains': 'dropped',
    };
    const leaves = Object.keys(body).flatMap((key): string[] => {
      if (key === 'definition') {
        return Object.entries(body.definition).flatMap(([part, field]) =>
          typeof field === 'object'
            ? Object.keys(field).map((name) => `definition.${part}.${name}`)
            : [`definition.${part}`],
        );
      }
      if (key === 'toolBundles') {
        return (body.toolBundles ?? []).flatMap((_bundle, index) =>
          BUNDLE_KEYS.map((name) => `toolBundles.${index}.${name}`),
        );
      }
      return [key];
    });
    for (const leaf of leaves) {
      const verdict = verdicts[leaf];
      expect(verdict, `${leaf} has no verdict`).toBeDefined();
      if (verdict === 'dropped') {
        expect(
          dropped.some(
            (entry) =>
              entry.path === leaf ||
              entry.path.startsWith(`${leaf}.`) ||
              leaf.startsWith(`${entry.path}.`),
          ),
          `${leaf} is not in dropped`,
        ).toBe(true);
      }
    }
    // The fixture bundle sets every field, so each one's verdict is exercised.
    expect(Object.keys(body.toolBundles?.[0] ?? {}).sort()).toEqual([...BUNDLE_KEYS].sort());
    expect(namesOf(value.tools)).toEqual(['zendesk', 'full_tool']);
    expect(value.description).toBe('Triages tickets.');
    expect(value.subagents).toEqual([{ name: 'billing' }]);
    expect(value.knowledge).toEqual([{ kind: 'connector', name: 'zendesk' }]);
    expect(dropped.map((entry) => entry.path).sort()).toEqual([
      'definition.agent.runtimeProfileName',
      'definition.resources.files.0',
      'surfaces.0',
      'toolBundles.0.allowedDomains',
      'toolBundles.0.outputSchema',
      'toolBundles.0.secrets',
      'toolBundles.0.timeoutMs',
    ]);
  });
});

describe('portableFromAgentVersionBody: body fields', () => {
  it('name: carries a lower-kebab name', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.name).toBe('assistant');
  });

  it('name: refuses a name that is not lower-kebab, at definition.agent.name', () => {
    const agent = defineAgent({ ...MINIMAL, name: 'Support Triage' });
    const error = thrown(() => toPortableAgent(agent));
    expect(error.message).toContain('toPortableAgent()');
    expect(error.issues).toEqual([
      {
        path: 'definition.agent.name',
        message: 'rename the agent to lower-case kebab (1-64 characters) to export it',
      },
    ]);
    const fromBody = thrown(() => portableFromAgentVersionBody(toAgentVersionBody(agent)));
    expect(fromBody.message).toContain('portableFromAgentVersionBody()');
    expect(fromBody.issues[0]?.path).toBe('definition.agent.name');
  });

  it('body: refuses a body that does not parse, under the entry point named', () => {
    const malformed: AgentVersionBody = {
      ...BASE_BODY,
      definition: {
        ...BASE_BODY.definition,
        agent: { ...BASE_BODY.definition.agent, name: '' },
      },
    };
    const error = thrown(() => portableFromAgentVersionBody(malformed));
    expect(error.message).toContain('portableFromAgentVersionBody()');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('toPortableAgent: re-throws what toAgentVersionBody refuses under its own subject', () => {
    const agent = defineAgent({ ...MINIMAL, instructions: { file: './instructions.md' } });
    const error = thrown(() => toPortableAgent(agent));
    expect(error.message).toContain('toPortableAgent()');
    expect(error.message).not.toContain('toAgentVersionBody()');
    expect(error.issues[0]?.path).toBe('agent.instructions');
  });

  it('instructions: are carried verbatim', () => {
    const text = 'Line one.\n\n  Indented, with "quotes" and a trailing space. ';
    expect(
      toPortableAgent(defineAgent({ ...MINIMAL, instructions: text })).value.instructions,
    ).toBe(text);
  });

  it('permissions: carries the four switches', () => {
    const { value } = toPortableAgent(defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS }));
    expect(value.permissions).toEqual(SAMPLE_PERMISSIONS);
  });

  it('permissions: a withheld switch of a stored arm is exported off, not widened', () => {
    const base = toAgentVersionBody(
      defineAgent({ ...MINIMAL, engine: openai, permissions: ALL_PERMISSIONS }),
    );
    const body = bodyWith(base, {
      policy: { ...base.definition.policy, withheldPermissions: ['writeFiles'] },
    });
    expect(base.definition.agent.permissions.writeFiles).toBe(true);
    expect(portableFromAgentVersionBody(body).value.permissions).toEqual({
      ...ALL_PERMISSIONS,
      writeFiles: false,
    });
  });

  it('permissions: a compiled policy never narrows them', () => {
    const base = toAgentVersionBody(defineAgent({ ...MINIMAL, permissions: ALL_PERMISSIONS }));
    expect(base.definition.policySource).toBe('compiled');
    expect(portableFromAgentVersionBody(base).value.permissions).toEqual(ALL_PERMISSIONS);
  });

  it('model: a model id with a known connection carries its provider', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'claude-eu', id: 'm-1' } });
    expect(toPortableAgent(agent, { project: PROJECT }).value.model).toEqual({
      provider: 'anthropic',
      id: 'm-1',
    });
  });

  it('model: a model id with an unknown connection leaves the provider out', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'nowhere', id: 'm-1' } });
    const { value, dropped } = toPortableAgent(agent, { project: PROJECT });
    expect(value.model).toEqual({ id: 'm-1' });
    expect(dropped).toEqual([]);
  });

  it('model: a connection name that is an Object.prototype key resolves to nothing', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'constructor', id: 'm-1' } });
    expect(toPortableAgent(agent, { project: PROJECT }).value.model).toEqual({ id: 'm-1' });
  });

  it("model: no model, or the 'default' connection, is absent with no drop", () => {
    for (const model of [undefined, 'default'] as const) {
      const result = toPortableAgent(defineAgent({ ...MINIMAL, model }));
      expect(result.value.model).toBeUndefined();
      expect(result.dropped).toEqual([]);
    }
  });

  it('model: a named connection with no model id is dropped, with the connection named', () => {
    const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, model: 'anthropic' }), {
      project: PROJECT,
    });
    expect(value.model).toBeUndefined();
    expect(dropped).toEqual([
      {
        path: 'definition.agent.model',
        reason:
          'the model connection "anthropic" names no model id; set model: { connection, id } to export it',
      },
    ]);
  });

  it('runtimeProfileName: a named profile is dropped', () => {
    const body = bodyWith(BASE_BODY, {
      agent: { ...BASE_BODY.definition.agent, runtimeProfileName: 'gpu' },
    });
    expect(portableFromAgentVersionBody(body).dropped).toEqual([
      {
        path: 'definition.agent.runtimeProfileName',
        reason: 'runtime profiles are Agent Workspace resources',
      },
    ]);
  });
});

describe('portableFromAgentVersionBody: policy', () => {
  it('engine: is always carried', () => {
    for (const engine of ENGINE_IDS) {
      expect(toPortableAgent(defineAgent({ ...MINIMAL, engine })).value.engine).toBe(engine);
    }
    expect(toPortableAgent(defineAgent(MINIMAL)).value.engine).toBe(claude);
  });

  it('extensions.engines: a compiled Claude policy gives none', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.extensions).toBeUndefined();
  });

  it('extensions.engines: a stored Claude arm carries its tools verbatim', () => {
    const { value } = toPortableAgent(
      defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS, limits: { maxTurns: 3 } }),
    );
    expect(value.extensions).toEqual({
      engines: { [claude]: { tools: claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS) } },
    });
  });

  it('extensions.engines: a stored arm carries its native settings under its engine', () => {
    const agent = defineAgent({ ...MINIMAL, engine: { id: pi, thinkingLevel: 'low' } });
    expect(toPortableAgent(agent).value.extensions).toEqual({
      engines: { [pi]: { thinkingLevel: 'low' } },
    });
    const several = defineAgent({
      ...MINIMAL,
      engine: { id: openai, reasoningEffort: 'high', parallelToolCalls: false },
    });
    expect(toPortableAgent(several).value.extensions).toEqual({
      engines: { [openai]: { reasoningEffort: 'high', parallelToolCalls: false } },
    });
    const concurrent = defineAgent({ ...MINIMAL, engine: { id: mastra, toolCallConcurrency: 4 } });
    expect(toPortableAgent(concurrent).value.extensions).toEqual({
      engines: { [mastra]: { toolCallConcurrency: 4 } },
    });
  });

  it('extensions.engines: a stored arm with no native setting gives none', () => {
    expect(
      toPortableAgent(defineAgent({ ...MINIMAL, engine: pi })).value.extensions,
    ).toBeUndefined();
  });

  it('limits: carries each limit that has a value', () => {
    const both = toPortableAgent(
      defineAgent({ ...MINIMAL, limits: { maxTurns: 5, maxBudgetUsd: 0.25 } }),
    );
    expect(both.value.limits).toEqual({ maxTurns: 5, maxBudgetUsd: 0.25 });
    const one = toPortableAgent(defineAgent({ ...MINIMAL, limits: { maxBudgetUsd: 2 } }));
    expect(one.value.limits).toEqual({ maxBudgetUsd: 2 });
  });

  it('limits: are left out when both are null', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.limits).toBeUndefined();
    expect(toPortableAgent(defineAgent({ ...MINIMAL, limits: {} })).value.limits).toBeUndefined();
  });
});

describe('portableFromAgentVersionBody: resources', () => {
  const skilled = defineAgent({ ...MINIMAL, skills: [skill('a-one'), skill('b-two')] });
  const skilledBody = toAgentVersionBody(skilled);

  it('skills: each assigned skill the allowlist keeps lands at skills/<name>', () => {
    expect(portableFromAgentVersionBody(skilledBody).value.skills).toEqual([
      { name: 'a-one', path: 'skills/a-one' },
      { name: 'b-two', path: 'skills/b-two' },
    ]);
  });

  it("skills: mode 'all' keeps every assigned skill", () => {
    const body = bodyWith(skilledBody, {
      policy: { ...skilledBody.definition.policy, skills: { mode: 'all' } },
    });
    const { value, dropped } = portableFromAgentVersionBody(body);
    expect(value.skills.map((entry) => entry.name)).toEqual(['a-one', 'b-two']);
    expect(dropped).toEqual([]);
  });

  it('skills: an assigned skill the allowlist excludes is dropped', () => {
    const body = bodyWith(skilledBody, {
      policy: {
        ...skilledBody.definition.policy,
        skills: { mode: 'allowlist', names: ['b-two'] },
      },
    });
    const { value, dropped } = portableFromAgentVersionBody(body);
    expect(value.skills).toEqual([{ name: 'b-two', path: 'skills/b-two' }]);
    expect(dropped).toEqual([
      {
        path: 'definition.resources.skills.0',
        reason: "the policy's skill allowlist excludes it",
      },
    ]);
  });

  it('files: each workspace file grant is dropped at its index', () => {
    const agent = defineAgent({
      ...MINIMAL,
      files: [files('docs/a.md'), files('docs/b.md', 'read-write')],
    });
    expect(toPortableAgent(agent).dropped).toEqual([
      {
        path: 'definition.resources.files.0',
        reason: 'workspace file grants are Agent Workspace resources',
      },
      {
        path: 'definition.resources.files.1',
        reason: 'workspace file grants are Agent Workspace resources',
      },
    ]);
  });

  it('files: a grant a knowledge source names is carried, not dropped', () => {
    const agent = defineAgent({
      ...MINIMAL,
      files: [files('docs/a.md'), files('docs/b.md')],
      knowledge: [{ kind: 'files', paths: ['docs/a.md', 'docs/c.md'] }],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.knowledge).toEqual([{ kind: 'files', paths: ['docs/a.md', 'docs/c.md'] }]);
    expect(dropped).toEqual([
      {
        path: 'definition.resources.files.1',
        reason: 'workspace file grants are Agent Workspace resources',
      },
    ]);
  });

  it('files: a read-write grant a knowledge source names is carried as access read-write', () => {
    const agent = defineAgent({
      ...MINIMAL,
      files: [files('docs/a.md', 'read-write')],
      knowledge: [{ kind: 'files', paths: ['docs/a.md'] }],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.knowledge).toEqual([
      { kind: 'files', paths: ['docs/a.md'], access: 'read-write' },
    ]);
    expect(dropped).toEqual([]);
  });

  it('files: a source mixing read and read-write grants splits, read first', () => {
    const agent = defineAgent({
      ...MINIMAL,
      files: [files('docs/a.md', 'read-write'), files('docs/b.md')],
      knowledge: [{ kind: 'files', paths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] }],
    });
    expect(toPortableAgent(agent).value.knowledge).toEqual([
      { kind: 'files', paths: ['docs/b.md', 'docs/c.md'] },
      { kind: 'files', paths: ['docs/a.md'], access: 'read-write' },
    ]);
  });

  it('description, subagents, knowledge: are carried', () => {
    const agent = defineAgent({
      ...MINIMAL,
      description: 'Answers billing questions.',
      subagents: ['billing', 'refunds'],
      tools: [mcp('plain')],
      knowledge: [{ kind: 'connector', name: 'plain' }],
    });
    const { value, dropped } = toPortableAgent(agent, { project: PROJECT });
    expect(dropped).toEqual([]);
    expect(value.description).toBe('Answers billing questions.');
    expect(value.subagents).toEqual([{ name: 'billing' }, { name: 'refunds' }]);
    expect(value.knowledge).toEqual([{ kind: 'connector', name: 'plain' }]);
    expect(value.tools).toHaveLength(1);
  });

  it('subagents: a name that is not lower-case kebab is dropped at its index', () => {
    const agent = defineAgent({ ...MINIMAL, subagents: ['Billing Team', 'refunds'] });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.subagents).toEqual([{ name: 'refunds' }]);
    expect(dropped).toEqual([
      { path: 'subagents.0', reason: 'rename the subagent to lower-case kebab to export it' },
    ]);
  });

  it('knowledge: a source the portable schema refuses is dropped at its index', () => {
    const agent = defineAgent({
      ...MINIMAL,
      knowledge: [{ kind: 'files', paths: ['../outside.md'] }],
      files: [files('../outside.md')],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.knowledge).toEqual([]);
    expect(dropped.map((entry) => entry.path)).toContain('knowledge.0');
  });

  it('surfaces: each surface is dropped at its index', () => {
    const surface = defineSurface({ name: 'main', agent: 'assistant' });
    const { dropped } = toPortableAgent(defineAgent(MINIMAL), { surfaces: [surface] });
    expect(dropped).toEqual([
      { path: 'surfaces.0', reason: 'surfaces are served by Agent Workspace' },
    ]);
  });
});

describe('portableFromAgentVersionBody: tools', () => {
  it('aw-dev-tools: becomes one code tool per declaration of context.codeTools', () => {
    const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, tools: [getOrder] }));
    expect(dropped).toEqual([]);
    expect(value.tools).toEqual([
      {
        kind: 'code',
        name: 'get_order',
        description: 'Look up an order by its id',
        inputSchema: getOrder.inputSchema,
      },
    ]);
  });

  it('aw-dev-tools: context.codeTools wins over the body’s bundles', () => {
    const body = bodyWith(
      BASE_BODY,
      { resources: { ...BASE_BODY.definition.resources, connectors: ['aw-dev-tools'] } },
      { toolBundles: [{ tool: 'pinned', digest: DIGEST, description: 'Pinned', inputSchema: {} }] },
    );
    const { value, dropped } = portableFromAgentVersionBody(body, {
      codeTools: [{ name: 'given', description: 'Given', inputSchema: { type: 'object' } }],
    });
    expect(dropped).toEqual([]);
    expect(namesOf(value.tools)).toEqual(['given']);
  });

  it('aw-dev-tools: toolBundles with a declaration become code tools', () => {
    const body = bodyWith(
      BASE_BODY,
      { resources: { ...BASE_BODY.definition.resources, connectors: ['aw-dev-tools'] } },
      {
        toolBundles: [
          {
            tool: 'pinned',
            digest: DIGEST,
            description: 'Pinned tool',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        ],
      },
    );
    const { value, dropped } = portableFromAgentVersionBody(body);
    expect(dropped).toEqual([]);
    expect(value.tools).toEqual([
      {
        kind: 'code',
        name: 'pinned',
        description: 'Pinned tool',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ]);
  });

  it('aw-dev-tools: a code tool reports each field the portable tool cannot carry', () => {
    const tool = defineTool({
      name: 'lookup',
      description: 'Look something up',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      run: './tools/lookup.run.ts',
      limits: { timeoutMs: 5000 },
      secrets: [secret('LOOKUP_TOKEN')],
      allowedDomains: ['api.example.com'],
    });
    const fromAgent = toPortableAgent(defineAgent({ ...MINIMAL, tools: [tool] }));
    expect(fromAgent.dropped.map((entry) => entry.path)).toEqual([
      'codeTools.0.outputSchema',
      'codeTools.0.timeoutMs',
      'codeTools.0.secrets',
      'codeTools.0.allowedDomains',
    ]);
    for (const entry of fromAgent.dropped) {
      expect(entry.reason).toContain('workspace tool runtime (ADR-0134)');
    }
    expect(fromAgent.dropped[2]?.reason).toContain('LOOKUP_TOKEN');
    expect(fromAgent.dropped[3]?.reason).toContain('api.example.com');
    expect(fromAgent.value.tools).toEqual([
      {
        kind: 'code',
        name: 'lookup',
        description: 'Look something up',
        inputSchema: tool.inputSchema,
      },
    ]);

    const body = bodyWith(
      BASE_BODY,
      { resources: { ...BASE_BODY.definition.resources, connectors: ['aw-dev-tools'] } },
      {
        toolBundles: [
          {
            tool: 'lookup',
            digest: DIGEST,
            description: 'Look something up',
            inputSchema: tool.inputSchema,
            outputSchema: { type: 'object' },
            timeoutMs: 5000,
            secrets: ['LOOKUP_TOKEN'],
            allowedDomains: ['api.example.com'],
          },
        ],
      },
    );
    expect(portableFromAgentVersionBody(body).dropped.map((entry) => entry.path)).toEqual([
      'toolBundles.0.outputSchema',
      'toolBundles.0.timeoutMs',
      'toolBundles.0.secrets',
      'toolBundles.0.allowedDomains',
    ]);
  });

  it('aw-dev-tools: a default timeout is not reported', () => {
    const bundled = bodyWith(
      BASE_BODY,
      { resources: { ...BASE_BODY.definition.resources, connectors: ['aw-dev-tools'] } },
      {
        toolBundles: [
          {
            tool: 'quick',
            digest: DIGEST,
            description: 'Quick',
            inputSchema: {},
            timeoutMs: CODE_TOOL_DEFAULT_TIMEOUT_MS,
          },
        ],
      },
    );
    expect(portableFromAgentVersionBody(bundled).dropped).toEqual([]);
  });

  it('aw-dev-tools: a bundle without its declaration is dropped', () => {
    const body = bodyWith(
      BASE_BODY,
      { resources: { ...BASE_BODY.definition.resources, connectors: ['aw-dev-tools'] } },
      {
        toolBundles: [
          { tool: 'old', digest: DIGEST },
          { tool: 'half', digest: DIGEST, description: 'No schema' },
          { tool: 'new', digest: DIGEST, description: 'New', inputSchema: {} },
        ],
      },
    );
    const { value, dropped } = portableFromAgentVersionBody(body);
    expect(namesOf(value.tools)).toEqual(['new']);
    expect(dropped).toEqual([
      {
        path: 'toolBundles.0',
        reason: 'pinned before its declaration was recorded; push the agent again',
      },
      {
        path: 'toolBundles.1',
        reason: 'pinned before its declaration was recorded; push the agent again',
      },
    ]);
  });

  it('aw-dev-tools: a bundle of an agent that does not use the connector is dropped', () => {
    const body = bodyWith(BASE_BODY, {}, { toolBundles: [{ tool: 'stray', digest: DIGEST }] });
    expect(portableFromAgentVersionBody(body).dropped).toEqual([
      {
        path: 'toolBundles.0',
        reason: 'the agent does not use the aw-dev-tools connector',
      },
    ]);
  });

  it('aw-dev-tools: a declaration the portable schema refuses is dropped, not thrown', () => {
    const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, tools: [getOrder] }));
    expect(value.tools).toHaveLength(1);
    const body = toAgentVersionBody(defineAgent({ ...MINIMAL, tools: [getOrder] }));
    const result = portableFromAgentVersionBody(body, {
      codeTools: [{ name: 'too_long', description: 'x'.repeat(2049), inputSchema: {} }],
    });
    expect(result.value.tools).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.path).toBe('codeTools.0');
    expect(result.dropped[0]?.reason).toMatch(/^cannot be written as a portable tool: /u);
    expect(dropped).toEqual([]);
  });

  it('openapi: a catalog tool becomes an openapi tool with its allow rules and base URL', () => {
    const agent = defineAgent({
      ...MINIMAL,
      tools: [
        openapiTool({
          name: 'plain-api',
          spec: 'https://api.example.com/openapi.json',
          allow: ['GET /a', 'operationId:getB'],
        }),
      ],
    });
    expect(toPortableAgent(agent).value.tools).toEqual([
      {
        kind: 'openapi',
        name: 'plain-api',
        specRef: 'https://api.example.com/openapi.json',
        allow: ['GET /a', 'operationId:getB'],
      },
    ]);
  });

  it('forward openapi: a ./-prefixed spec path is carried without the prefix', () => {
    const agent = defineAgent({
      ...MINIMAL,
      tools: [openapiTool({ name: 'orders', spec: './openapi/orders.json', allow: ['GET /o'] })],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(dropped).toEqual([]);
    expect(value.tools).toEqual([
      { kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json', allow: ['GET /o'] },
    ]);
  });

  it('openapi: auth none is absent, bearer is a secretRef, a header adds the header', () => {
    const bearer = toPortableAgent(defineAgent({ ...MINIMAL, tools: [ordersApi] }));
    expect(bearer.value.tools[0]).toMatchObject({ auth: { secretRef: 'ORDERS_TOKEN' } });
    expect(bearer.value.tools[0]).not.toHaveProperty('auth.header');
    const header = toPortableAgent(
      defineAgent({
        ...MINIMAL,
        tools: [
          openapiTool({
            name: 'keyed-api',
            spec: 'openapi/keyed.json',
            allow: ['GET /k'],
            auth: { header: 'X-Api-Key', credential: secret('KEYED_TOKEN') },
          }),
        ],
      }),
    );
    expect(header.value.tools[0]).toMatchObject({
      auth: { secretRef: 'KEYED_TOKEN', header: 'X-Api-Key' },
    });
    const none = toPortableAgent(
      defineAgent({
        ...MINIMAL,
        tools: [openapiTool({ name: 'open-api', spec: 'openapi/o.json', allow: ['GET /o'] })],
      }),
    );
    expect(none.value.tools[0]).not.toHaveProperty('auth');
  });

  it('openapi: an identity assertion is not carried, and is reported at the tool', () => {
    const agent = defineAgent({
      ...MINIMAL,
      tools: [
        openapiTool({
          name: 'signed-api',
          spec: 'openapi/signed.json',
          allow: ['GET /s'],
          identity: secret('SIGNED_API_IDENTITY'),
        }),
      ],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.tools).toEqual([
      { kind: 'openapi', name: 'signed-api', specRef: 'openapi/signed.json', allow: ['GET /s'] },
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.path).toBe('definition.resources.connectors.0.identity');
    expect(dropped[0]?.reason).toContain('SIGNED_API_IDENTITY');
  });

  it('openapi: a credentialed tool whose secret is not named is dropped', () => {
    const body = toAgentVersionBody(defineAgent({ ...MINIMAL, tools: [ordersApi] }));
    const { credential, ...withoutSecret } = ORDERS_DEFINITION;
    expect(credential).toBeDefined();
    const result = portableFromAgentVersionBody(body, { catalogTools: [withoutSecret] });
    expect(result.value.tools).toEqual([]);
    expect(result.dropped).toEqual([
      {
        path: 'definition.resources.connectors.0',
        reason: 'its credential secret is not named',
      },
    ]);
  });

  it('postgres: a postgres catalog tool is dropped', () => {
    const agent = defineAgent({
      ...MINIMAL,
      tools: [
        postgresTool({
          name: 'orders-db',
          url: secret('ORDERS_DB_URL'),
          readOnly: true,
          tables: ['public.orders'],
        }),
      ],
    });
    const { value, dropped } = toPortableAgent(agent);
    expect(value.tools).toEqual([]);
    expect(dropped).toEqual([
      {
        path: 'definition.resources.connectors.0',
        reason: 'postgres tools run only inside Agent Workspace',
      },
    ]);
  });

  it('mcp: an http connector, or one with no transport, is streamable-http', () => {
    const agent = defineAgent({ ...MINIMAL, tools: [mcp('plain'), mcp('zendesk')] });
    expect(toPortableAgent(agent, { project: PROJECT }).value.tools).toEqual([
      {
        kind: 'mcp',
        name: 'plain',
        transport: 'streamable-http',
        url: 'https://plain.example.com/mcp',
      },
      {
        kind: 'mcp',
        name: 'zendesk',
        transport: 'streamable-http',
        url: 'https://zendesk.example.com/mcp',
        auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
      },
    ]);
  });

  it('mcp: an sse connector is sse, and an api-key scheme is carried', () => {
    const agent = defineAgent({ ...MINIMAL, tools: [mcp('events'), mcp('keyed')] });
    expect(toPortableAgent(agent, { project: PROJECT }).value.tools).toEqual([
      { kind: 'mcp', name: 'events', transport: 'sse', url: 'https://events.example.com/sse' },
      {
        kind: 'mcp',
        name: 'keyed',
        transport: 'streamable-http',
        url: 'https://keyed.example.com/mcp',
        auth: { scheme: 'api-key', secretRef: 'KEYED_TOKEN' },
      },
    ]);
  });

  it('mcp: a connector identity assertion is not carried, and is reported at the tool', () => {
    const project = ProjectDocumentSchema.parse({
      ...PROJECT,
      connectors: {
        signed: {
          url: 'https://signed.example.com/mcp',
          identity: { secret: 'SIGNED_MCP_IDENTITY' },
        },
      },
    });
    const { value, dropped } = toPortableAgent(
      defineAgent({ ...MINIMAL, tools: [mcp('signed')] }),
      {
        project,
      },
    );
    expect(value.tools).toEqual([
      {
        kind: 'mcp',
        name: 'signed',
        transport: 'streamable-http',
        url: 'https://signed.example.com/mcp',
      },
    ]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.path).toBe('definition.resources.connectors.0.identity');
    expect(dropped[0]?.reason).toContain('SIGNED_MCP_IDENTITY');
  });

  it('mcp: a connector the project does not declare is dropped', () => {
    const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, tools: [mcp('x')] }), {
      project: PROJECT,
    });
    expect(value.tools).toEqual([]);
    expect(dropped).toEqual([
      {
        path: 'definition.resources.connectors.0',
        reason:
          'connector "x" is not declared in agent-workspace.yaml connectors:, so its URL is unknown',
      },
    ]);
  });

  it('mcp: a connector name that is an Object.prototype key is not found', () => {
    const { dropped } = toPortableAgent(defineAgent({ ...MINIMAL, tools: [mcp('constructor')] }), {
      project: PROJECT,
    });
    expect(dropped).toHaveLength(1);
  });

  it('mcp: a connector whose name is not a portable tool name is dropped with the schema’s reason', () => {
    const spaced = ProjectDocumentSchema.parse({
      ...PROJECT,
      connectors: { 'my-connector': { url: 'https://c.example.com/mcp' } },
    });
    const body = bodyWith(BASE_BODY, {
      resources: { ...BASE_BODY.definition.resources, connectors: ['my connector'] },
    });
    const { value, dropped } = portableFromAgentVersionBody(body, {
      connectors: { ...spaced.connectors, 'my connector': { url: 'https://c.example.com/mcp' } },
    });
    expect(value.tools).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/^cannot be written as a portable tool: name: /u);
  });

  it('tools: come out in resources.connectors order, code tools at the aw-dev-tools position', () => {
    const agent = defineAgent({
      ...MINIMAL,
      tools: [ordersApi, getOrder, mcp('zendesk')],
    });
    const { value } = toPortableAgent(agent, { project: PROJECT });
    expect(namesOf(value.tools)).toEqual(['orders-api', 'get_order', 'zendesk']);
  });

  it('drops: a postgres tool, an undeclared mcp, a file and a surface give one drop each', () => {
    const agent = defineAgent({
      ...MINIMAL,
      files: [files('docs/a.md')],
      tools: [
        postgresTool({
          name: 'orders-db',
          url: secret('ORDERS_DB_URL'),
          readOnly: true,
          tables: ['public.orders'],
        }),
        mcp('x'),
      ],
    });
    const surface = defineSurface({ name: 'main', agent: 'assistant' });
    const { dropped } = toPortableAgent(agent, { project: PROJECT, surfaces: [surface] });
    expect(dropped.map((entry) => entry.path)).toEqual([
      'definition.resources.files.0',
      'definition.resources.connectors.0',
      'definition.resources.connectors.1',
      'surfaces.0',
    ]);
  });
});

const PORTABLE: PortableAgentInput = {
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'Agent',
  name: 'assistant',
  instructions: 'Answer briefly.',
  permissions: NO_PERMISSIONS,
};

function fromPortable(
  extra: Partial<PortableAgentInput>,
  context?: Pick<PortableAgentContext, 'models'>,
) {
  return defineAgentFromPortable({ ...PORTABLE, ...extra }, context);
}

describe('defineAgentFromPortable', () => {
  it('name, instructions, permissions: are carried unchanged', () => {
    const { value, dropped } = fromPortable({
      name: 'support-triage',
      instructions: 'Triage.',
      permissions: SAMPLE_PERMISSIONS,
    });
    expect(dropped).toEqual([]);
    expect(value).toMatchObject({
      name: 'support-triage',
      instructions: 'Triage.',
      permissions: SAMPLE_PERMISSIONS,
    });
  });

  it('input: refuses something that is not a portable agent, under its subject', () => {
    const error = thrown(() => defineAgentFromPortable({ ...PORTABLE, name: 'Not Kebab' }));
    expect(error.message).toContain('defineAgentFromPortable()');
    expect(error.issues[0]?.path).toBe('name');
  });

  it('model: absent stays absent', () => {
    expect(fromPortable({}).value.model).toBeUndefined();
  });

  it('model: a provider becomes the alphabetically first connection with that provider', () => {
    const { value } = fromPortable(
      { model: { provider: 'anthropic', id: 'm-1' } },
      { models: PROJECT.models },
    );
    expect(value.model).toEqual({ connection: 'anthropic', id: 'm-1' });
    const later = fromPortable(
      { model: { provider: 'anthropic', id: 'm-1' } },
      {
        models: {
          'z-conn': { provider: 'anthropic', credential: { secret: 'Z_KEY' } },
          'b-conn': { provider: 'anthropic', credential: { secret: 'B_KEY' } },
        },
      },
    );
    expect(later.value.model).toEqual({ connection: 'b-conn', id: 'm-1' });
  });

  it("model: no connection with the provider, or no provider, gives 'default'", () => {
    expect(
      fromPortable({ model: { provider: 'openai', id: 'm-1' } }, { models: PROJECT.models }).value
        .model,
    ).toEqual({ connection: 'default', id: 'm-1' });
    expect(fromPortable({ model: { id: 'm-1' } }, { models: PROJECT.models }).value.model).toEqual({
      connection: 'default',
      id: 'm-1',
    });
    expect(fromPortable({ model: { provider: 'anthropic', id: 'm-1' } }).value.model).toEqual({
      connection: 'default',
      id: 'm-1',
    });
  });

  it('engine: an engine with a block becomes { id, ...block }', () => {
    const { value, dropped } = fromPortable({
      engine: pi,
      extensions: { engines: { [pi]: { thinkingLevel: 'low' } } },
    });
    expect(dropped).toEqual([]);
    expect(value.engine).toEqual({ id: pi, thinkingLevel: 'low' });
  });

  it('engine: an engine with no block stays the engine id; none stays none', () => {
    expect(fromPortable({ engine: openai }).value.engine).toBe(openai);
    expect(fromPortable({}).value.engine).toBeUndefined();
  });

  it('engine: a block defineAgent refuses throws', () => {
    const error = thrown(() =>
      fromPortable({ engine: pi, extensions: { engines: { [pi]: { thinkingLevel: 'loud' } } } }),
    );
    expect(error.message).toContain('defineAgentFromPortable()');
    expect(error.issues[0]?.path).toBe('engine');
  });

  it('engine: a customised Claude tool policy is dropped', () => {
    const tools = { ...claudeBaseToolPolicyFor(NO_PERMISSIONS), deny: [] };
    for (const block of [{ tools }, { tools: { base: 'claude_code_preset' } }]) {
      const { value, dropped } = fromPortable({
        engine: claude,
        extensions: { engines: { [claude]: block } },
      });
      expect(value.engine).toBe(claude);
      expect(dropped).toEqual([
        {
          path: `extensions.engines.${claude}.tools`,
          reason:
            'a stored Claude tool policy cannot be written in defineAgent(); set it with aw agents policy',
        },
      ]);
    }
  });

  it('engine: the base Claude tool policy of the permissions is stripped without a drop', () => {
    const { value, dropped } = fromPortable({
      engine: claude,
      extensions: { engines: { [claude]: { tools: claudeBaseToolPolicyFor(NO_PERMISSIONS) } } },
    });
    expect(value.engine).toBe(claude);
    expect(dropped).toEqual([]);
  });

  it('engine: a Claude tool policy that only adds autoApprove round-trips as engine.autoApprove', () => {
    const agent = defineAgent({
      ...MINIMAL,
      engine: { id: claude, autoApprove: ['Bash'] },
      permissions: { runCommands: true },
    });
    const portable = toPortableAgent(agent);
    const { value, dropped } = defineAgentFromPortable(portable.value);
    expect(dropped).toEqual([]);
    expect(value.engine).toEqual({ id: claude, autoApprove: ['Bash'] });
    expect(toAgentVersionBody(value)).toEqual(toAgentVersionBody(agent));
  });

  it('engine: an autoApprove for a tool the permissions turn off throws', () => {
    const tools = { ...claudeBaseToolPolicyFor(NO_PERMISSIONS), autoApprove: ['Read'] };
    const error = thrown(() =>
      fromPortable({ engine: claude, extensions: { engines: { [claude]: { tools } } } }),
    );
    expect(error.issues[0]?.path).toBe('engine.autoApprove.0');
  });

  it('engine: the base Claude tool policy in another rule order is stripped without a drop', () => {
    const base = claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS);
    expect(base.deny.length).toBeGreaterThan(1);
    const tools = { ...base, deny: [...base.deny].reverse() };
    const { dropped } = fromPortable({
      engine: claude,
      permissions: SAMPLE_PERMISSIONS,
      extensions: { engines: { [claude]: { tools } } },
    });
    expect(dropped).toEqual([]);
  });

  it('engine: settings for another engine are dropped, also when the agent names none', () => {
    const { dropped } = fromPortable({
      engine: pi,
      extensions: { engines: { [openai]: { reasoningEffort: 'high' } } },
    });
    expect(dropped).toEqual([
      {
        path: `extensions.engines.${openai}`,
        reason: 'settings for an engine this agent does not use',
      },
    ]);
    const implicit = fromPortable({ extensions: { engines: { [pi]: { thinkingLevel: 'low' } } } });
    expect(implicit.dropped.map((entry) => entry.path)).toEqual([`extensions.engines.${pi}`]);
  });

  it('extensions.platforms: each platform’s options are dropped', () => {
    const { dropped } = fromPortable({
      extensions: { platforms: { 'copilot-studio': { schemaName: 'x' } } },
    });
    expect(dropped).toEqual([
      {
        path: 'extensions.platforms.copilot-studio',
        reason: 'platform options apply to aw platforms export, not to the agent',
      },
    ]);
  });

  it('limits: are carried', () => {
    expect(fromPortable({ limits: { maxTurns: 4, maxBudgetUsd: 2 } }).value.limits).toEqual({
      maxTurns: 4,
      maxBudgetUsd: 2,
    });
  });

  it('tools: a remote mcp tool becomes mcp(name)', () => {
    const { value, dropped } = fromPortable({
      tools: [
        {
          kind: 'mcp',
          name: 'crm',
          transport: 'streamable-http',
          url: 'https://crm.example.com/mcp',
        },
        { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://legacy.example.com/sse' },
      ],
    });
    expect(dropped).toEqual([]);
    expect(toAgentVersionBody(value).definition.resources.connectors).toEqual(['crm', 'legacy']);
  });

  it('tools: a stdio mcp tool is dropped', () => {
    const { value, dropped } = fromPortable({
      tools: [{ kind: 'mcp', name: 'local', transport: 'stdio', command: 'npx' }],
    });
    expect(value.tools).toEqual([]);
    expect(dropped).toEqual([
      {
        path: 'tools.0',
        reason: 'Agent Workspace project files name remote connectors only (http or sse)',
      },
    ]);
  });

  it('tools: a code tool is dropped', () => {
    const { dropped } = fromPortable({
      tools: [{ kind: 'code', name: 'lookup', description: 'Looks up.', inputSchema: {} }],
    });
    expect(dropped).toEqual([
      { path: 'tools.0', reason: 'a code tool needs its run file; declare it with defineTool()' },
    ]);
  });

  it('tools: an openapi tool with allow becomes openapiTool(), its secrets by name', () => {
    const { value, dropped } = fromPortable({
      tools: [
        {
          kind: 'openapi',
          name: 'orders',
          specRef: 'openapi/orders.json',
          allow: ['GET /orders/*'],
          baseUrl: 'https://api.example.com',
          auth: { secretRef: 'ORDERS_TOKEN' },
        },
        {
          kind: 'openapi',
          name: 'keyed',
          specRef: 'https://api.example.com/openapi.json',
          allow: ['GET /k'],
          auth: { secretRef: 'KEYED_TOKEN', header: 'X-Api-Key' },
        },
        { kind: 'openapi', name: 'open', specRef: 'openapi/open.json', allow: ['GET /o'] },
      ],
    });
    expect(dropped).toEqual([]);
    expect(toolDefinitionsOf(value)).toEqual([
      {
        kind: 'openapi',
        name: 'orders',
        spec: 'openapi/orders.json',
        allow: ['GET /orders/*'],
        baseUrl: 'https://api.example.com',
        auth: 'bearer',
        credential: { secret: 'ORDERS_TOKEN' },
      },
      {
        kind: 'openapi',
        name: 'keyed',
        spec: 'https://api.example.com/openapi.json',
        allow: ['GET /k'],
        auth: { header: 'X-Api-Key' },
        credential: { secret: 'KEYED_TOKEN' },
      },
      { kind: 'openapi', name: 'open', spec: 'openapi/open.json', allow: ['GET /o'], auth: 'none' },
    ]);
  });

  it('tools: an openapi tool without allow is dropped', () => {
    const { value, dropped } = fromPortable({
      tools: [{ kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json' }],
    });
    expect(value.tools).toEqual([]);
    expect(dropped).toEqual([
      { path: 'tools.0', reason: 'Agent Workspace needs explicit allow rules for an OpenAPI tool' },
    ]);
  });

  it('tools: an openapi tool openapiTool() refuses is dropped with its message', () => {
    const rules = ['post /orders'];
    const refusal = thrown(() =>
      openapiTool({ name: 'orders', spec: 'openapi/orders.json', allow: rules }),
    );
    const { value, dropped } = fromPortable({
      tools: [{ kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json', allow: rules }],
    });
    expect(value.tools).toEqual([]);
    expect(dropped).toEqual([{ path: 'tools.0', reason: refusal.message }]);
  });

  it('tools: web_search and web_fetch are kept by unrestrictedNetwork, with no drop when on', () => {
    const { value, dropped } = fromPortable({
      permissions: { ...NO_PERMISSIONS, unrestrictedNetwork: true },
      tools: [
        { kind: 'builtin', id: 'web_search' },
        { kind: 'builtin', id: 'web_fetch' },
      ],
    });
    expect(dropped).toEqual([]);
    expect(value.permissions?.unrestrictedNetwork).toBe(true);
  });

  it('tools: web_search with unrestrictedNetwork off is dropped', () => {
    const { dropped } = fromPortable({ tools: [{ kind: 'builtin', id: 'web_search' }] });
    expect(dropped).toEqual([
      { path: 'tools.0', reason: 'grant permissions.unrestrictedNetwork to keep it' },
    ]);
  });

  it('tools: web_fetch with unrestrictedNetwork off is dropped', () => {
    const { dropped } = fromPortable({ tools: [{ kind: 'builtin', id: 'web_fetch' }] });
    expect(dropped).toEqual([
      { path: 'tools.0', reason: 'grant permissions.unrestrictedNetwork to keep it' },
    ]);
  });

  it('tools: file_access is kept by readFiles and dropped without it', () => {
    const tools = [{ kind: 'builtin', id: 'file_access' }] as const;
    expect(
      fromPortable({ tools, permissions: { ...NO_PERMISSIONS, readFiles: true } }).dropped,
    ).toEqual([]);
    expect(fromPortable({ tools }).dropped).toEqual([
      { path: 'tools.0', reason: 'grant permissions.readFiles to keep it' },
    ]);
  });

  it('tools: code_execution is kept by runCommands and dropped without it', () => {
    const tools = [{ kind: 'builtin', id: 'code_execution' }] as const;
    expect(
      fromPortable({ tools, permissions: { ...NO_PERMISSIONS, runCommands: true } }).dropped,
    ).toEqual([]);
    expect(fromPortable({ tools }).dropped).toEqual([
      { path: 'tools.0', reason: 'grant permissions.runCommands to keep it' },
    ]);
  });

  it('skills: become skill(name) in order', () => {
    const { value, dropped } = fromPortable({
      skills: [
        { name: 'refund-policy', path: 'skills/refund-policy' },
        { name: 'escalation', path: 'skills/escalation' },
      ],
    });
    expect(dropped).toEqual([]);
    expect(value.skills?.map((entry) => entry.name)).toEqual(['refund-policy', 'escalation']);
  });

  it('skills: a path other than skills/<name> is reported, the skill is kept', () => {
    const { value, dropped } = fromPortable({
      skills: [{ name: 'refund-policy', path: 'shared/refunds' }],
    });
    expect(value.skills).toHaveLength(1);
    expect(dropped).toEqual([
      {
        path: 'skills.0.path',
        reason: 'a skill is read from skills/refund-policy/ in the project',
      },
    ]);
  });

  it('description, files knowledge, subagents: are carried; a url source is dropped', () => {
    const { value, dropped } = fromPortable({
      description: 'Answers questions.',
      knowledge: [
        { kind: 'files', paths: ['docs/a.md'] },
        { kind: 'url', url: 'https://example.com/help' },
      ],
      subagents: [{ name: 'billing' }],
    });
    expect(dropped).toEqual([
      {
        path: 'knowledge.1',
        reason:
          'Agent Workspace engines cannot read a URL knowledge source; add a connector or a file',
      },
    ]);
    expect(value.description).toBe('Answers questions.');
    expect(value.subagents).toEqual(['billing']);
    expect(value.knowledge).toEqual([{ kind: 'files', paths: ['docs/a.md'] }]);
  });

  it('knowledge: a connector source is kept with its mcp tool, dropped without it', () => {
    const kept = fromPortable({
      tools: [
        { kind: 'mcp', name: 'wiki', transport: 'streamable-http', url: 'https://w.example/mcp' },
      ],
      knowledge: [{ kind: 'connector', name: 'wiki' }],
    });
    expect(kept.dropped).toEqual([]);
    expect(kept.value.knowledge).toEqual([{ kind: 'connector', name: 'wiki' }]);

    const lost = fromPortable({
      tools: [{ kind: 'mcp', name: 'wiki', transport: 'stdio', command: 'wiki-mcp' }],
      knowledge: [{ kind: 'connector', name: 'wiki' }],
    });
    expect(lost.dropped.map((entry) => entry.path)).toEqual(['tools.0', 'knowledge.0']);
    expect(lost.value.knowledge).toBeUndefined();
  });

  it('is pure: the input is not changed and the output is frozen', () => {
    const input: PortableAgentInput = {
      ...PORTABLE,
      tools: [{ kind: 'builtin', id: 'web_search' }],
      extensions: { platforms: { 'copilot-studio': {} } },
    };
    const before = structuredClone(input);
    const result = defineAgentFromPortable(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.dropped)).toBe(true);
    expect(result.dropped.every((entry) => Object.isFrozen(entry))).toBe(true);
  });
});

describe('round trip', () => {
  const context = { models: PROJECT.models };
  const roundTrip = (agent: ReturnType<typeof defineAgent>) =>
    toAgentVersionBody(
      defineAgentFromPortable(toPortableAgent(agent, { project: PROJECT }).value, context).value,
    );

  it('keeps an agent with mcp, openapi, skills, limits and engine settings', () => {
    const agent = defineAgent({
      name: 'support-triage',
      instructions: 'Triage tickets.',
      model: { connection: 'anthropic', id: 'claude-sonnet-4-6' },
      engine: { id: pi, thinkingLevel: 'low' },
      permissions: SAMPLE_PERMISSIONS,
      tools: [mcp('zendesk'), mcp('events'), ordersApi],
      skills: [skill('refund-policy'), skill('escalation')],
      limits: { maxTurns: 20, maxBudgetUsd: 1.5 },
    });
    expect(roundTrip(agent)).toEqual(toAgentVersionBody(agent));
  });

  it('keeps a compiled Claude agent, and a stored one whose base tool policy is not dropped', () => {
    const compiled = defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS });
    expect(roundTrip(compiled)).toEqual(toAgentVersionBody(compiled));

    const stored = defineAgent({
      ...MINIMAL,
      permissions: SAMPLE_PERMISSIONS,
      limits: { maxTurns: 9 },
    });
    const exported = toPortableAgent(stored, { project: PROJECT }).value;
    const back = defineAgentFromPortable(exported, context);
    expect(back.dropped).toEqual([]);
    expect(toAgentVersionBody(back.value)).toEqual(toAgentVersionBody(stored));
  });

  it('keeps a read knowledge file and a read-write one as read-write', () => {
    const grant = (access?: 'read-write') => ({
      ...MINIMAL,
      permissions: { ...SAMPLE_PERMISSIONS, writeFiles: true },
      files: [files('docs/a.md', access)],
      knowledge: [{ kind: 'files' as const, paths: ['docs/a.md'] }],
    });
    const read = defineAgent(grant());
    expect(roundTrip(read)).toEqual(toAgentVersionBody(read));

    const readWrite = defineAgent(grant('read-write'));
    expect(toPortableAgent(readWrite, { project: PROJECT }).dropped).toEqual([]);
    expect(roundTrip(readWrite)).toEqual(toAgentVersionBody(readWrite));
  });

  it('imports a read-write path two knowledge sources name with one read-write grant', () => {
    const agent = defineAgent({
      ...MINIMAL,
      permissions: { ...SAMPLE_PERMISSIONS, writeFiles: true },
      files: [files('docs/a.md', 'read-write'), files('docs/b.md')],
      knowledge: [
        { kind: 'files', paths: ['docs/a.md'] },
        { kind: 'files', paths: ['docs/a.md', 'docs/b.md'] },
      ],
    });
    const portable = toPortableAgent(agent, { project: PROJECT }).value;
    const back = defineAgentFromPortable(portable, context);
    expect(back.dropped).toEqual([]);
    expect(back.value.files).toEqual([files('docs/a.md', 'read-write')]);
  });

  it('imports a read-write knowledge file as read, with a verdict, while writeFiles is off', () => {
    const portable = toPortableAgent(
      defineAgent({
        ...MINIMAL,
        files: [files('docs/a.md', 'read-write')],
        knowledge: [{ kind: 'files', paths: ['docs/a.md'] }],
      }),
      { project: PROJECT },
    ).value;
    const back = defineAgentFromPortable(portable, { models: PROJECT.models });
    expect(back.dropped).toEqual([
      {
        path: 'knowledge.0.access',
        reason: 'grant permissions.writeFiles to keep it read-write',
      },
    ]);
    expect(back.value.files).toBeUndefined();
  });

  it('keeps an agent on each other engine', () => {
    for (const engine of [openai, pi, mastra]) {
      const agent = defineAgent({ ...MINIMAL, engine });
      expect(roundTrip(agent)).toEqual(toAgentVersionBody(agent));
    }
  });
});
