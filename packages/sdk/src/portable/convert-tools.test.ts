import { expect, it } from 'vitest';

import { ProjectDocumentSchema } from '@indx-workspace/contracts/project-file';
import {
  CODE_TOOL_DEFAULT_TIMEOUT_MS,
  defineAgent,
  defineSurface,
  defineTool,
  files,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  toAgentVersionBody,
  z,
} from '../define/index.js';
import { portableFromAgentVersionBody, toPortableAgent } from './index.js';
import {
  PROJECT,
  MINIMAL,
  getOrder,
  ordersApi,
  BASE_BODY,
  bodyWith,
  namesOf,
  DIGEST,
  ORDERS_DEFINITION,
} from './convert.fixture.test-support.js';

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
  const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, tools: [mcp('signed')] }), {
    project,
  });
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
