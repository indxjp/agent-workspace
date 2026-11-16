/**
 * SDK conformance, connectors: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_NAME_MAX_LENGTH,
  CONNECTOR_REQUEST_BODY_MAX_BYTES,
  CONNECTORS_PROBLEM_CODES,
  ConnectorListResponseSchema,
  type ConnectorResource,
  type McpConnectorResource,
  ConnectorResourceSchema,
  TEST_CONNECTION_FAILURE_KINDS,
  type TestConnectionOutcome,
  TestConnectionOutcomeSchema,
  isMcpConnectorResource,
} from '@indx-workspace/contracts/connectors';
import { FAILURE_KINDS as SERVER_FAILURE_KINDS } from './connectors/classify';
import {
  type ConnectorResource as ServerConnectorResource,
  parseCreateConnectorBody,
} from './connectors/contract';
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  rotateConnectorCredential,
  testConnectionSaved,
} from './connectors/handlers';
import { readConnectorBody } from './connectors/http';
import { createInMemoryConnectorsStoreProvider } from './connectors/memory-store';
import { type TestConnectionOutcome as ServerTestConnectionOutcome } from './connectors/test-connection';

const CONNECTORS_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CONNECTORS_OWNER = {
  principalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const CONNECTOR_PLAINTEXT = 'ghp_conformance-plaintext-never-on-the-wire';

const remoteConnectorBody = {
  name: 'GitHub',
  transport: 'http',
  url: 'https://mcp.example.invalid/mcp',
  authType: 'bearer',
  credential: CONNECTOR_PLAINTEXT,
};

const stdioConnectorBody = {
  name: 'Filesystem',
  transport: 'stdio',
  command: 'sdk-conformance-no-such-binary',
  args: ['--root', '/data'],
};

// The server's own types must be exactly what the contract infers, in both directions, so a
// field added on one side without the other is a compile error here before it is a runtime one.
function connectorResourceToContract(value: ServerConnectorResource): ConnectorResource {
  return value;
}

function connectorResourceFromContract(value: McpConnectorResource): ServerConnectorResource {
  return value;
}

function testOutcomeToContract(value: ServerTestConnectionOutcome): TestConnectionOutcome {
  return value;
}

function testOutcomeFromContract(value: TestConnectionOutcome): ServerTestConnectionOutcome {
  return value;
}

const egressOpen = (): Promise<{ readonly ok: true }> => Promise.resolve({ ok: true });

/** An OpenAPI connector body and a Postgres one, each with the credential it must never echo. */
function openApiAndPostgresBodies() {
  const document = JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Orders', version: '1' },
    servers: [{ url: 'https://93.184.216.34/v1' }],
    paths: { '/orders': { get: { operationId: 'listOrders', responses: {} } } },
  });
  return [
    {
      kind: 'openapi',
      name: 'orders',
      document,
      allow: ['GET /orders'],
      auth: 'bearer',
      credential: 'tok',
    },
    {
      kind: 'postgres',
      name: 'warehouse',
      credential: 'postgres://u:p@93.184.216.34:5432/db',
      tables: ['public.orders'],
      readOnly: true,
    },
  ];
}

type ConnectorStore = ReturnType<
  ReturnType<typeof createInMemoryConnectorsStoreProvider>['forWorkspace']
>;

/** Dry-runs and creates `body`, expecting the contract's resource and no echoed credential. */
async function expectCreatedWithoutCredential(
  store: ConnectorStore,
  body: ReturnType<typeof openApiAndPostgresBodies>[number],
): Promise<void> {
  const dry = await createConnector(store, { ...body, dryRun: true }, null, egressOpen);
  expect(dry.status).toBe(200);
  expect(TestConnectionOutcomeSchema.safeParse(dry.body).success).toBe(true);

  const created = await createConnector(store, body, CONNECTORS_OWNER, egressOpen);
  expect(created.status).toBe(201);
  const parsed = ConnectorResourceSchema.safeParse(created.body);
  expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  if (parsed.success) expect(isMcpConnectorResource(parsed.data)).toBe(false);
  expect(JSON.stringify(created.body)).not.toContain(body.credential);
}

