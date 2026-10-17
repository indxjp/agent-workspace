import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { parseAgentToolRule } from './agents/tool-rules.js';
import {
  CONNECTOR_SERVER_KEY_MAX_LENGTH,
  CreateOpenApiConnectorRequestSchema,
  CreatePostgresConnectorRequestSchema,
  CreateToolConnectorRequestSchema,
  GATEWAY_TOOL_ROUTE,
  GATEWAY_TOOL_SANDBOX_ROUTE,
  OPENAPI_ALLOW_MAX_RULES,
  OPENAPI_AUTH_HEADER_REFUSED_NAMES,
  OPENAPI_DOCUMENT_MAX_BYTES,
  OPENAPI_OPERATIONS_MAX,
  OpenApiAllowRuleSchema,
  OpenApiAllowSchema,
  OpenApiAuthSchema,
  OpenApiSpecSummarySchema,
  OpenApiToolConfigSchema,
  POSTGRES_DEFAULT_MAX_ROWS,
  POSTGRES_MAX_ROWS_LIMIT,
  POSTGRES_TABLES_MAX,
  POSTGRES_TOOL_OPERATION_NAMES,
  PostgresMaxRowsSchema,
  PostgresTableNameSchema,
  PostgresTablesSchema,
  PostgresToolConfigSchema,
  RESERVED_MCP_SERVER_KEYS,
  TOOL_CONNECTOR_KINDS,
  TOOL_CONNECTOR_PROBLEM_CODES,
  TOOL_GATEWAY_PROBLEM_CODES,
  TOOL_NAME_MAX_LENGTH,
  TOOL_OPERATION_METHODS,
  TOOL_OPERATION_NAME_MAX_LENGTH,
  TOOL_OPERATION_NAME_PATTERN,
  TOOL_SANDBOX_CONNECTOR_URL,
  TOOL_SERVER_KEY_MAX_LENGTH,
  ToolOperationNameSchema,
  ToolOperationSchema,
  connectorServerKey,
  describeToolRule,
  gatewayToolPath,
  parseGatewayToolPath,
  problemCodeOfIssue,
  selectAllowedOperations,
  toolRuleConnectorServer,
  toolServerKey,
  toolServerKeys,
} from './tool-connectors.js';

const CONNECTOR_ID = '77777777-7777-4777-8777-777777777777';
const SECRET_TOKEN = 'tok-SECRET-do-not-echo';
const SECRET_URL = 'postgres://reader:pw-SECRET-do-not-echo@db.internal:5432/shop';
const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';

const openapiBody = {
  kind: 'openapi',
  name: 'Orders API',
  document: DOCUMENT,
  baseUrl: 'https://api.example.test/v1',
  allow: ['GET /orders/*', 'operationId:getOrderByOrderNumber'],
  auth: 'bearer',
  credential: SECRET_TOKEN,
};

const postgresBody = {
  kind: 'postgres',
  name: 'Shop DB',
  credential: SECRET_URL,
  tables: ['public.orders', 'public.customers'],
  readOnly: true,
};

/** The issues of a refused parse, or a failed expectation when it was accepted. */
function issuesOf(result: z.ZodSafeParseResult<unknown>): readonly z.core.$ZodIssue[] {
  expect(result.success).toBe(false);
  return result.error?.issues ?? [];
}

/** The paths of the issues of a refused parse. */
function refusedPaths(result: z.ZodSafeParseResult<unknown>): readonly string[] {
  return issuesOf(result).map((issue) => issue.path.map(String).join('/'));
}

describe('vocabulary and bounds', () => {
  it('publishes the kinds, caps and operation names of C15 and C17', () => {
    expect(TOOL_CONNECTOR_KINDS).toEqual(['openapi', 'postgres']);
    expect(OPENAPI_DOCUMENT_MAX_BYTES).toBe(1_048_576);
    expect(OPENAPI_ALLOW_MAX_RULES).toBe(256);
    expect(OPENAPI_OPERATIONS_MAX).toBe(128);
    expect(POSTGRES_TABLES_MAX).toBe(64);
    expect(POSTGRES_MAX_ROWS_LIMIT).toBe(1000);
    expect(POSTGRES_DEFAULT_MAX_ROWS).toBe(100);
    expect(POSTGRES_TOOL_OPERATION_NAMES).toEqual(['list_tables', 'describe', 'select']);
    expect(TOOL_OPERATION_METHODS).toEqual(['GET', 'HEAD']);
  });

  it('derives the 41-character operation cap from the 64-character tool name (SD13)', () => {
    expect(TOOL_NAME_MAX_LENGTH).toBe(64);
    expect(TOOL_SERVER_KEY_MAX_LENGTH).toBe(16);
    expect(TOOL_OPERATION_NAME_MAX_LENGTH).toBe(
      TOOL_NAME_MAX_LENGTH - 'mcp__'.length - TOOL_SERVER_KEY_MAX_LENGTH - '__'.length,
    );
    expect(TOOL_OPERATION_NAME_MAX_LENGTH).toBe(64 - 5 - 16 - 2);
    expect(TOOL_OPERATION_NAME_PATTERN.test('a'.repeat(41))).toBe(true);
    expect(TOOL_OPERATION_NAME_PATTERN.test('a'.repeat(42))).toBe(false);
  });

  it('publishes the problem codes and their statuses', () => {
    expect(TOOL_CONNECTOR_PROBLEM_CODES).toEqual({
      connector_spec_invalid: 422,
      connector_write_unsupported: 422,
      connector_tool_name_collision: 422,
      connector_kind_unsupported: 400,
    });
    expect(TOOL_GATEWAY_PROBLEM_CODES).toEqual({
      tool_run_not_active: 401,
      tool_not_in_run: 403,
      tool_upstream_failed: 502,
      tool_upstream_timeout: 504,
    });
  });
});

