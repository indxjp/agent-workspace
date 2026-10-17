import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { normaliseOpenApi, operationName, type NormaliseInput } from './normalise';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const ALLOW = ['GET /pets', 'GET /pets/*', 'GET /pets/*/photos'];

function input(document: string, overrides: Partial<NormaliseInput> = {}): NormaliseInput {
  return { document, allow: ALLOW, auth: 'none', ...overrides };
}

/** A minimal 3.0 document with `paths`, and `servers` unless the caller replaces them. */
function doc(paths: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://93.184.216.34' }],
    paths,
    ...extra,
  });
}

const okResponse = { responses: { '200': { description: 'ok' } } };

function refusal(result: ReturnType<typeof normaliseOpenApi>): {
  code: string;
  details: readonly string[];
} {
  if (result.ok) throw new Error('expected a refusal');
  return { code: result.code, details: result.details };
}

describe('normaliseOpenApi', () => {
  const fixtures = [
    'petstore-3.0.json',
    'petstore-3.0.yaml',
    'petstore-3.1.json',
    'petstore-3.1.yaml',
  ];

  it.each(fixtures)('%s normalises to the three read operations', (name) => {
    const result = normaliseOpenApi(input(fixture(name)));
    if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.openapi.operations).toEqual([
      { name: 'listPets', method: 'GET', path: '/pets' },
      { name: 'showPetById', method: 'GET', path: '/pets/{petId}' },
      { name: 'listPhotos', method: 'GET', path: '/pets/{petId}/photos' },
    ]);
    expect(result.openapi.baseUrl).toBe('https://93.184.216.34/v1');
    expect(result.baseUrlFromServers).toBe(true);
    expect(result.openapi.spec.title).toBe('Petstore');
    expect(result.openapi.spec.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.parameters['showPetById']).toEqual([
      { name: 'petId', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('gives JSON and YAML of one version the same operations and parameters', () => {
    const json = normaliseOpenApi(input(fixture('petstore-3.1.json')));
    const yaml = normaliseOpenApi(input(fixture('petstore-3.1.yaml')));
    if (!json.ok || !yaml.ok) throw new Error('expected both to normalise');
    expect(yaml.openapi.operations).toEqual(json.openapi.operations);
    expect(yaml.parameters).toEqual(json.parameters);
  });

  it('refuses an external $ref, naming it', () => {
    const result = normaliseOpenApi(
      input(
        doc({ '/pets': { get: { ...okResponse, parameters: [{ $ref: './other.yaml#/X' }] } } }),
        {
          allow: ['GET /pets'],
        },
      ),
    );
    const { code, details } = refusal(result);
    expect(code).toBe('connector_spec_invalid');
    expect(details.join('\n')).toContain('./other.yaml#/X');
  });

  it('refuses a $ref naming nothing, naming it', () => {
    const result = normaliseOpenApi(
      input(
        doc({ '/pets': { get: { ...okResponse, parameters: [{ $ref: '#/components/x' }] } } }),
        {
          allow: ['GET /pets'],
        },
      ),
    );
    expect(refusal(result).details.join('\n')).toContain('#/components/x');
  });

  it('cuts a self-referencing schema and terminates', () => {
    const document = doc(
      {
        '/pets': {
          get: {
            ...okResponse,
            parameters: [{ name: 'q', in: 'query', schema: { $ref: '#/components/schemas/A' } }],
          },
        },
      },
      {
        components: {
          schemas: { A: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } } },
        },
      },
    );
    const result = normaliseOpenApi(input(document, { allow: ['GET /pets'] }));
    if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.parameters['get_pets']).toEqual([
      {
        name: 'q',
        in: 'query',
        required: false,
        schema: { type: 'object', properties: { a: {} } },
      },
    ]);
  });

  it('enforces the node budget on reference expansion', () => {
    // Each level references the previous one twice: 2^20 nodes once expanded.
    const schemas: Record<string, unknown> = { L0: { type: 'string' } };
    for (let level = 1; level <= 20; level += 1) {
      schemas[`L${String(level)}`] = {
        type: 'object',
        properties: {
          a: { $ref: `#/components/schemas/L${String(level - 1)}` },
          b: { $ref: `#/components/schemas/L${String(level - 1)}` },
        },
      };
    }
    const result = normaliseOpenApi(
      input(doc({ '/pets': { get: okResponse } }, { components: { schemas } }), {
        allow: ['GET /pets'],
      }),
    );
    expect(refusal(result)).toEqual({
      code: 'connector_spec_invalid',
      details: ['document: expands beyond 100000 nodes'],
    });
  });

  it('refuses nesting that reference expansion stacks too deep, as a typed refusal', () => {
    // Each schema nests 400 arrays around a reference to the next: the parser accepts every one,
    // but the expanded chain is about 12 000 levels deep, which overflowed the recursive walk.
    const nested = (ref: string): string =>
      `${'['.repeat(400)}{"$ref":"#/components/schemas/${ref}"}${']'.repeat(400)}`;
    const schemas = Array.from(
      { length: 31 },
      (_, level) => `"S${String(level)}":${nested(`S${String(level + 1)}`)}`,
    );
    const document = doc({ '/pets': { get: okResponse } }, { components: { schemas: 0 } }).replace(
      '"schemas":0',
      `"schemas":{${schemas.join(',')},"S31":{"type":"string"}}`,
    );
    expect(refusal(normaliseOpenApi(input(document, { allow: ['GET /pets'] })))).toEqual({
      code: 'connector_spec_invalid',
      details: ['document: nests deeper than 512 levels'],
    });
  });

  it('refuses 129 operations and accepts 128', () => {
    const paths = (count: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [`/r${String(i)}`, { get: okResponse }]),
      );
    expect(refusal(normaliseOpenApi(input(doc(paths(129)), { allow: ['GET /*'] }))).code).toBe(
      'connector_spec_invalid',
    );
    const accepted = normaliseOpenApi(input(doc(paths(128)), { allow: ['GET /*'] }));
    expect(accepted.ok && accepted.openapi.operations.length).toBe(128);
  });

  it('refuses Swagger 2.0 at document.openapi', () => {
    const result = normaliseOpenApi(input(JSON.stringify({ swagger: '2.0', paths: {} })));
    expect(refusal(result).details).toEqual([
      'document.openapi: must be an OpenAPI 3.0.x or 3.1.x version',
    ]);
  });

  it('admits /pets/{petId} with GET /pets/* and not /pets/{petId}/photos', () => {
    const result = normaliseOpenApi(
      input(fixture('petstore-3.0.yaml'), { allow: ['GET /pets/*'] }),
    );
    if (!result.ok) throw new Error(result.details.join('; '));
    expect(result.openapi.operations.map((o) => o.path)).toEqual(['/pets/{petId}']);
  });

  it('refuses POST /pets and operationId:addPet as writes', () => {
    for (const rule of ['POST /pets', 'operationId:addPet']) {
      const result = normaliseOpenApi(input(fixture('petstore-3.0.yaml'), { allow: [rule] }));
      expect(refusal(result).code).toBe('connector_write_unsupported');
    }
  });

  describe('the SD15 base URL', () => {
    const paths = { '/pets': { get: okResponse } };
    const allow = ['GET /pets'];

    it('refuses a relative server URL at servers', () => {
      const result = normaliseOpenApi(input(doc(paths, { servers: [{ url: '/v1' }] }), { allow }));
      expect(refusal(result).details[0]).toMatch(/^servers: /u);
    });

    it('refuses a variable without a default at servers', () => {
      const servers = [{ url: 'https://{host}/v1', variables: { host: { enum: ['a'] } } }];
      const result = normaliseOpenApi(input(doc(paths, { servers }), { allow }));
      expect(refusal(result).details[0]).toMatch(/^servers: /u);
    });

    it('refuses a document with no servers at servers', () => {
      const result = normaliseOpenApi(input(doc(paths, { servers: undefined }), { allow }));
      expect(refusal(result).details[0]).toMatch(/^servers: /u);
    });

    it('substitutes a default host', () => {
      const servers = [
        { url: 'https://{host}/v1', variables: { host: { default: '93.184.216.34' } } },
      ];
      const result = normaliseOpenApi(input(doc(paths, { servers }), { allow }));
      expect(result.ok && result.openapi.baseUrl).toBe('https://93.184.216.34/v1');
    });

    it('prefers the body baseUrl', () => {
      const result = normaliseOpenApi(
        input(doc(paths, { servers: [{ url: '/v1' }] }), { allow, baseUrl: 'https://example.com' }),
      );
      expect(result.ok && result.openapi.baseUrl).toBe('https://example.com');
    });
  });

  describe('C17 names', () => {
    it('falls back to the method and path for a 50-character operationId', () => {
      expect(
        operationName({ method: 'GET', path: '/pets/{petId}', operationId: 'x'.repeat(50) }),
      ).toBe('get_pets_petId');
    });

    it('sanitises illegal characters', () => {
      expect(operationName({ method: 'GET', path: '/a', operationId: 'pets.list all' })).toBe(
        'pets_list_all',
      );
    });

    it('refuses two operations that sanitise to one name', () => {
      const result = normaliseOpenApi(
        input(
          doc({
            '/a': { get: { ...okResponse, operationId: 'list.pets' } },
            '/b': { get: { ...okResponse, operationId: 'list pets' } },
          }),
          { allow: ['GET /a', 'GET /b'] },
        ),
      );
      const { code, details } = refusal(result);
      expect(code).toBe('connector_tool_name_collision');
      expect(details[0]).toContain('GET /a');
      expect(details[0]).toContain('GET /b');
    });
  });

  it('refuses a deepObject parameter by name', () => {
    const result = normaliseOpenApi(
      input(
        doc({
          '/pets': {
            get: {
              ...okResponse,
              parameters: [{ name: 'filter', in: 'query', style: 'deepObject' }],
            },
          },
        }),
        { allow: ['GET /pets'] },
      ),
    );
    expect(refusal(result).details[0]).toContain('"filter"');
  });

  it('refuses YAML with a duplicate key', () => {
    const result = normaliseOpenApi(input('openapi: 3.0.3\nopenapi: 3.0.3\npaths: {}\n'));
    expect(refusal(result).code).toBe('connector_spec_invalid');
  });

  it('refuses a real NUL in a parameter, but not the escape text', () => {
    const withDescription = (description: string) =>
      normaliseOpenApi(
        input(
          doc({
            '/pets': {
              get: {
                ...okResponse,
                parameters: [{ name: 'q', in: 'query', schema: { type: 'string', description } }],
              },
            },
          }),
          { allow: ['GET /pets'] },
        ),
      );
    expect(withDescription('a\\u0000b').ok).toBe(true);
    expect(refusal(withDescription('a\u0000b')).details[0]).toContain('U+0000');
  });
});
