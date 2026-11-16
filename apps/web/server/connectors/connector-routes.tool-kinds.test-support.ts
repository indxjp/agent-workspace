import { describe, expect, it } from 'vitest';
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as rotateRoute,
} from '../../app/api/connectors/[id]/route';
import { POST as createRoute, GET as listRoute } from '../../app/api/connectors/route';
import {
  WORKSPACE_A,
  WORKSPACE_B,
  bodyOf,
  connectorAudits,
  createIn,
  fixture,
  idContext,
  request,
  stdioBody,
  useMemoryRuntime,
} from './connector-routes.test-support';

const TOOL_SECRET = 'tool-secret-do-not-leak';

const document = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://93.184.216.34/v1' }],
  paths: { '/pets': { get: { operationId: 'listPets', responses: {} } } },
});

const openapiBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'openapi',
    name: 'pets',
    document,
    allow: ['GET /pets'],
    auth: 'bearer',
    credential: TOOL_SECRET,
    ...overrides,
  });

const postgresBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'postgres',
    name: 'shop',
    credential: `postgres://reader:${TOOL_SECRET}@93.184.216.34:5432/shop`,
    tables: ['public.orders'],
    readOnly: true,
    ...overrides,
  });

const SPEC_SENTINEL = 'spec-text-sentinel-never-in-a-resource';

const sentinelDocument = (marker: string): string =>
  JSON.stringify({
    ...(JSON.parse(document) as Record<string, unknown>),
    info: { title: 'Pets', version: '1', description: marker },
  });

const documentOf = (id: string): Promise<string | null> =>
  fixture.memoryConnectors.forWorkspace(WORKSPACE_A).openapiDocument(id);

describe('the tool connector kinds through the routes (ADR-0113 C15)', () => {
  it(
    'creates, lists, gets, patches and deletes both kinds, never returning the credential',
    createsListsGetsPatchesDeletesBothKindsNever,
  );

  it(
    'records no audit event for a PATCH dry run and changes nothing',
    recordsNoAuditEventPATCHDryRunChanges,
  );

  describe('the stored OpenAPI document', () => {
    it(
      'is kept verbatim, never returned, and each write records one audit event',
      isKeptVerbatimNeverReturnedEachWriteRecords,
    );

    it(
      'has no document for a postgres connector, and reads as absent across workspaces',
      hasNoDocumentPostgresConnectorReadsAbsentAcross,
    );

    it(
      'is untouched by a Viewer create and by a Builder replacing another principal connector',
      isUntouchedViewerCreateBuilderReplacingAnotherPrincipal,
    );
  });

  it('refuses a name an MCP connector holds with 409', refusesNameMCPConnectorHolds409);

  it(
    'applies the 2 MiB cap to openapi only: mcp and postgres bodies over 64 KiB get 413',
    applies2MiBCapOpenapiOnlyMcpPostgres,
  );
});

async function createsListsGetsPatchesDeletesBothKindsNever() {
  useMemoryRuntime();
  for (const body of [openapiBody(), postgresBody()]) {
    const created = await createIn(WORKSPACE_A, body);
    const id = created.id;
    const got = await getRoute(
      request('GET', `/api/connectors/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(got.status).toBe(200);
    const patched = await rotateRoute(
      request('PATCH', `/api/connectors/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
      }),
      idContext(id),
    );
    expect(patched.status).toBe(200);
    for (const text of [JSON.stringify(created), await got.text(), await patched.text()]) {
      expect(text).not.toContain(TOOL_SECRET);
    }
  }
  const list = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  const listText = await list.text();
  expect(listText).not.toContain(TOOL_SECRET);
  const parsed = JSON.parse(listText) as { connectors: Array<{ id: string; kind?: string }> };
  expect(parsed.connectors.map((connector) => connector.kind)).toEqual(['openapi', 'postgres']);
  for (const { id } of parsed.connectors) {
    const deleted = await deleteRoute(
      request('DELETE', `/api/connectors/${id}`, { workspace: WORKSPACE_A }),
      idContext(id),
    );
    expect(deleted.status).toBe(204);
  }
}