describe('the gateway tool route (C16)', () => {
  it('builds and parses the path of one connector', () => {
    expect(GATEWAY_TOOL_ROUTE).toEqual({ method: 'POST', path: '/v1/tools/:connectorId/mcp' });
    const path = gatewayToolPath(CONNECTOR_ID);
    expect(path).toBe(`/v1/tools/${CONNECTOR_ID}/mcp`);
    expect(parseGatewayToolPath(path)).toBe(CONNECTOR_ID);
  });

  it('refuses a connector id that is not a UUID and a path that is not the route', () => {
    expect(() => gatewayToolPath('not-a-uuid')).toThrow(RangeError);
    expect(() => gatewayToolPath(`${CONNECTOR_ID}/../x`)).toThrow(RangeError);
    expect(parseGatewayToolPath('/v1/tools/not-a-uuid/mcp')).toBeNull();
    expect(parseGatewayToolPath(`/v1/tools/${CONNECTOR_ID}/mcp/`)).toBeNull();
    expect(parseGatewayToolPath(`/v1/tools/${CONNECTOR_ID}/x/mcp`)).toBeNull();
    expect(parseGatewayToolPath(`/v1/models/${CONNECTOR_ID}/mcp`)).toBeNull();
  });
});

describe('the gateway tool sandbox route (ADR-0118 TS3)', () => {
  it('is its own route, not a connector path', () => {
    expect(GATEWAY_TOOL_SANDBOX_ROUTE).toEqual({ method: 'POST', path: '/v1/tool-sandbox/mcp' });
    expect(parseGatewayToolPath(GATEWAY_TOOL_SANDBOX_ROUTE.path)).toBeNull();
  });

  it('registers aw-dev-tools at a reserved, undialable URL', () => {
    expect(new URL(TOOL_SANDBOX_CONNECTOR_URL).hostname.endsWith('.invalid')).toBe(true);
  });
});

describe('toolServerKey (SD13)', () => {
  it('lower-cases ASCII, replaces everything else with "_" and cuts to 16', () => {
    expect(toolServerKey('Orders API')).toBe('orders_api');
    expect(toolServerKey('Shop-DB.v2')).toBe('shop_db_v2');
    expect(toolServerKey('x'.repeat(200))).toBe('x'.repeat(16));
  });

  it('gives at most 16 characters for a 200-character name, so the longest tool name is 64', () => {
    const key = toolServerKey(`Very Long Connector ${'n'.repeat(180)}`);
    expect(key.length).toBeLessThanOrEqual(16);
    const longest = toolServerKey('L'.repeat(200));
    expect(longest).toHaveLength(16);
    expect(`mcp__${longest}__${'a'.repeat(41)}`).toHaveLength(64);
  });

  it('prefixes t_ before a digit and t before an underscore', () => {
    expect(toolServerKey('42 things')).toBe('t_42_things');
    expect(toolServerKey('_private')).toBe('t_private');
    expect(toolServerKey('')).toBe('t');
    expect(toolServerKey('9'.repeat(40))).toBe(`t_${'9'.repeat(14)}`);
  });

  it('reads non-ASCII by code point and never lower-cases it into ASCII', () => {
    expect(toolServerKey('注文API')).toBe('t_api');
    expect(toolServerKey('😀orders')).toBe('t_orders');
    expect(toolServerKey('İndex')).toBe('t_ndex');
    expect(toolServerKey('café')).toBe('caf');
  });

  it('never yields "__", a leading "_" or a trailing "_", so mcp__<key>__<op> splits once', () => {
    expect(toolServerKey('a  --  b')).toBe('a_b');
    expect(toolServerKey(`${'x'.repeat(15)} y`)).toBe('x'.repeat(15));
    expect(toolServerKey('a_', 2)).toBe('a_2');
    const alphabet = ['a', 'Z', '9', '_', '-', ' ', '.', 'é', '注', '😀'];
    let seed = 7;
    for (let sample = 0; sample < 200; sample += 1) {
      let name = '';
      const length = sample % 24;
      for (let index = 0; index < length; index += 1) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        name += alphabet[seed % alphabet.length] ?? '';
      }
      for (const ordinal of [1, 2, 12]) {
        const key = toolServerKey(name, ordinal);
        expect(key, JSON.stringify(name)).toMatch(/^[a-z](?:_?[a-z0-9])*$/u);
        expect(key.length).toBeLessThanOrEqual(16);
      }
    }
  });

  it('appends an ordinal within the same 16 characters', () => {
    expect(toolServerKey('orders', 1)).toBe('orders');
    expect(toolServerKey('orders', 2)).toBe('orders_2');
    expect(toolServerKey('x'.repeat(30), 2)).toBe(`${'x'.repeat(14)}_2`);
    expect(toolServerKey('x'.repeat(30), 12)).toBe(`${'x'.repeat(13)}_12`);
    expect(toolServerKey('x'.repeat(30), 12)).toHaveLength(16);
  });

  it('refuses an ordinal that is not a safe integer of at least 1, or leaves no room', () => {
    for (const ordinal of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => toolServerKey('orders', ordinal), String(ordinal)).toThrow(RangeError);
    }
    expect(() => toolServerKey('orders', 10 ** 15)).toThrow(RangeError);
    expect(toolServerKey('orders', 10 ** 14 - 1)).toBe(`o_${String(10 ** 14 - 1)}`);
  });
});

