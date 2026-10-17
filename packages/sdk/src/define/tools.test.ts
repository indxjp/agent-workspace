import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { CreateToolConnectorRequestSchema } from '@indx-workspace/contracts/tool-connectors';

import {
  DefinitionError,
  defineAgent,
  isDefinedAgent,
  isOpenApiTool,
  isPostgresTool,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  toAgentVersionBody,
  toolDefinitionsOf,
  type OpenApiToolInput,
  type PostgresToolInput,
} from './index.js';

const ORDERS: OpenApiToolInput = {
  name: 'orders',
  spec: './openapi/orders.json',
  allow: ['GET /orders/*'],
  auth: secret('ORDERS_TOKEN'),
};

const WAREHOUSE: PostgresToolInput = {
  name: 'warehouse',
  url: secret('DB_URL'),
  readOnly: true,
  tables: ['public.orders'],
};

function issuesOf(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues;
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

function pathsOf(run: () => unknown): readonly string[] {
  return issuesOf(run).map((issue) => issue.path);
}

/** Calls `make` with a value its type refuses, as a plain JavaScript project could. */
function callUntyped<T>(make: (input: T) => unknown, input: unknown): () => void {
  return () => {
    Reflect.apply(make, undefined, [input]);
  };
}

/** An object carrying the define brand of `kind` without having been made by its function. */
function forge(kind: string, fields: Record<string, unknown>): unknown {
  return Object.defineProperty({ ...fields }, Symbol.for('agentworkspace.dev/define'), {
    value: kind,
  });
}

describe('secret', () => {
  it('makes a frozen, branded reference that serialises as { secret }', () => {
    const reference = secret('ORDERS_TOKEN');

    expect(reference).toStrictEqual({ secret: 'ORDERS_TOKEN' });
    expect(Object.isFrozen(reference)).toBe(true);
    expect(JSON.stringify(reference)).toBe('{"secret":"ORDERS_TOKEN"}');
  });

  it.each(['lower', 'PORT', 'path', 'AW_TOKEN', '', 'A'.repeat(129)])(
    'refuses %j at (root)',
    (name) => {
      expect(pathsOf(() => secret(name))).toStrictEqual(['(root)']);
    },
  );

  it('refuses a reserved name as reserved, naming the call', () => {
    expect(() => secret('PORT')).toThrow(
      /^secret\(\) is not a valid definition: \(root\): PORT is a variable the local runtime uses/u,
    );
  });
});

describe('openapiTool', () => {
  it('returns the input as written, frozen and branded', () => {
    const tool = openapiTool(ORDERS);

    expect(tool).toStrictEqual(ORDERS);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(isOpenApiTool(tool)).toBe(true);
    expect(isPostgresTool(tool)).toBe(false);
    expect(Object.keys(tool)).toStrictEqual(['name', 'spec', 'allow', 'auth']);
  });

  it.each([
    'openapi.json',
    './openapi.json',
    'openapi/orders.yaml',
    './.config/orders.json',
    'console.json',
    'https://api.example.test/openapi.json',
    'https://api.example.test/openapi.json?version=2',
  ])('accepts the spec %j', (spec) => {
    expect(openapiTool({ ...ORDERS, spec }).spec).toBe(spec);
  });

  it.each([
    '../outside.json',
    './../outside.json',
    'a/./b.json',
    'a//b.json',
    '.',
    './',
    '/abs',
    '/etc/x',
    'C:/x',
    'a\\b.json',
    'http://x',
    'HTTPS://x',
    'https://user:pass@example.test/openapi.json',
    'https://example.test/open api.json',
    'https://example.test\\openapi.json',
    'https://',
    'https:example.test/openapi.json',
    'https:/example.test/openapi.json',
    'https:///openapi.json',
    'https://example.test/openapi.json?token=abc',
    'https://example.test/openapi.json?API_KEY=abc',
    'https://example.test/openapi.json#paths',
    `https://example.test/${'a'.repeat(2048)}`,
    '.. /outside.json',
    'a/.. ',
    '... /outside.json',
    ' ',
    ' a.json',
    'openapi.',
    'CON',
    'aux/orders.json',
    'nul.json',
    'com1',
    'a‮.json',
    `${'a'.repeat(1025)}`,
    '',
  ])('refuses the spec %j at spec', (spec) => {
    expect(pathsOf(() => openapiTool({ ...ORDERS, spec }))).toStrictEqual(['spec']);
  });

  it('refuses a credential in a spec URL without echoing it', () => {
    const issues = issuesOf(() =>
      openapiTool({ ...ORDERS, spec: 'https://example.test/openapi.json?api_key=SECRET1' }),
    );

    expect(issues).toStrictEqual([
      {
        path: 'spec',
        message:
          'must not carry a credential (a user name, password or token parameter); keep it in a secret',
      },
    ]);
  });

  it('refuses a write rule at its index', () => {
    expect(pathsOf(() => openapiTool({ ...ORDERS, allow: ['POST /x'] }))).toStrictEqual([
      'allow.0',
    ]);
  });

  it('refuses an unknown key at (root)', () => {
    expect(pathsOf(callUntyped(openapiTool, { ...ORDERS, document: '{}' }))).toStrictEqual([
      '(root)',
    ]);
  });

  it('refuses a string where the auth reference belongs, without echoing it', () => {
    const pasted = 'sk-live-0123456789abcdefSECRETVALUE';
    const issues = issuesOf(callUntyped(openapiTool, { ...ORDERS, auth: pasted }));

    expect(issues.map((issue) => issue.path)).toStrictEqual(['auth']);
    expect(JSON.stringify(issues)).not.toContain(pasted);
  });

  it.each([
    [{ secret: 'PORT' }, 'auth.secret', /^PORT is a variable the local runtime uses/u],
    [{ secret: 'lower' }, 'auth.secret', /^must be a secret name/u],
    [
      { header: 'X-Api-Key', credential: { secret: 'PORT' } },
      'auth.credential.secret',
      /^PORT is a variable the local runtime uses/u,
    ],
    [
      { header: 'X-Api-Key', credential: 'sk-live-0123456789abcdefSECRETVALUE' },
      'auth.credential',
      /^must be a secret reference/u,
    ],
    [{ header: 'X-Api-Key' }, 'auth.credential', /^must be a secret reference/u],
    [{ secret: 'ORDERS_TOKEN', scheme: 'Basic' }, 'auth', /./u],
  ])('refuses the auth %j at %s, with its own message', (auth, path, message) => {
    const issues = issuesOf(callUntyped(openapiTool, { ...ORDERS, auth }));

    expect(issues.map((issue) => issue.path)).toStrictEqual([path]);
    expect(issues[0]?.message).toMatch(message);
    expect(JSON.stringify(issues)).not.toContain('SECRETVALUE');
  });

  it('accepts a plain { secret } reference and a header credential', () => {
    const auth = { header: 'X-Api-Key', credential: { secret: 'ORDERS_KEY' } };

    expect(openapiTool({ ...ORDERS, auth }).auth).toStrictEqual(auth);
    expect(openapiTool({ ...ORDERS, auth: { secret: 'ORDERS_TOKEN' } }).auth).toStrictEqual({
      secret: 'ORDERS_TOKEN',
    });
  });

  it('refuses a header that cannot carry a credential, and a bad base URL', () => {
    const auth = { header: 'Host', credential: secret('ORDERS_KEY') };

    expect(pathsOf(() => openapiTool({ ...ORDERS, auth }))).toStrictEqual(['auth.header']);
    expect(pathsOf(() => openapiTool({ ...ORDERS, baseUrl: 'ftp://x' }))).toStrictEqual([
      'baseUrl',
    ]);
  });
});

describe('postgresTool', () => {
  it('returns the input as written, frozen and branded, with no default maxRows', () => {
    const tool = postgresTool(WAREHOUSE);

    expect(tool).toStrictEqual(WAREHOUSE);
    expect(tool.maxRows).toBeUndefined();
    expect(Object.isFrozen(tool)).toBe(true);
    expect(isPostgresTool(tool)).toBe(true);
    expect(isOpenApiTool(tool)).toBe(false);
  });

  it('refuses readOnly: false at readOnly', () => {
    const issues = issuesOf(callUntyped(postgresTool, { ...WAREHOUSE, readOnly: false }));

    expect(issues).toStrictEqual([
      { path: 'readOnly', message: 'only reads are supported; set true' },
    ]);
  });

  it('refuses a connection URL written as a string at url, without echoing it', () => {
    const url = 'postgres://user:hunter2@db.example.test/app';
    const issues = issuesOf(callUntyped(postgresTool, { ...WAREHOUSE, url }));

    expect(issues.map((issue) => issue.path)).toStrictEqual(['url']);
    expect(JSON.stringify(issues)).not.toContain('hunter2');
  });

  it('refuses a reserved secret name at url.secret', () => {
    expect(pathsOf(() => postgresTool({ ...WAREHOUSE, url: { secret: 'PORT' } }))).toStrictEqual([
      'url.secret',
    ]);
  });

  it('refuses bad tables, maxRows and an unknown key at their paths', () => {
    expect(pathsOf(() => postgresTool({ ...WAREHOUSE, tables: ['pg_catalog.x'] }))).toStrictEqual([
      'tables.0',
    ]);
    expect(pathsOf(() => postgresTool({ ...WAREHOUSE, maxRows: 1001 }))).toStrictEqual(['maxRows']);
    expect(pathsOf(callUntyped(postgresTool, { ...WAREHOUSE, credential: 'x' }))).toStrictEqual([
      '(root)',
    ]);
  });
});

describe('an agent with three kinds of tool', () => {
  const agent = defineAgent({
    name: 'assistant',
    instructions: 'Answer briefly.',
    tools: [mcp('github'), openapiTool(ORDERS), postgresTool({ ...WAREHOUSE, maxRows: 50 })],
  });

  it('names every tool in resources.connectors, in order, and parses as a version body', () => {
    const body = toAgentVersionBody(agent);

    expect(AgentVersionBodySchema.parse(body)).toStrictEqual(body);
    expect(body.definition.resources.connectors).toStrictEqual(['github', 'orders', 'warehouse']);
  });

  it('gives the catalog tools as create bodies with secret references and no value', () => {
    const definitions = toolDefinitionsOf(agent);

    expect(definitions).toStrictEqual([
      {
        kind: 'openapi',
        name: 'orders',
        spec: './openapi/orders.json',
        allow: ['GET /orders/*'],
        auth: 'bearer',
        credential: { secret: 'ORDERS_TOKEN' },
      },
      {
        kind: 'postgres',
        name: 'warehouse',
        credential: { secret: 'DB_URL' },
        tables: ['public.orders'],
        readOnly: true,
        maxRows: 50,
      },
    ]);
    expect(definitions[0]?.credential).toStrictEqual({ secret: 'ORDERS_TOKEN' });
    expect(definitions[1]?.credential).toStrictEqual({ secret: 'DB_URL' });
    expect(Object.isFrozen(definitions)).toBe(true);
    for (const definition of definitions) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.credential)).toBe(true);
      expect(definition).not.toHaveProperty('document');
      // A fresh plain object: no define brand rides along.
      expect(Object.getOwnPropertySymbols(definition.credential)).toStrictEqual([]);
      expect(Object.getOwnPropertySymbols(definition)).toStrictEqual([]);
    }
    expect(structuredClone(definitions)).toStrictEqual(definitions);
  });

  it('gives bodies the contract accepts once the spec and values are resolved', () => {
    for (const definition of toolDefinitionsOf(agent)) {
      const resolved =
        definition.kind === 'openapi'
          ? {
              kind: definition.kind,
              name: definition.name,
              allow: definition.allow,
              auth: definition.auth,
              document: '{"openapi":"3.1.0"}',
              credential: 'resolved-token',
            }
          : {
              kind: definition.kind,
              name: definition.name,
              tables: definition.tables,
              readOnly: definition.readOnly,
              maxRows: definition.maxRows,
              credential: 'postgres://db.example.test/app',
            };
      expect(CreateToolConnectorRequestSchema.safeParse(resolved).success).toBe(true);
    }
  });

  it('maps auth none, bearer and header, and keeps baseUrl only when given', () => {
    const headerAgent = defineAgent({
      name: 'assistant',
      instructions: 'x',
      tools: [
        openapiTool({ name: 'open', spec: 'a.json', allow: ['GET /x'] }),
        openapiTool({
          name: 'keyed',
          spec: 'b.json',
          allow: ['HEAD /x'],
          baseUrl: 'https://api.example.test',
          auth: { header: 'X-Api-Key', credential: secret('API_KEY') },
        }),
      ],
    });

    expect(toolDefinitionsOf(headerAgent)).toStrictEqual([
      { kind: 'openapi', name: 'open', spec: 'a.json', allow: ['GET /x'], auth: 'none' },
      {
        kind: 'openapi',
        name: 'keyed',
        spec: 'b.json',
        allow: ['HEAD /x'],
        auth: { header: 'X-Api-Key' },
        credential: { secret: 'API_KEY' },
        baseUrl: 'https://api.example.test',
      },
    ]);
  });

  it('gives no definitions for an agent with only MCP tools or none', () => {
    expect(toolDefinitionsOf(defineAgent({ name: 'a', instructions: 'x' }))).toStrictEqual([]);
    expect(
      toolDefinitionsOf(defineAgent({ name: 'a', instructions: 'x', tools: [mcp('github')] })),
    ).toStrictEqual([]);
  });

  it('refuses one tool name used by two kinds of tool, at the repeat', () => {
    const issues = issuesOf(() =>
      defineAgent({
        name: 'assistant',
        instructions: 'x',
        tools: [mcp('orders'), postgresTool(WAREHOUSE), openapiTool(ORDERS)],
      }),
    );

    expect(issues).toStrictEqual([{ path: 'tools.2', message: 'repeats the tool name "orders"' }]);
  });

  it('refuses a tool not made by mcp(), openapiTool(), postgresTool() or defineTool()', () => {
    const issues = issuesOf(
      callUntyped(defineAgent, { name: 'a', instructions: 'x', tools: [{ ...ORDERS }] }),
    );

    expect(issues).toStrictEqual([
      {
        path: 'tools.0',
        message: 'must be made by mcp(), openapiTool(), postgresTool() or defineTool()',
      },
    ]);
  });

  it('checks a forged catalog tool again rather than trusting its brand', () => {
    const tools = [
      forge('openapi', { ...ORDERS, spec: '../outside.json' }),
      forge('postgres', { ...WAREHOUSE, readOnly: false }),
    ];

    expect(
      pathsOf(callUntyped(defineAgent, { name: 'a', instructions: 'x', tools })),
    ).toStrictEqual(['tools.0.spec', 'tools.1.readOnly']);
  });
});

