import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { SAMPLE_PORTABLE_PROJECT } from '../../testing/index.js';
import {
  compiled,
  json,
  projectWith,
  text,
  verdict,
} from '../../testing/m365-declarative-agent-compile.test-support.js';
import { DeclarativeAgentManifestV18Schema, PluginManifestV24Schema } from './vendor-schema.js';

const ORDERS_SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders/{id}': { get: { operationId: 'getOrder' } },
    '/refunds': { post: { operationId: 'createRefund' } },
  },
});

const ordersTool = {
  kind: 'openapi',
  name: 'orders-api',
  specRef: 'openapi/orders.json',
} as const;
const ordersSpec = { ref: 'openapi/orders.json', content: ORDERS_SPEC };

function withAllow(allow: readonly string[], specs = SAMPLE_PORTABLE_PROJECT.openapiSpecs) {
  return PortableProjectSchema.parse({
    ...projectWith({ tools: [{ ...ordersTool, allow }] }),
    openapiSpecs: specs,
  });
}

describe('OpenAPI bundling', () => {
  it('bundles a spec narrowed to the allowed operations and points the plugin at it', () => {
    const { files, report } = compiled(withAllow(['GET /orders/*'], [ordersSpec]));
    const spec = json(files, 'appPackage/openapi/orders-api.json');
    expect(Object.keys(spec['paths'] as object)).toEqual(['/orders/{id}']);
    expect(text(files, 'appPackage/openapi/orders-api.json')).not.toContain('/refunds');
    const plugin = PluginManifestV24Schema.parse(
      json(files, 'appPackage/ai-plugin.orders-api.json'),
    );
    expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'openapi/orders-api.json' });
    expect(verdict(report, 'support-triage.tools.0')).toMatchObject({ verdict: 'mapped' });
  });

  it('bundles the whole document untouched, keeping its extension, when there is no allow', () => {
    const yaml = 'openapi: 3.1.0\ninfo: {title: Orders, version: "1"}\npaths: {}\n';
    const { files } = compiled(
      PortableProjectSchema.parse({
        ...projectWith({
          tools: [{ kind: 'openapi', name: 'orders-api', specRef: 'specs/orders.yaml' }],
        }),
        openapiSpecs: [{ ref: 'specs/orders.yaml', content: yaml }],
      }),
    );
    expect(text(files, 'appPackage/openapi/orders-api.yaml')).toBe(yaml);
    const plugin = PluginManifestV24Schema.parse(
      json(files, 'appPackage/ai-plugin.orders-api.json'),
    );
    expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'openapi/orders-api.yaml' });
  });

  it('keeps an https spec as the plugin url and bundles nothing', () => {
    const { files } = compiled(
      projectWith({
        tools: [
          { kind: 'openapi', name: 'orders-api', specRef: 'https://api.example.com/spec.json' },
        ],
      }),
    );
    const plugin = PluginManifestV24Schema.parse(
      json(files, 'appPackage/ai-plugin.orders-api.json'),
    );
    expect(plugin.runtimes?.[0]?.spec).toEqual({ url: 'https://api.example.com/spec.json' });
    expect(files.some((file) => file.path.startsWith('appPackage/openapi/'))).toBe(false);
  });
});