describe('connectorServerKey (SD13, #1109)', () => {
  const fallback = `connector-${CONNECTOR_ID}`;
  const none: ReadonlySet<string> = new Set();

  it('keys an MCP connector by its slug name', () => {
    expect(connectorServerKey('file-finder', CONNECTOR_ID, none)).toBe('file-finder');
    expect(connectorServerKey('defect-db', CONNECTOR_ID, none)).toBe('defect-db');
    expect(connectorServerKey('a', CONNECTOR_ID, none)).toBe('a');
    const longest = 'a'.repeat(CONNECTOR_SERVER_KEY_MAX_LENGTH);
    expect(connectorServerKey(longest, CONNECTOR_ID, none)).toBe(longest);
  });

  it('falls back to connector-<id> when the name is not a usable slug', () => {
    const unusable = [
      'Assigned Connector',
      'File-Finder',
      'file_finder',
      'ファイル検索',
      '-leading',
      'trailing-',
      '',
      'a'.repeat(CONNECTOR_SERVER_KEY_MAX_LENGTH + 1),
      'connector-other',
      'agent-workspace',
    ];
    for (const name of unusable) {
      expect(connectorServerKey(name, CONNECTOR_ID, none), name).toBe(fallback);
    }
  });

  it('falls back when a tool connector of the run already holds the key', () => {
    expect(connectorServerKey('orders', CONNECTOR_ID, new Set(['orders']))).toBe(fallback);
    expect(connectorServerKey('orders', CONNECTOR_ID, new Set(['customers']))).toBe('orders');
  });

  it('never returns a key the MCP rule grammar refuses or that takes a reserved key', () => {
    const names = ['file-finder', 'Orders', 'x'.repeat(60), 'agent-workspace', 'a--b', '9-lives'];
    for (const name of names) {
      const key = connectorServerKey(name, CONNECTOR_ID, none);
      expect(parseAgentToolRule(`mcp__${key}__tool`).kind, key).toBe('bare');
      expect(RESERVED_MCP_SERVER_KEYS).not.toContain(key);
      expect(key.length).toBeLessThanOrEqual(`connector-${CONNECTOR_ID}`.length);
    }
  });
});

describe('describeToolRule (SD13, #1121)', () => {
  const server = `connector-${CONNECTOR_ID}`;
  const names = { [server]: 'file-finder' };
  const NOT_STORED_BY_ID = [
    'mcp__file-finder__delete',
    'mcp__connector-xyz__a',
    'Bash',
    `Bash(mcp__${server}__x)`,
  ];

  it('labels a rule stored by connector id with the connector name', () => {
    expect(describeToolRule(`mcp__${server}__delete`, names)).toBe(
      `mcp__${server}__delete (file-finder)`,
    );
    expect(describeToolRule(`mcp__${server}__*`, names)).toBe(`mcp__${server}__* (file-finder)`);
  });

  it('returns a rule unchanged when no name is known or it is not stored by connector id', () => {
    const other = `mcp__connector-${CONNECTOR_ID.replace('7', '6')}__delete`;
    expect(describeToolRule(other, names)).toBe(other);
    expect(describeToolRule(`mcp__${server}__delete`, {})).toBe(`mcp__${server}__delete`);
    for (const rule of NOT_STORED_BY_ID) expect(describeToolRule(rule, names), rule).toBe(rule);
  });

  it('names the server segment of a stored rule and of no other rule', () => {
    expect(toolRuleConnectorServer(`mcp__${server}__delete`)).toBe(server);
    for (const rule of NOT_STORED_BY_ID) expect(toolRuleConnectorServer(rule), rule).toBeNull();
  });
});