/**
 * A forged tool whose `key` is a getter: `first` for the first `times` reads, then `then`. Only a
 * value read once, then checked and used, is safe against it.
 */
function forgeWithGetter(
  kind: string,
  fields: Record<string, unknown>,
  key: string,
  values: { first: unknown; times: number; then: unknown },
): unknown {
  let reads = 0;
  return Object.defineProperty(forge(kind, fields), key, {
    enumerable: true,
    get: () => {
      reads += 1;
      return reads <= values.times ? values.first : values.then;
    },
  });
}

describe('a forged tool with a getter', () => {
  it('cannot hand toolDefinitionsOf a spec other than the one checked', () => {
    const tool = forgeWithGetter('openapi', { name: 'sneaky', allow: ['GET /x'] }, 'spec', {
      first: 'ok.json',
      times: 1,
      then: '../../etc/passwd',
    });
    const agent: unknown = Reflect.apply(defineAgent, undefined, [
      { name: 'a', instructions: 'x', tools: [tool] },
    ]);
    if (!isDefinedAgent(agent)) throw new Error('expected a defined agent');

    expect(toolDefinitionsOf(agent)).toStrictEqual([
      { kind: 'openapi', name: 'sneaky', spec: 'ok.json', allow: ['GET /x'], auth: 'none' },
    ]);
  });

  it('cannot slip a repeated tool name past the check into resources.connectors', () => {
    const tool = forgeWithGetter('openapi', { spec: 'a.json', allow: ['GET /x'] }, 'name', {
      first: 'other',
      times: 2,
      then: 'orders',
    });
    const make = (): unknown => {
      const agent: unknown = Reflect.apply(defineAgent, undefined, [
        { name: 'a', instructions: 'x', tools: [openapiTool(ORDERS), tool] },
      ]);
      if (!isDefinedAgent(agent)) throw new Error('expected a defined agent');
      return toAgentVersionBody(agent).definition.resources.connectors;
    };

    expect(make()).toStrictEqual(['orders', 'other']);
  });
});

describe('toolDefinitionsOf refusals', () => {
  it('refuses an agent not made by defineAgent', () => {
    const copy = Object.freeze({ ...defineAgent({ name: 'a', instructions: 'x' }) });

    expect(() => toolDefinitionsOf(copy)).toThrow(
      /^toolDefinitionsOf\(\) is not a valid definition: agent: must be made by defineAgent\(\)$/u,
    );
  });

  it('checks a forged agent again, at agent.<path>', () => {
    const forged = forge('agent', {
      name: 'a',
      instructions: 'x',
      tools: [forge('openapi', { ...ORDERS, spec: '/etc/passwd' })],
    });
    if (!isDefinedAgent(forged)) throw new Error('expected the forged brand to be recognised');

    expect(pathsOf(() => toolDefinitionsOf(forged))).toStrictEqual(['agent.tools.0.spec']);
  });
});
