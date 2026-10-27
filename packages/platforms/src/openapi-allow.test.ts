import { PortableProjectSchema } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { narrowOpenApiSpec } from './openapi-allow.js';
import { SAMPLE_PORTABLE_PROJECT } from './testing/sample.js';

const SPEC = {
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1' },
  paths: {
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { operationId: 'getOrder' },
      delete: { operationId: 'deleteOrder' },
    },
    '/orders': {
      get: { operationId: 'listOrders' },
      post: { operationId: 'createOrder' },
      options: { operationId: 'optionsOrder' },
    },
    '/admin': { get: { operationId: 'getAdmin' } },
  },
  components: { schemas: { Order: { type: 'object' } } },
};

function projectWith(content: string, ref = 'openapi/orders.json') {
  return PortableProjectSchema.parse({
    ...SAMPLE_PORTABLE_PROJECT,
    openapiSpecs: [{ ref, content }],
  });
}

const JSON_PROJECT = projectWith(JSON.stringify(SPEC));
const tool = (allow: readonly string[]) => ({ specRef: 'openapi/orders.json', allow });

function pathsOf(result: ReturnType<typeof narrowOpenApiSpec>): unknown {
  if (!result.ok) throw new Error(result.reason);
  return result.spec['paths'];
}

describe('narrowOpenApiSpec', () => {
  it('keeps only the operations a path rule admits and leaves components alone', () => {
    const result = narrowOpenApiSpec(JSON_PROJECT, tool(['GET /orders/*']));
    expect(pathsOf(result)).toEqual({
      '/orders/{id}': {
        parameters: SPEC.paths['/orders/{id}'].parameters,
        get: { operationId: 'getOrder' },
      },
    });
    expect(result.ok && result.spec['components']).toEqual(SPEC.components);
  });

  it('admits an operation named by an operationId rule', () => {
    expect(pathsOf(narrowOpenApiSpec(JSON_PROJECT, tool(['operationId:getAdmin'])))).toEqual({
      '/admin': { get: { operationId: 'getAdmin' } },
    });
  });

  it('admits a write operation named by an operationId rule (#1304)', () => {
    expect(pathsOf(narrowOpenApiSpec(JSON_PROJECT, tool(['operationId:createOrder'])))).toEqual({
      '/orders': { post: { operationId: 'createOrder' } },
    });
  });

  it('drops a path-level $ref, whose operations the rules never saw', () => {
    const project = projectWith(
      JSON.stringify({
        openapi: '3.1.0',
        paths: { '/orders': { $ref: '#/components/pathItems/Orders', get: { operationId: 'a' } } },
        components: { pathItems: { Orders: { post: { operationId: 'createOrder' } } } },
      }),
    );
    expect(pathsOf(narrowOpenApiSpec(project, tool(['GET /orders'])))).toEqual({
      '/orders': { get: { operationId: 'a' } },
    });
  });

  it('reads a YAML document', () => {
    const yaml = projectWith(
      'openapi: 3.1.0\npaths:\n  /a:\n    get: {operationId: a}\n    post: {}\n',
    );
    expect(pathsOf(narrowOpenApiSpec(yaml, tool(['GET /a'])))).toEqual({
      '/a': { get: { operationId: 'a' } },
    });
  });

  it('does not mutate the bundled content', () => {
    const before = JSON.stringify(JSON_PROJECT);
    narrowOpenApiSpec(JSON_PROJECT, tool(['GET /orders']));
    expect(JSON.stringify(JSON_PROJECT)).toBe(before);
  });

  it.each([
    [
      'a spec that is not bundled',
      { specRef: 'https://example.com/other.json', allow: ['GET /a'] },
    ],
    ['rules that admit nothing', tool(['GET /nothing'])],
    ['an unsupported method', tool(['GET /orders/*', 'operationId:optionsOrder'])],
  ])('fails for %s', (_name, input) => {
    expect(narrowOpenApiSpec(JSON_PROJECT, input).ok).toBe(false);
  });

  it('fails for a document with no paths object', () => {
    expect(narrowOpenApiSpec(projectWith('[]'), tool(['GET /a'])).ok).toBe(false);
  });
});