describe('operation names and operations (C17)', () => {
  it('accepts a 41-character name and refuses a 42-character or malformed one', () => {
    expect(ToolOperationNameSchema.safeParse('a'.repeat(41)).success).toBe(true);
    expect(ToolOperationNameSchema.safeParse('getOrderByOrderNumber').success).toBe(true);
    expect(ToolOperationNameSchema.safeParse('list-orders_2').success).toBe(true);
    for (const name of ['a'.repeat(42), '', 'get order', 'get.order', 'gét', 'a/b']) {
      expect(ToolOperationNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it('holds an operation to GET or HEAD and a clean path template', () => {
    const operation = { name: 'getOrder', method: 'GET', path: '/orders/{orderId}' };
    expect(ToolOperationSchema.safeParse(operation).success).toBe(true);
    expect(ToolOperationSchema.safeParse({ ...operation, method: 'HEAD' }).success).toBe(true);
    for (const bad of [
      { ...operation, method: 'POST' },
      { ...operation, method: 'get' },
      { ...operation, path: 'orders' },
      { ...operation, path: '/orders/ {id}' },
      { ...operation, path: '/orders\n' },
      { ...operation, path: `/${'a'.repeat(2048)}` },
      { ...operation, name: 'a'.repeat(42) },
      { ...operation, extra: true },
    ]) {
      expect(ToolOperationSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('OpenApiAllowRuleSchema and OpenApiAllowSchema (SD4, SD14)', () => {
  it('accepts GET and HEAD globs and operationId rules', () => {
    for (const rule of [
      'GET /orders/*',
      'HEAD /orders',
      'GET /orders/**',
      'GET /',
      'GET /orders/{orderId}',
      'operationId:getOrderByOrderNumber',
      `operationId:${'x'.repeat(256)}`,
    ]) {
      expect(OpenApiAllowRuleSchema.safeParse(rule).success, rule).toBe(true);
    }
  });

  it('refuses POST /refunds as connector_write_unsupported', () => {
    const issues = issuesOf(OpenApiAllowSchema.safeParse(['POST /refunds']));
    expect(issues.map(problemCodeOfIssue)).toEqual(['connector_write_unsupported']);
    expect(issues[0]?.path).toEqual([0]);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const [issue] = issuesOf(OpenApiAllowRuleSchema.safeParse(`${method} /refunds`));
      expect(issue === undefined ? null : problemCodeOfIssue(issue)).toBe(
        'connector_write_unsupported',
      );
    }
  });

  it('refuses a malformed rule without a problem code', () => {
    for (const rule of [
      'get /orders',
      'GET orders',
      'GET /orders/**/items',
      'GET /orders//items',
      'GET /orders/',
      'GET /orders?x=1',
      'GET /orders#x',
      'GET /orders/a*',
      'GET /ord ers',
      'GET  /orders',
      'FETCH /orders',
      'operationId:',
      'operationId:has space',
      `operationId:${'x'.repeat(257)}`,
      '',
      `GET /${'a'.repeat(2048)}`,
    ]) {
      const issues = issuesOf(OpenApiAllowRuleSchema.safeParse(rule));
      expect(issues.map(problemCodeOfIssue), rule).toEqual([null]);
    }
  });

  it('refuses an empty list, too many rules and an exact duplicate', () => {
    expect(refusedPaths(OpenApiAllowSchema.safeParse([]))).toEqual(['']);
    const many = Array.from({ length: 257 }, (_, index) => `GET /r${String(index)}`);
    expect(OpenApiAllowSchema.safeParse(many.slice(0, 256)).success).toBe(true);
    expect(OpenApiAllowSchema.safeParse(many).success).toBe(false);
    expect(refusedPaths(OpenApiAllowSchema.safeParse(['GET /a', 'GET /b', 'GET /a']))).toEqual([
      '2',
    ]);
  });
});

describe('OpenApiAuthSchema', () => {
  it('accepts none, bearer and a named header', () => {
    for (const auth of ['none', 'bearer', { header: 'X-Api-Key' }, { header: 'api_key.v2' }]) {
      expect(OpenApiAuthSchema.safeParse(auth).success, JSON.stringify(auth)).toBe(true);
    }
  });

  it('refuses every framing header in any case, and a header that is not a token', () => {
    for (const name of OPENAPI_AUTH_HEADER_REFUSED_NAMES) {
      expect(OpenApiAuthSchema.safeParse({ header: name }).success, name).toBe(false);
      expect(OpenApiAuthSchema.safeParse({ header: name.toUpperCase() }).success, name).toBe(false);
    }
    expect(OPENAPI_AUTH_HEADER_REFUSED_NAMES).toHaveLength(10);
    expect(Object.isFrozen(OPENAPI_AUTH_HEADER_REFUSED_NAMES)).toBe(true);
    for (const header of ['', 'X Api', 'X:Api', 'X-Api\r\n', 'é', 'x'.repeat(129)]) {
      expect(OpenApiAuthSchema.safeParse({ header }).success, header).toBe(false);
    }
    expect(OpenApiAuthSchema.safeParse({ header: 'x'.repeat(128) }).success).toBe(true);
    expect(OpenApiAuthSchema.safeParse('basic').success).toBe(false);
    expect(OpenApiAuthSchema.safeParse({ header: 'X-Key', value: 'x' }).success).toBe(false);
  });
});

describe('CreateOpenApiConnectorRequestSchema (C15)', () => {
  it('accepts a full body and defaults auth to none', () => {
    expect(CreateOpenApiConnectorRequestSchema.safeParse(openapiBody).success).toBe(true);
    const minimal = CreateOpenApiConnectorRequestSchema.parse({
      kind: 'openapi',
      name: 'Public',
      document: DOCUMENT,
      allow: ['GET /**'],
      dryRun: true,
    });
    expect(minimal.auth).toBe('none');
    expect(minimal.baseUrl).toBeUndefined();
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({
        ...openapiBody,
        auth: { header: 'X-Api-Key' },
      }).success,
    ).toBe(true);
  });

  it('refuses an empty allow at allow', () => {
    expect(
      refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, allow: [] })),
    ).toEqual(['allow']);
  });

  it('refuses a write rule at its index with connector_write_unsupported', () => {
    const issues = issuesOf(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, allow: ['POST /refunds'] }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([['allow', 0]]);
    expect(issues.map(problemCodeOfIssue)).toEqual(['connector_write_unsupported']);
  });

  it('accepts a document of exactly 1 MiB and refuses 1 MiB + 1 with connector_spec_invalid', () => {
    const exact = 'a'.repeat(OPENAPI_DOCUMENT_MAX_BYTES);
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: exact }).success,
    ).toBe(true);
    const issues = issuesOf(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: `${exact}a` }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([['document']]);
    expect(issues.map(problemCodeOfIssue)).toEqual(['connector_spec_invalid']);
  });

  it('counts the document in UTF-8 bytes, not code units', () => {
    const half = OPENAPI_DOCUMENT_MAX_BYTES / 2;
    const twoByte = 'é'.repeat(half);
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: twoByte }).success,
    ).toBe(true);
    const over = issuesOf(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: `${twoByte}a` }),
    );
    expect(over.map(problemCodeOfIssue)).toEqual(['connector_spec_invalid']);
    const fourByte = '😀'.repeat(OPENAPI_DOCUMENT_MAX_BYTES / 4);
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: fourByte }).success,
    ).toBe(true);
    const fourOver = issuesOf(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: `${fourByte}a` }),
    );
    expect(fourOver.map(problemCodeOfIssue)).toEqual(['connector_spec_invalid']);
    const loneSurrogates = '\uD800'.repeat(OPENAPI_DOCUMENT_MAX_BYTES / 3 + 1);
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document: loneSurrogates })
        .success,
    ).toBe(false);
  });

  it('refuses a blank document with connector_spec_invalid', () => {
    for (const document of ['', '  \n ']) {
      const issues = issuesOf(
        CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document }),
      );
      expect(issues.map(problemCodeOfIssue)).toEqual(['connector_spec_invalid']);
    }
  });

  it('refuses a credential with auth none, and a missing one with any other auth', () => {
    expect(
      refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, auth: 'none' })),
    ).toEqual(['credential']);
    const withoutAuth = Object.fromEntries(
      Object.entries(openapiBody).filter(([key]) => key !== 'auth'),
    );
    expect(refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse(withoutAuth))).toEqual([
      'credential',
    ]);
    const withoutCredential = Object.fromEntries(
      Object.entries(openapiBody).filter(([key]) => key !== 'credential'),
    );
    expect(refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse(withoutCredential))).toEqual([
      'credential',
    ]);
  });

  it('refuses a credential that is blank or could split a header', () => {
    for (const credential of ['', '  ', 'tok\r\nX-Evil: 1', 'tok\u0000', 'tok\u0085']) {
      expect(
        refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, credential })),
        JSON.stringify(credential),
      ).toContain('credential');
    }
  });

  it('refuses a base URL that is relative, not http(s), carries userinfo or a fragment', () => {
    for (const baseUrl of [
      '/v1',
      'ftp://api.example.test',
      'https://user:pw@api.example.test',
      'https://user@api.example.test',
      'https://api.example.test/#x',
      'https://api.example.test/ v1',
      `https://api.example.test/${'a'.repeat(2048)}`,
    ]) {
      expect(
        refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, baseUrl })),
        baseUrl,
      ).toEqual(['baseUrl']);
    }
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({
        ...openapiBody,
        baseUrl: 'http://localhost:8080',
      }).success,
    ).toBe(true);
  });

  it('refuses a bad name, an unknown key and a dryRun that is not true', () => {
    for (const patch of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { name: 'a\nb' },
      { dryRun: false },
      { kind: 'mcp' },
      { extra: 1 },
    ]) {
      expect(
        CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });
});

