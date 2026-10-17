import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CONNECTOR_AUTH_TYPES,
  CONNECTOR_KINDS,
  CONNECTOR_NAME_MAX_LENGTH,
  CONNECTOR_REQUEST_BODY_MAX_BYTES,
  CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND,
  CONNECTOR_TRANSPORTS,
  CONNECTORS_PROBLEM_CODES,
  ConnectorUpdateRequestSchema,
  ConnectorListResponseSchema,
  ConnectorResourceSchema,
  OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES,
  TEST_CONNECTION_FAILURE_KINDS,
  TestConnectionOutcomeSchema,
  connectorKindOf,
  isMcpConnectorResource,
} from './connectors.js';
import { OPENAPI_DOCUMENT_MAX_BYTES, TOOL_CONNECTOR_PROBLEM_CODES } from './tool-connectors.js';
import { CONTRACTS_VERSION, judgeContractsVersion, parseContractsVersion } from './version.js';

const remote = {
  id: '77777777-7777-4777-8777-777777777777',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'GitHub',
  transport: 'http',
  command: null,
  args: null,
  url: 'https://mcp.example.com/mcp',
  authType: 'bearer',
  hasCredential: true,
  enabled: true,
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:05:00.000Z',
};

const stdio = {
  ...remote,
  id: '88888888-8888-4888-8888-888888888888',
  name: 'Filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
  url: null,
  authType: 'none',
  hasCredential: false,
  createdBy: '99999999-9999-4999-8999-999999999999',
};

const openapiConnector = {
  ...remote,
  id: '99999999-9999-4999-8999-999999999990',
  name: 'Orders API',
  kind: 'openapi',
  transport: null,
  command: null,
  args: null,
  url: null,
  authType: null,
  openapi: {
    spec: { digest: `sha256:${'a'.repeat(64)}`, bytes: 2048, title: 'Orders' },
    baseUrl: 'https://api.example.test/v1',
    auth: 'bearer',
    allow: ['GET /orders/*'],
    operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{orderId}' }],
  },
};

const postgresHalf = { tables: ['public.orders'], readOnly: true, maxRows: 100 };

const postgresConnector = {
  ...remote,
  id: '99999999-9999-4999-8999-999999999991',
  name: 'Shop DB',
  kind: 'postgres',
  transport: null,
  command: null,
  args: null,
  url: null,
  authType: null,
  postgres: postgresHalf,
};

/** The paths of the issues of a refused resource parse. */
function refusedKeys(value: unknown): readonly string[] {
  const result = ConnectorResourceSchema.safeParse(value);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => issue.path.map(String).join('/'));
}