describe('OpenAPI dropped tools', () => {
  it('drops a relative spec that the project does not bundle', () => {
    const { files, report } = compiled(
      PortableProjectSchema.parse({
        ...projectWith({
          tools: [{ kind: 'openapi', name: 'orders-api', specRef: 'openapi/orders.json' }],
        }),
        openapiSpecs: [],
      }),
    );
    expect(verdict(report, 'support-triage.tools.0')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
    expect(files.some((file) => file.path.includes('orders-api'))).toBe(false);
  });

  it.each([
    ['the spec is not bundled', ['GET /orders/*'], []],
    ['allow admits no operation', ['GET /nothing'], [ordersSpec]],
  ])('drops the tool when %s', (_name, allow, specs) => {
    const { files, report } = compiled(withAllow(allow, specs));
    expect(verdict(report, 'support-triage.tools.0')).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
    expect(files.some((file) => file.path.includes('orders-api'))).toBe(false);
  });
});

const mcp = (name: string) =>
  ({
    kind: 'mcp',
    name,
    transport: 'streamable-http',
    url: `https://mcp.example.com/${name}`,
    auth: { scheme: 'bearer', secretRef: 'TOKEN' },
  }) as const;

type Files = ReturnType<typeof compiled>['files'];

function emittedPlugins(files: Files) {
  return files
    .filter((file) => /^appPackage\/ai-plugin\..+\.json$/u.test(file.path))
    .map((file) => ({
      path: file.path,
      plugin: PluginManifestV24Schema.parse(json(files, file.path)),
    }));
}

function distinctCount(values: readonly string[]): number {
  return new Set(values.map((value) => value.toLowerCase())).size;
}

function expectCollisionFreePlugins(files: Files): void {
  const plugins = emittedPlugins(files);
  expect(plugins.map(({ path }) => path)).toEqual([
    'appPackage/ai-plugin.My-Tool-3.json',
    'appPackage/ai-plugin.my-tool.json',
    'appPackage/ai-plugin.my_tool-2.json',
    'appPackage/ai-plugin.mytool-4.json',
  ]);
  expect(distinctCount(plugins.map(({ plugin }) => plugin.namespace))).toBe(4);
  expect(distinctCount(plugins.map(({ path }) => path))).toBe(4);
}

function expectCollisionFreeActionsAndVariables(files: Files): void {
  const actions = DeclarativeAgentManifestV18Schema.parse(
    json(files, 'appPackage/declarativeAgent.json'),
  ).actions;
  expect(actions?.map((action) => action.id)).toEqual([
    'my-tool',
    'my_tool-2',
    'My-Tool-3',
    'mytool-4',
  ]);
  const variables = text(files, 'env/.env.dev')
    .split('\n')
    .filter((line) => line.startsWith('MCP_'));
  expect(variables).toEqual([
    'MCP_MY_TOOL_AUTH_REFERENCE_ID=',
    'MCP_MY_TOOL_2_AUTH_REFERENCE_ID=',
    'MCP_MY_TOOL_3_AUTH_REFERENCE_ID=',
    'MCP_MYTOOL_4_AUTH_REFERENCE_ID=',
  ]);
}

describe('tool name collisions', () => {
  it('renames tools whose file name, namespace or auth variable would collide', () => {
    const { files, report } = compiled(
      projectWith({ tools: [mcp('my-tool'), mcp('my_tool'), mcp('My-Tool'), mcp('mytool')] }),
    );
    expect(verdict(report, 'support-triage.tools.0')?.note).not.toContain('emitted as');
    expect(verdict(report, 'support-triage.tools.1')).toMatchObject({ verdict: 'mapped' });
    expect(verdict(report, 'support-triage.tools.1')?.note).toMatch(/^emitted as my_tool-2: /u);
    expectCollisionFreePlugins(files);
    expectCollisionFreeActionsAndVariables(files);
  });

  it('moves the code-tools plugin aside when a tool already uses its name', () => {
    const { files, report } = compiled(
      projectWith({
        tools: [
          mcp('aw-tools'),
          {
            kind: 'code',
            name: 'get_order',
            description: 'Look up an order',
            inputSchema: { type: 'object' },
          },
        ],
      }),
    );
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'appPackage/ai-plugin.aw-tools.json',
        'appPackage/ai-plugin.aw-tools-2.json',
      ]),
    );
    expect(text(files, 'env/.env.dev')).toContain('MCP_AW_TOOLS_2_AUTH_REFERENCE_ID=');
    expect(verdict(report, 'toolEndpoint')?.note).toContain('ai-plugin.aw-tools-2.json');
  });
});