describe('CreatePostgresConnectorRequestSchema (C15)', () => {
  it('accepts a body and defaults maxRows to 100', () => {
    const parsed = CreatePostgresConnectorRequestSchema.parse(postgresBody);
    expect(parsed.maxRows).toBe(100);
    expect(
      CreatePostgresConnectorRequestSchema.safeParse({
        ...postgresBody,
        credential: 'postgresql://db.internal/shop',
        maxRows: 1000,
        dryRun: true,
      }).success,
    ).toBe(true);
  });

  it('refuses readOnly false or absent at readOnly', () => {
    expect(
      refusedPaths(
        CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, readOnly: false }),
      ),
    ).toEqual(['readOnly']);
    const withoutReadOnly = Object.fromEntries(
      Object.entries(postgresBody).filter(([key]) => key !== 'readOnly'),
    );
    expect(refusedPaths(CreatePostgresConnectorRequestSchema.safeParse(withoutReadOnly))).toEqual([
      'readOnly',
    ]);
  });

  it('refuses tables: [] at tables, and unqualified or duplicate tables', () => {
    expect(
      refusedPaths(CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, tables: [] })),
    ).toEqual(['tables']);
    expect(
      refusedPaths(
        CreatePostgresConnectorRequestSchema.safeParse({
          ...postgresBody,
          tables: ['public.orders', 'public.orders'],
        }),
      ),
    ).toEqual(['tables/1']);
    for (const table of [
      'orders',
      'public.orders.x',
      '"public".orders',
      'public.1orders',
      'public.ord ers',
      `public.${'a'.repeat(64)}`,
      'public.',
    ]) {
      expect(PostgresTableNameSchema.safeParse(table).success, table).toBe(false);
    }
    for (const table of ['public.orders', '_s.T$1', `${'a'.repeat(63)}.${'b'.repeat(63)}`]) {
      expect(PostgresTableNameSchema.safeParse(table).success, table).toBe(true);
    }
    const tables = Array.from({ length: 65 }, (_, index) => `public.t${String(index)}`);
    expect(PostgresTablesSchema.safeParse(tables.slice(0, 64)).success).toBe(true);
    expect(PostgresTablesSchema.safeParse(tables).success).toBe(false);
  });

  it('refuses maxRows 0, 1001 and a fraction', () => {
    for (const maxRows of [0, 1001, 1.5, -1]) {
      expect(PostgresMaxRowsSchema.safeParse(maxRows).success, String(maxRows)).toBe(false);
      expect(
        refusedPaths(CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, maxRows })),
      ).toEqual(['maxRows']);
    }
  });

  it('refuses a credential that is not a postgres URL with a host', () => {
    for (const credential of [
      'mysql://db.internal/shop',
      'https://db.internal/shop',
      'postgres:///shop',
      'db.internal:5432',
      '',
      `postgres://db.internal/${'a'.repeat(4096)}`,
      'postgres://db.internal/shop\n',
    ]) {
      expect(
        refusedPaths(
          CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, credential }),
        ),
        credential.slice(0, 40),
      ).toEqual(['credential']);
    }
  });
});