describe('connector kinds (ADR-0113 SD1, C15)', () => {
  it('reads an MCP resource without kind as mcp and returns it unchanged', () => {
    for (const legacy of [remote, stdio]) {
      const parsed = ConnectorResourceSchema.parse(legacy);
      expect(connectorKindOf(parsed)).toBe('mcp');
      expect(parsed).toEqual(legacy);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(legacy));
      expect(isMcpConnectorResource(parsed)).toBe(true);
    }
    const explicit = ConnectorResourceSchema.parse({ ...remote, kind: 'mcp' });
    expect(connectorKindOf(explicit)).toBe('mcp');
    expect(isMcpConnectorResource(explicit)).toBe(true);
  });

  it('reads an openapi and a postgres resource', () => {
    const openapi = ConnectorResourceSchema.parse(openapiConnector);
    expect(connectorKindOf(openapi)).toBe('openapi');
    expect(isMcpConnectorResource(openapi)).toBe(false);
    expect(openapi.openapi?.operations.map((operation) => operation.name)).toEqual(['getOrder']);
    const postgres = ConnectorResourceSchema.parse(postgresConnector);
    expect(connectorKindOf(postgres)).toBe('postgres');
    expect(isMcpConnectorResource(postgres)).toBe(false);
    expect(postgres.postgres?.maxRows).toBe(100);
  });

  it('keeps the resource one strict object with the key order the Lean wire model pins', () => {
    expect(Object.keys(ConnectorResourceSchema.unwrap().shape)).toEqual([
      'id',
      'workspaceId',
      'name',
      'kind',
      'transport',
      'command',
      'args',
      'url',
      'authType',
      'hasCredential',
      'enabled',
      'createdBy',
      'ownerPrincipalId',
      'createdAt',
      'updatedAt',
      'openapi',
      'postgres',
    ]);
    expect(refusedKeys({ ...openapiConnector, credential: 'x' })).toEqual(['']);
    expect(refusedKeys({ ...remote, kind: 'graphql' })).toEqual(['kind']);
  });

  it('refuses an MCP resource missing its transport or auth type, or carrying a tool half', () => {
    expect(refusedKeys({ ...remote, transport: null })).toEqual(['transport']);
    expect(refusedKeys({ ...remote, kind: 'mcp', authType: null })).toEqual(['authType']);
    expect(refusedKeys({ ...remote, openapi: openapiConnector.openapi })).toEqual(['openapi']);
    expect(refusedKeys({ ...remote, postgres: postgresHalf })).toEqual(['postgres']);
  });

  it('refuses a tool resource with an MCP field, without its half, or with the other half', () => {
    expect(refusedKeys({ ...openapiConnector, transport: 'http' })).toEqual(['transport']);
    expect(refusedKeys({ ...openapiConnector, command: 'npx' })).toEqual(['command']);
    expect(refusedKeys({ ...openapiConnector, args: [] })).toEqual(['args']);
    expect(refusedKeys({ ...openapiConnector, url: 'https://x.test' })).toEqual(['url']);
    expect(refusedKeys({ ...openapiConnector, authType: 'bearer' })).toEqual(['authType']);
    expect(refusedKeys({ ...openapiConnector, openapi: undefined })).toEqual(['openapi']);
    expect(refusedKeys({ ...openapiConnector, postgres: postgresHalf })).toEqual(['postgres']);
    expect(refusedKeys({ ...postgresConnector, postgres: undefined })).toEqual(['postgres']);
    expect(refusedKeys({ ...postgresConnector, openapi: openapiConnector.openapi })).toEqual([
      'openapi',
    ]);
    expect(refusedKeys({ ...postgresConnector, transport: 'stdio', url: 'x' })).toEqual([
      'transport',
      'url',
    ]);
  });

  it('refuses a tool resource whose hasCredential contradicts its kind or auth', () => {
    expect(refusedKeys({ ...postgresConnector, hasCredential: false })).toEqual(['hasCredential']);
    expect(refusedKeys({ ...openapiConnector, hasCredential: false })).toEqual(['hasCredential']);
    const noAuth = { ...openapiConnector, openapi: { ...openapiConnector.openapi, auth: 'none' } };
    expect(refusedKeys(noAuth)).toEqual(['hasCredential']);
    expect(ConnectorResourceSchema.safeParse({ ...noAuth, hasCredential: false }).success).toBe(
      true,
    );
  });

  it('publishes the kinds, the body cap of each kind and the merged problem codes', () => {
    expect(CONNECTOR_KINDS).toEqual(['mcp', 'openapi', 'postgres']);
    expect(CONNECTOR_REQUEST_BODY_MAX_BYTES).toBe(65_536);
    expect(CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND).toEqual({
      mcp: 65_536,
      openapi: 2 * 1_048_576 + 65_536,
      postgres: 65_536,
    });
    expect(OPENAPI_CONNECTOR_REQUEST_BODY_MAX_BYTES).toBe(2 * OPENAPI_DOCUMENT_MAX_BYTES + 65_536);
    expect(Object.isFrozen(CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND)).toBe(true);
    expect(CONNECTORS_PROBLEM_CODES).toMatchObject(TOOL_CONNECTOR_PROBLEM_CODES);
    expect(CONNECTORS_PROBLEM_CODES.invalid_body).toBe(400);
    expect(CONNECTORS_PROBLEM_CODES.connector_write_unsupported).toBe(422);
  });

  it('fits a 1 MiB document of quotes and newlines, escaped as a JSON string, in the openapi cap', () => {
    const document = 'a"\n\\'.repeat(OPENAPI_DOCUMENT_MAX_BYTES / 4);
    const body = JSON.stringify({ kind: 'openapi', name: 'x', document, allow: ['GET /**'] });
    expect(new TextEncoder().encode(document).length).toBe(OPENAPI_DOCUMENT_MAX_BYTES);
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
      CONNECTOR_REQUEST_BODY_MAX_BYTES_BY_KIND.openapi,
    );
  });
});