async function recordsNoAuditEventPATCHDryRunChanges() {
  useMemoryRuntime();
  const created = await createIn(WORKSPACE_A, openapiBody());
  connectorAudits.length = 0;
  const dry = await rotateRoute(
    request('PATCH', `/api/connectors/${created.id}`, {
      workspace: WORKSPACE_A,
      body: openapiBody({ name: 'renamed', dryRun: true }),
    }),
    idContext(created.id),
  );
  expect(dry.status).toBe(200);
  expect(connectorAudits).toEqual([]);
  const got = await getRoute(
    request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
    idContext(created.id),
  );
  expect(((await bodyOf(got)) as { name: string }).name).toBe('pets');
}

async function refusesNameMCPConnectorHolds409() {
  useMemoryRuntime();
  await createIn(WORKSPACE_A, stdioBody({ name: 'shared' }));
  const conflict = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      body: openapiBody({ name: 'shared' }),
    }),
  );
  expect(conflict.status).toBe(409);
}

async function applies2MiBCapOpenapiOnlyMcpPostgres() {
  useMemoryRuntime();
  const padding = 'x'.repeat(70 * 1024);
  const mcp = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      body: stdioBody({ args: [padding] }),
    }),
  );
  expect(mcp.status).toBe(413);
  const postgres = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      body: postgresBody({ name: padding }),
    }),
  );
  expect(postgres.status).toBe(413);

  // A document of about 1 MiB (its description pads it) is read and saved.
  const large = JSON.stringify({
    ...(JSON.parse(document) as Record<string, unknown>),
    info: { title: 'Pets', version: '1', description: 'd'.repeat(1000 * 1024) },
  });
  const openapi = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      body: openapiBody({ document: large }),
    }),
  );
  expect(openapi.status, await openapi.clone().text()).toBe(201);
}

async function isKeptVerbatimNeverReturnedEachWriteRecords() {
  useMemoryRuntime();
  const text = sentinelDocument(SPEC_SENTINEL);
  const created = await createIn(WORKSPACE_A, openapiBody({ document: text }));
  expect(connectorAudits).toHaveLength(1);
  expect(await documentOf(created.id)).toBe(text);

  const replacement = sentinelDocument('replaced-' + SPEC_SENTINEL);
  const replaced = await rotateRoute(
    request('PATCH', `/api/connectors/${created.id}`, {
      workspace: WORKSPACE_A,
      body: openapiBody({ document: replacement }),
    }),
    idContext(created.id),
  );
  expect(replaced.status).toBe(200);
  expect(connectorAudits).toHaveLength(2);
  expect(await documentOf(created.id)).toBe(replacement);

  const renamed = await rotateRoute(
    request('PATCH', `/api/connectors/${created.id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ name: 'renamed' }),
    }),
    idContext(created.id),
  );
  expect(renamed.status).toBe(200);
  expect(await documentOf(created.id)).toBe(replacement);

  const got = await getRoute(
    request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
    idContext(created.id),
  );
  const list = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  for (const surface of [
    JSON.stringify(created),
    await replaced.text(),
    await renamed.text(),
    await got.text(),
    await list.text(),
    JSON.stringify(connectorAudits),
  ]) {
    expect(surface).not.toContain(SPEC_SENTINEL);
  }
}

async function hasNoDocumentPostgresConnectorReadsAbsentAcross() {
  useMemoryRuntime();
  const pg = await createIn(WORKSPACE_A, postgresBody());
  expect(await documentOf(pg.id)).toBeNull();
  const created = await createIn(WORKSPACE_A, openapiBody({ name: 'other' }));
  expect(
    await fixture.memoryConnectors.forWorkspace(WORKSPACE_B).openapiDocument(created.id),
  ).toBeNull();
}

async function isUntouchedViewerCreateBuilderReplacingAnotherPrincipal() {
  useMemoryRuntime();
  const created = await createIn(WORKSPACE_A, openapiBody());
  const before = await documentOf(created.id);
  const viewerCreate = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      role: 'viewer',
      body: openapiBody({ name: 'smuggled', document: sentinelDocument(SPEC_SENTINEL) }),
    }),
  );
  expect(viewerCreate.status).toBe(403);
  const foreignReplace = await rotateRoute(
    request('PATCH', `/api/connectors/${created.id}`, {
      workspace: WORKSPACE_A,
      role: 'builder',
      principal: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      body: openapiBody({ document: sentinelDocument(SPEC_SENTINEL) }),
    }),
    idContext(created.id),
  );
  expect(foreignReplace.status).toBe(403);
  expect(await documentOf(created.id)).toBe(before);
  const all = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  expect(((await bodyOf(all)) as { connectors: unknown[] }).connectors).toHaveLength(1);
}