describe('CreateToolConnectorRequestSchema', () => {
  it('discriminates on kind and refuses a body without one', () => {
    expect(CreateToolConnectorRequestSchema.parse(openapiBody).kind).toBe('openapi');
    expect(CreateToolConnectorRequestSchema.parse(postgresBody).kind).toBe('postgres');
    expect(
      CreateToolConnectorRequestSchema.safeParse({ ...postgresBody, kind: 'mcp' }).success,
    ).toBe(false);
    expect(CreateToolConnectorRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
});

describe('no refusal echoes a credential, a URL or the document', () => {
  it('keeps the value out of every issue message and the serialized error', () => {
    const document = `${DOCUMENT} SECRET-DOCUMENT-TEXT ${'a'.repeat(OPENAPI_DOCUMENT_MAX_BYTES)}`;
    const results = [
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, auth: 'none' }),
      CreateOpenApiConnectorRequestSchema.safeParse({
        ...openapiBody,
        credential: `${SECRET_TOKEN}\r\n`,
      }),
      CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, document }),
      CreateOpenApiConnectorRequestSchema.safeParse({
        ...openapiBody,
        baseUrl: 'https://user:pw-SECRET-do-not-echo@api.example.test',
      }),
      CreatePostgresConnectorRequestSchema.safeParse({
        ...postgresBody,
        credential: SECRET_URL.replace('postgres:', 'mysql:'),
      }),
      CreatePostgresConnectorRequestSchema.safeParse({
        ...postgresBody,
        credential: `${SECRET_URL}\u0000`,
      }),
    ];
    for (const result of results) {
      const serialized = JSON.stringify(issuesOf(result));
      expect(serialized).not.toMatch(/SECRET/u);
      expect(serialized).not.toContain('example.test');
      expect(serialized).not.toContain('db.internal');
      expect(String(result.error)).not.toMatch(/SECRET/u);
    }
  });
});