/** Three create answers the contract refuses: an unknown kind, a write verb, a bare document. */
async function refusedCreates(
  store: ConnectorStore,
  openApiBody: ReturnType<typeof openApiAndPostgresBodies>[number],
) {
  return [
    await createConnector(store, { kind: 'ftp', name: 'x' }, CONNECTORS_OWNER, egressOpen),
    await createConnector(
      store,
      { ...openApiBody, name: 'w', allow: ['POST /orders'] },
      CONNECTORS_OWNER,
      egressOpen,
    ),
    await createConnector(
      store,
      { ...openApiBody, name: 'z', document: '{}' },
      CONNECTORS_OWNER,
      egressOpen,
    ),
  ];
}

describe('connectors', () => {
  it('answers create, list, get, rotate and delete through the real handlers with bodies the contract accepts, and no body carries the credential', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);

    const created = await createConnector(store, remoteConnectorBody, CONNECTORS_OWNER);
    expect(created.status).toBe(201);
    const createdParsed = ConnectorResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;
    expect(isMcpConnectorResource(createdParsed.data)).toBe(true);
    if (!isMcpConnectorResource(createdParsed.data)) return;
    expect(createdParsed.data.hasCredential).toBe(true);
    expect(connectorResourceFromContract(createdParsed.data).id).toBe(createdParsed.data.id);

    const stdioCreated = await createConnector(store, stdioConnectorBody, CONNECTORS_OWNER);
    expect(stdioCreated.status).toBe(201);
    const stdioParsed = ConnectorResourceSchema.safeParse(stdioCreated.body);
    expect(stdioParsed.success, JSON.stringify(stdioParsed)).toBe(true);
    if (!stdioParsed.success) return;
    expect(stdioParsed.data).toMatchObject({ url: null, authType: 'none', hasCredential: false });

    const listed = await listConnectors(store);
    expect(listed.status).toBe(200);
    expect(ConnectorListResponseSchema.safeParse(listed.body).success).toBe(true);

    const fetched = await getConnector(store, createdParsed.data.id);
    expect(fetched.status).toBe(200);
    expect(ConnectorResourceSchema.safeParse(fetched.body).success).toBe(true);

    const rotatedPlaintext = 'ghp_conformance-rotated-value';
    const rotated = await rotateConnectorCredential(store, createdParsed.data.id, {
      credential: rotatedPlaintext,
    });
    expect(rotated.status).toBe(200);
    expect(ConnectorResourceSchema.safeParse(rotated.body).success).toBe(true);

    for (const body of [created.body, stdioCreated.body, listed.body, fetched.body, rotated.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(CONNECTOR_PLAINTEXT);
      expect(text).not.toContain(rotatedPlaintext);
      expect(text).not.toContain('"credential"');
    }

    const deleted = await deleteConnector(store, createdParsed.data.id);
    expect(deleted).toEqual({ status: 204, body: null });
  });
});

