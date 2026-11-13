import { type PortableProject } from '@indx-workspace/contracts/portable-agent';
import { SAMPLE_PORTABLE_PROJECT } from '../../testing/index.js';
import { describe, expect, it } from 'vitest';

import {
  MODEL_OPTIONS,
  ROOT,
  parse,
  compile,
  versionOf,
  verdictAt,
  planOf,
} from '../../testing/foundry-compile.fixture.test-support.js';

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

describe('Foundry OpenAPI mapping', () => {
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
    const plan = planOf(compile(sample));
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
    expect(planOf(result).openapiSpecs).toEqual([]);
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
});