describe('resource sub-schemas', () => {
  const spec = {
    digest: `sha256:${'a'.repeat(64)}`,
    bytes: 2048,
    title: 'Orders',
  };
  const openapi = {
    spec,
    baseUrl: 'https://api.example.test/v1',
    auth: 'bearer',
    allow: ['GET /orders/*'],
    operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{orderId}' }],
  };

  it('accepts an openapi config and holds its spec summary to a digest, size and title', () => {
    expect(OpenApiToolConfigSchema.safeParse(openapi).success).toBe(true);
    expect(OpenApiSpecSummarySchema.safeParse({ digest: spec.digest, bytes: 1 }).success).toBe(
      true,
    );
    for (const bad of [
      { ...spec, digest: `sha256:${'A'.repeat(64)}` },
      { ...spec, digest: 'a'.repeat(64) },
      { ...spec, bytes: 0 },
      { ...spec, bytes: OPENAPI_DOCUMENT_MAX_BYTES + 1 },
      { ...spec, title: '' },
      { ...spec, title: 'a\u0007' },
      { ...spec, title: 'x'.repeat(201) },
      { ...spec, document: '{}' },
    ]) {
      expect(OpenApiSpecSummarySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('requires at least one operation and refuses a duplicate name as a collision', () => {
    expect(OpenApiToolConfigSchema.safeParse({ ...openapi, operations: [] }).success).toBe(false);
    const operation = { name: 'getOrder', method: 'GET', path: '/orders/{orderId}' };
    const issues = issuesOf(
      OpenApiToolConfigSchema.safeParse({
        ...openapi,
        operations: [operation, { ...operation, method: 'HEAD' }],
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([['operations', 1, 'name']]);
    expect(issues.map(problemCodeOfIssue)).toEqual(['connector_tool_name_collision']);
    const tooMany = Array.from({ length: 129 }, (_, index) => ({
      ...operation,
      name: `op${String(index)}`,
    }));
    expect(
      OpenApiToolConfigSchema.safeParse({ ...openapi, operations: tooMany.slice(0, 128) }).success,
    ).toBe(true);
    expect(OpenApiToolConfigSchema.safeParse({ ...openapi, operations: tooMany }).success).toBe(
      false,
    );
  });

  it('accepts a postgres config only with readOnly true and a maxRows', () => {
    const postgres = { tables: ['public.orders'], readOnly: true, maxRows: 100 };
    expect(PostgresToolConfigSchema.safeParse(postgres).success).toBe(true);
    expect(PostgresToolConfigSchema.safeParse({ ...postgres, readOnly: false }).success).toBe(
      false,
    );
    expect(
      PostgresToolConfigSchema.safeParse({ tables: ['public.orders'], readOnly: true }).success,
    ).toBe(false);
    expect(PostgresToolConfigSchema.safeParse({ ...postgres, credential: 'x' }).success).toBe(
      false,
    );
  });
});

describe('selectAllowedOperations (SD14)', () => {
  const operations = [
    { method: 'get', path: '/orders', operationId: 'listOrders' },
    { method: 'get', path: '/orders/{orderId}', operationId: 'getOrder' },
    { method: 'get', path: '/orders/{orderId}/items', operationId: 'listItems' },
    { method: 'head', path: '/orders/{orderId}', operationId: 'headOrder' },
    { method: 'post', path: '/refunds', operationId: 'createRefund' },
    { method: 'get', path: '/', operationId: 'root' },
    { method: 'get', path: '/customers/{id}' },
  ];
  const ids = (allow: readonly string[]): readonly (string | undefined)[] =>
    selectAllowedOperations(allow, operations).admitted.map((operation) => operation.operationId);

  it('matches * against exactly one segment', () => {
    expect(ids(['GET /orders/*'])).toEqual(['getOrder']);
  });

  it('matches a trailing ** against zero or more segments', () => {
    expect(ids(['GET /orders/**'])).toEqual(['listOrders', 'getOrder', 'listItems']);
    expect(ids(['GET /**'])).toEqual(['listOrders', 'getOrder', 'listItems', 'root', undefined]);
  });

  it('matches literals exactly, including a template segment, and the root', () => {
    expect(ids(['GET /orders'])).toEqual(['listOrders']);
    expect(ids(['GET /orders/{orderId}'])).toEqual(['getOrder']);
    expect(ids(['GET /orders/*/items'])).toEqual(['listItems']);
    expect(ids(['GET /'])).toEqual(['root']);
    expect(ids(['GET /order'])).toEqual([]);
  });

  it('matches the method, so HEAD admits only HEAD operations', () => {
    expect(ids(['HEAD /orders/*'])).toEqual(['headOrder']);
    expect(ids(['GET /refunds', 'GET /**/x'])).toEqual([]);
  });

  it('admits each operation once, in document order', () => {
    expect(ids(['GET /orders/*', 'operationId:listOrders', 'GET /orders/**'])).toEqual([
      'listOrders',
      'getOrder',
      'listItems',
    ]);
  });

  it('refuses operationId:createRefund naming a POST as connector_write_unsupported', () => {
    const result = selectAllowedOperations(['GET /orders', 'operationId:createRefund'], operations);
    expect(result.refusals).toEqual([
      {
        path: ['allow', 1],
        code: 'connector_write_unsupported',
        message: 'only GET and HEAD operations are supported',
      },
    ]);
    expect(result.admitted.map((operation) => operation.operationId)).toEqual(['listOrders']);
  });

  it('refuses an operationId naming no operation, a write rule and a malformed rule', () => {
    const result = selectAllowedOperations(
      ['operationId:missing', 'POST /refunds', 'GET orders', 'operationId:getOrder'],
      operations,
    );
    expect(result.refusals.map((refusal) => [refusal.path, refusal.code])).toEqual([
      [['allow', 0], 'connector_spec_invalid'],
      [['allow', 1], 'connector_write_unsupported'],
      [['allow', 2], 'connector_spec_invalid'],
    ]);
    expect(result.admitted.map((operation) => operation.operationId)).toEqual(['getOrder']);
  });
});

describe('problemCodeOfIssue', () => {
  it('reads only a known problem code from a custom issue', () => {
    expect(
      problemCodeOfIssue({
        code: 'custom',
        path: [],
        message: 'x',
        input: undefined,
        params: { problemCode: 'connector_kind_unsupported' },
      }),
    ).toBe('connector_kind_unsupported');
    expect(
      problemCodeOfIssue({
        code: 'custom',
        path: [],
        message: 'x',
        input: undefined,
        params: { problemCode: 'toString' },
      }),
    ).toBeNull();
    expect(
      problemCodeOfIssue({ code: 'custom', path: [], message: 'x', input: undefined }),
    ).toBeNull();
    const [tooSmall] = issuesOf(OpenApiAllowSchema.safeParse([]));
    expect(tooSmall === undefined ? 'missing' : problemCodeOfIssue(tooSmall)).toBeNull();
  });
});

describe('review regressions (S2-02a)', () => {
  const operations = [
    { method: 'get', path: '/orders', operationId: 'listOrders' },
    { method: 'get', path: '/orders/{orderId}', operationId: 'getOrder' },
    { method: 'get', path: '/orders/', operationId: 'listSlash' },
    { method: 'get', path: 'rders', operationId: 'noSlash' },
    { method: 'get', path: '/a b', operationId: 'withSpace' },
  ];
  const ids = (allow: readonly string[]): readonly (string | undefined)[] =>
    selectAllowedOperations(allow, operations).admitted.map((operation) => operation.operationId);
  const codeOf = (issue: z.core.$ZodIssue | undefined): string | null =>
    issue === undefined ? 'missing' : problemCodeOfIssue(issue);

  it('refuses a base URL carrying a credential query parameter, without echoing it', () => {
    for (const baseUrl of [
      'https://api.example.test/v1?api_key=SECRET-q',
      'https://api.example.test/v1?token=SECRET-q',
      'https://api.example.test/v1?x=1&Access_Token=SECRET-q',
    ]) {
      const result = CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, baseUrl });
      expect(refusedPaths(result), baseUrl).toEqual(['baseUrl']);
      expect(JSON.stringify(result.error)).not.toContain('SECRET-q');
    }
    expect(
      CreateOpenApiConnectorRequestSchema.safeParse({
        ...openapiBody,
        baseUrl: 'https://api.example.test/v1?version=2',
      }).success,
    ).toBe(true);
  });

  it('refuses a base URL with a backslash, whose host WHATWG reads differently', () => {
    expect(
      refusedPaths(
        CreateOpenApiConnectorRequestSchema.safeParse({
          ...openapiBody,
          baseUrl: 'https://evil.example\\@good.example/v1',
        }),
      ),
    ).toEqual(['baseUrl']);
  });

  it('refuses a postgres URL that names another host, a socket or session options', () => {
    for (const credential of [
      'postgres://allowed.example.com/db?host=169.254.169.254',
      'postgres://allowed.example.com/db?hostaddr=10.0.0.1',
      'postgres://allowed.example.com/db?port=6432',
      'postgres://h/db?host=/var/run/postgresql',
      'postgres://h/db?sslmode=disable&options=-c%20default_transaction_read_only%3Doff',
      'postgres://h/db?sslrootcert=/etc/passwd',
      'postgres://h/db?service=internal',
      'postgres://a.example.com,10.0.0.1/db',
      'postgres://%2Fvar%2Frun%2Fpostgresql/db',
    ]) {
      expect(
        refusedPaths(
          CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, credential }),
        ),
        credential,
      ).toEqual(['credential']);
    }
    for (const credential of [
      'postgres://reader:pw@db.internal:5432/shop?sslmode=require',
      'postgresql://db.internal/shop?connect_timeout=5&application_name=aw',
      'postgres://[::1]:5432/shop',
    ]) {
      expect(
        CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, credential }).success,
        credential,
      ).toBe(true);
    }
  });

  it('refuses readOnly false as connector_write_unsupported and a non-boolean as plain', () => {
    const [writeIssue] = issuesOf(
      CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, readOnly: false }),
    );
    expect(writeIssue?.path).toEqual(['readOnly']);
    expect(codeOf(writeIssue)).toBe('connector_write_unsupported');
    const [typeIssue] = issuesOf(
      CreatePostgresConnectorRequestSchema.safeParse({ ...postgresBody, readOnly: 'yes' }),
    );
    expect(codeOf(typeIssue)).toBeNull();
    const readOnly: true = CreatePostgresConnectorRequestSchema.parse(postgresBody).readOnly;
    expect(readOnly).toBe(true);
  });

  it('refuses a path rule that admits no operation as connector_spec_invalid', () => {
    expect(selectAllowedOperations(['GET /nothing'], operations).refusals).toEqual([
      { path: ['allow', 0], code: 'connector_spec_invalid', message: 'admits no operation' },
    ]);
  });

  it('never admits a candidate path that is not a template, and * needs a non-empty segment', () => {
    expect(ids(['GET /rders'])).toEqual([]);
    expect(ids(['GET /*'])).toEqual(['listOrders']);
    expect(ids(['GET /orders/*'])).toEqual(['getOrder']);
    expect(ids(['operationId:noSlash', 'operationId:withSpace'])).toEqual([]);
  });

  it('refuses a write method in any case as connector_write_unsupported', () => {
    for (const rule of ['post /refunds', 'Post /refunds', 'delete /orders/*']) {
      const [issue] = issuesOf(OpenApiAllowRuleSchema.safeParse(rule));
      expect(codeOf(issue), rule).toBe('connector_write_unsupported');
    }
    const [lowerGet] = issuesOf(OpenApiAllowRuleSchema.safeParse('get /orders'));
    expect(codeOf(lowerGet)).toBeNull();
  });

  it('refuses a header credential a header value cannot carry as sent', () => {
    for (const credential of ['tok en', '日本', 'café', ' tok', 'tok ', '\ttok']) {
      expect(
        refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, credential })),
        JSON.stringify(credential),
      ).toEqual(['credential']);
    }
    for (const credential of ['a', 'Basic dXNlcjpwYXNz', 'k\tv~!']) {
      expect(
        CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, credential }).success,
        credential,
      ).toBe(true);
    }
  });

  it('keys a run uniquely when a name spells another connector suffixed key', () => {
    expect(toolServerKey('a', 2)).toBe(toolServerKey('a_2'));
    expect(toolServerKeys(['a', 'a', 'a_2'])).toEqual(['a', 'a_2', 'a_2_2']);
    expect(toolServerKeys(['a_2', 'a', 'a'])).toEqual(['a_2', 'a', 'a_3']);
    expect(toolServerKeys(['2', 't_2', 'Orders'])).toEqual(['t_2', 't_2_2', 'orders']);
    const keys = toolServerKeys(Array.from({ length: 12 }, () => 'x'.repeat(40)));
    expect(new Set(keys).size).toBe(12);
    expect(keys.every((key) => key.length <= TOOL_SERVER_KEY_MAX_LENGTH)).toBe(true);
  });

  it('refuses a name with a control or bidirectional formatting character', () => {
    for (const name of ['a\u0000b', 'a\u001bb', 'a‮b', 'a⁦b', 'a\u0085b']) {
      expect(
        refusedPaths(CreateOpenApiConnectorRequestSchema.safeParse({ ...openapiBody, name })),
        JSON.stringify(name),
      ).toEqual(['name']);
    }
  });

  it('refuses a table in a system schema', () => {
    for (const table of [
      'pg_catalog.pg_authid',
      'pg_toast.pg_toast_1',
      'information_schema.tables',
      'PG_CATALOG.pg_class',
    ]) {
      expect(PostgresTableNameSchema.safeParse(table).success, table).toBe(false);
    }
    expect(PostgresTableNameSchema.safeParse('pgdata.events').success).toBe(true);
  });
});