describe('version skew: a 0.2 client reading a 0.3 server (issue #526)', () => {
  // The client this release replaces: the 14 keys it knew, `transport` and `authType` non-null,
  // strict. Built from the current shape so only the change under test differs.
  const shape = ConnectorResourceSchema.unwrap().shape;
  const OlderConnectorResourceSchema = z
    .object({
      id: shape.id,
      workspaceId: shape.workspaceId,
      name: shape.name,
      transport: z.enum(CONNECTOR_TRANSPORTS),
      command: shape.command,
      args: shape.args,
      url: shape.url,
      authType: z.enum(CONNECTOR_AUTH_TYPES),
      hasCredential: shape.hasCredential,
      enabled: shape.enabled,
      createdBy: shape.createdBy,
      ownerPrincipalId: shape.ownerPrincipalId,
      createdAt: shape.createdAt,
      updatedAt: shape.updatedAt,
    })
    .strict();
  const OlderConnectorListSchema = z
    .object({ connectors: z.array(OlderConnectorResourceSchema) })
    .strict();

  it('keeps parsing an MCP-only list the server renders without the new keys', () => {
    const list = ConnectorListResponseSchema.parse({ connectors: [remote, stdio] });
    expect(OlderConnectorListSchema.safeParse(list).success).toBe(true);
  });

  it('refuses a list holding a tool connector (the SDK raises ContractViolationError)', () => {
    const list = ConnectorListResponseSchema.parse({ connectors: [remote, openapiConnector] });
    expect(OlderConnectorListSchema.safeParse(list).success).toBe(false);
  });

  it('serves this release to the next minor server, so only a list with a tool kind refuses', () => {
    // The skew this change creates: a client built at this CONTRACTS_VERSION, served by the next
    // minor (which serves one minor back), parses responses rather than getting 426. Two minors
    // back is 426 upgrade client.
    const client = parseContractsVersion(CONTRACTS_VERSION);
    expect(client).not.toBeNull();
    if (client === null) return;
    const range = {
      minimum: { major: client.major, minor: client.minor, patch: 0 },
      current: { major: client.major, minor: client.minor + 1, patch: 0 },
    };
    expect(judgeContractsVersion(client, range)).toEqual({ kind: 'served' });
    const older = { major: client.major, minor: client.minor - 1, patch: 0 };
    expect(client.minor).toBeGreaterThan(0);
    expect(judgeContractsVersion(older, range)).toEqual({ kind: 'unsupported', upgrade: 'client' });
  });
});

describe('ConnectorResourceSchema', () => {
  it('accepts a remote connector with a credential on file and a stdio one without', () => {
    expect(ConnectorResourceSchema.safeParse(remote).success).toBe(true);
    expect(ConnectorResourceSchema.safeParse(stdio).success).toBe(true);
    expect(ConnectorResourceSchema.safeParse({ ...remote, transport: 'sse' }).success).toBe(true);
  });

  it('refuses a body that carries the credential under any spelling', () => {
    expect(ConnectorResourceSchema.safeParse({ ...remote, credential: 'tok' }).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, credentialSecretId: 's' }).success).toBe(
      false,
    );
    expect(ConnectorResourceSchema.safeParse({ ...remote, token: 'tok' }).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, apiKey: 'tok' }).success).toBe(false);
  });

  it('rejects an unknown transport or auth type, a wrong type, and a missing field', () => {
    expect(ConnectorResourceSchema.safeParse({ ...remote, transport: 'grpc' }).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, authType: 'basic' }).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, hasCredential: 'yes' }).success).toBe(
      false,
    );
    expect(ConnectorResourceSchema.safeParse({ ...stdio, args: ['-y', 1] }).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, createdAt: 1_700_000_000 }).success).toBe(
      false,
    );
    const withoutOwner = Object.fromEntries(
      Object.entries(remote).filter(([key]) => key !== 'ownerPrincipalId'),
    );
    expect(ConnectorResourceSchema.safeParse(withoutOwner).success).toBe(false);
    expect(ConnectorResourceSchema.safeParse({ ...remote, name: '' }).success).toBe(false);
  });

  it('rejects an unknown key', () => {
    expect(ConnectorResourceSchema.safeParse({ ...remote, description: 'x' }).success).toBe(false);
  });
});

describe('ConnectorListResponseSchema', () => {
  it('reads an empty list and a populated one, and refuses a credential inside an item', () => {
    expect(ConnectorListResponseSchema.safeParse({ connectors: [] }).success).toBe(true);
    expect(ConnectorListResponseSchema.safeParse({ connectors: [remote, stdio] }).success).toBe(
      true,
    );
    expect(
      ConnectorListResponseSchema.safeParse({ connectors: [{ ...remote, credential: 'x' }] })
        .success,
    ).toBe(false);
    expect(ConnectorListResponseSchema.safeParse([remote]).success).toBe(false);
    expect(ConnectorListResponseSchema.safeParse({ connectors: [remote], total: 1 }).success).toBe(
      false,
    );
  });
});