describe('connectors', () => {
  it('answers a saved test and a dry-run test with the published outcome shape, without persisting a draft', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);
    const created = await createConnector(store, stdioConnectorBody, CONNECTORS_OWNER);
    const createdParsed = ConnectorResourceSchema.safeParse(created.body);
    expect(createdParsed.success, JSON.stringify(createdParsed)).toBe(true);
    if (!createdParsed.success) return;
    expect(isMcpConnectorResource(createdParsed.data)).toBe(true);
    if (!isMcpConnectorResource(createdParsed.data)) return;

    // A stdio probe never launches the command in the control plane (ADR-0045); its declared
    // refusal is the one real outcome this test can drive without a network.
    const saved = await testConnectionSaved(store, createdParsed.data.id);
    expect(saved.status).toBe(200);
    const savedParsed = TestConnectionOutcomeSchema.safeParse(saved.body);
    expect(savedParsed.success, JSON.stringify(savedParsed)).toBe(true);
    if (!savedParsed.success) return;
    expect(savedParsed.data).toMatchObject({ ok: false, kind: 'stdio-probe-unavailable' });
    expect(testOutcomeFromContract(savedParsed.data).ok).toBe(false);

    const draft = await createConnector(
      store,
      { ...stdioConnectorBody, name: 'Draft', dryRun: true },
      null,
    );
    expect(draft.status).toBe(200);
    expect(TestConnectionOutcomeSchema.safeParse(draft.body).success).toBe(true);
    const listed = await listConnectors(store);
    expect(ConnectorListResponseSchema.parse(listed.body).connectors.map((c) => c.name)).toEqual([
      'Filesystem',
    ]);

    // The success arm is not reachable without a live MCP server; it is pinned by type through
    // `testOutcomeToContract` and by value through the server's own literal shape.
    const connected: ServerTestConnectionOutcome = {
      ok: true,
      kind: 'ok',
      message: 'Connected. The server answered and accepted the credential.',
      serverName: 'github-mcp',
      serverVersion: '1.2.0',
      toolCount: 12,
    };
    expect(TestConnectionOutcomeSchema.safeParse(testOutcomeToContract(connected)).success).toBe(
      true,
    );
    expect(
      ConnectorResourceSchema.safeParse(connectorResourceToContract(createdParsed.data)).success,
    ).toBe(true);
  });
});

describe('connectors', () => {
  it('creates openapi and postgres connectors whose resources and dry runs the contract accepts', async () => {
    const store = createInMemoryConnectorsStoreProvider().forWorkspace(CONNECTORS_WORKSPACE);
    const bodies = openApiAndPostgresBodies();
    const [openApiBody] = bodies;
    if (openApiBody === undefined) throw new Error('the fixture has an openapi body');
    for (const body of bodies) {
      await expectCreatedWithoutCredential(store, body);
    }
    const listed = ConnectorListResponseSchema.safeParse((await listConnectors(store)).body);
    expect(listed.success && listed.data.connectors.length).toBe(2);

    for (const refusal of await refusedCreates(store, openApiBody)) {
      const code = (refusal.body as { error: { code: keyof typeof CONNECTORS_PROBLEM_CODES } })
        .error.code;
      expect(refusal.status).toBe(CONNECTORS_PROBLEM_CODES[code]);
    }
  });
});

describe('connectors', () => {
  it('restates the same failure kinds and bounds as the contract', async () => {
    expect([...SERVER_FAILURE_KINDS]).toEqual([...TEST_CONNECTION_FAILURE_KINDS]);
    // An mcp body one byte over the contract's cap is refused (`{"name":"…"}` is 11 bytes + name).
    const oversized = await readConnectorBody(
      new Request('http://localhost/api/connectors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'n'.repeat(CONNECTOR_REQUEST_BODY_MAX_BYTES + 1 - 11) }),
      }),
    );
    expect(oversized.ok ? 200 : oversized.result.status).toBe(413);

    const longestName = 'n'.repeat(CONNECTOR_NAME_MAX_LENGTH);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, name: longestName }).ok).toBe(true);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, name: `${longestName}x` }).ok).toBe(
      false,
    );
  });

  it('accepts exactly the request bodies the SDK sends', () => {
    expect(parseCreateConnectorBody(remoteConnectorBody).ok).toBe(true);
    expect(parseCreateConnectorBody(stdioConnectorBody).ok).toBe(true);
    expect(parseCreateConnectorBody({ name: 'FS', transport: 'stdio', command: 'npx' }).ok).toBe(
      true,
    );
    expect(
      parseCreateConnectorBody({ name: 'S', transport: 'sse', url: 'https://x.invalid/sse' }).ok,
    ).toBe(true);
    // The contract's two input shapes are exclusive because the route refuses the mix.
    expect(parseCreateConnectorBody({ ...remoteConnectorBody, command: 'npx' }).ok).toBe(false);
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, url: 'https://x' }).ok).toBe(false);
    expect(parseCreateConnectorBody({ ...remoteConnectorBody, credential: undefined }).ok).toBe(
      false,
    );
    expect(parseCreateConnectorBody({ ...stdioConnectorBody, credential: 'unexpected' }).ok).toBe(
      false,
    );
  });
});