describe('TestConnectionOutcomeSchema', () => {
  const ok = {
    ok: true,
    kind: 'ok',
    message: 'Connected. The server answered and accepted the credential.',
    serverName: 'github-mcp',
    serverVersion: '1.2.0',
    toolCount: 12,
  };
  const failed = {
    ok: false,
    kind: 'credential-rejected',
    message: 'The server was reached, but it rejected the credential.',
  };

  it('reads a success with and without server identity, and every failure kind', () => {
    expect(TestConnectionOutcomeSchema.safeParse(ok).success).toBe(true);
    expect(
      TestConnectionOutcomeSchema.safeParse({ ...ok, serverName: null, serverVersion: null })
        .success,
    ).toBe(true);
    for (const kind of TEST_CONNECTION_FAILURE_KINDS) {
      expect(TestConnectionOutcomeSchema.safeParse({ ...failed, kind }).success).toBe(true);
    }
  });

  it('holds each arm to its own fields: no tool count on a failure, no unknown kind on success', () => {
    expect(TestConnectionOutcomeSchema.safeParse({ ...failed, toolCount: 0 }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...failed, kind: 'ok' }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...ok, kind: 'timeout' }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...ok, toolCount: -1 }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...ok, toolCount: 1.5 }).success).toBe(false);
    const withoutToolCount = Object.fromEntries(
      Object.entries(ok).filter(([key]) => key !== 'toolCount'),
    );
    expect(TestConnectionOutcomeSchema.safeParse(withoutToolCount).success).toBe(false);
  });

  it('refuses an unknown key on either arm and a non-boolean discriminant', () => {
    expect(TestConnectionOutcomeSchema.safeParse({ ...ok, credential: 'x' }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...failed, stderr: 'x' }).success).toBe(false);
    expect(TestConnectionOutcomeSchema.safeParse({ ...failed, ok: 'no' }).success).toBe(false);
  });
});

describe('vocabulary and bounds', () => {
  it('publishes the transports, auth types and failure kinds the routes speak', () => {
    expect(CONNECTOR_TRANSPORTS).toEqual(['stdio', 'http', 'sse']);
    expect(CONNECTOR_AUTH_TYPES).toEqual(['none', 'api-key', 'bearer', 'oauth']);
    expect(TEST_CONNECTION_FAILURE_KINDS).toHaveLength(17);
    expect(new Set(TEST_CONNECTION_FAILURE_KINDS).size).toBe(TEST_CONNECTION_FAILURE_KINDS.length);
    expect(TEST_CONNECTION_FAILURE_KINDS).toContain('stdio-probe-unavailable');
  });

  it('publishes the name and request-body bounds the routes enforce', () => {
    expect(CONNECTOR_NAME_MAX_LENGTH).toBe(200);
    expect(CONNECTOR_REQUEST_BODY_MAX_BYTES).toBe(65_536);
  });
});

describe('ConnectorUpdateRequestSchema (S-20)', () => {
  it('accepts any non-empty subset of the updatable fields', () => {
    for (const body of [
      { name: 'Renamed' },
      { enabled: false },
      { url: 'https://mcp.example.test' },
      { command: 'node', args: ['server.js'] },
      { args: null },
      { authType: 'bearer', credential: 'token' },
      { credential: 'rotated' },
    ]) {
      expect(ConnectorUpdateRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it('refuses an empty patch, an unknown key and every field that would move ownership', () => {
    for (const body of [
      {},
      { transport: 'http' },
      { ownerPrincipalId: 'p' },
      { workspaceId: 'w' },
      { createdBy: 'u' },
      { hasCredential: true },
      { name: '' },
      { name: 'x'.repeat(201) },
      { url: 'ftp://mcp.example.test' },
      { url: 'https://' },
      { url: 'https://user:pw@mcp.example.test/mcp' },
      { url: 'https://mcp.example.test/mcp?api_key=k' },
      { url: 'HTTPS://mcp.example.test/mcp' },
      { command: '   ' },
      { credential: ' ' },
      { authType: 'basic' },
      { enabled: 'false' },
      null,
    ]) {
      expect(ConnectorUpdateRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });
});
