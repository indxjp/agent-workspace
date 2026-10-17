/**
 * The connector route handlers, imported as Next.js will import them and driven with real
 * `Request` objects — the same shape `apps/web/server/secrets/routes.test.ts` uses, for the same
 * reason: the wiring in `apps/web/app/api/connectors/**` is code too.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as rotateRoute,
} from '../../app/api/connectors/[id]/route';
import { POST as testSavedRoute } from '../../app/api/connectors/[id]/test-connection/route';
import { GET as listRoute, POST as createRoute } from '../../app/api/connectors/route';
import { createInMemoryConnectorsStoreProvider } from './memory-store';
import {
  clearConnectorsRuntime,
  configureConnectorsRuntime,
  type WorkspaceResolution,
} from './runtime';
import type { ConnectorResource } from './contract';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_HEADER = 'x-test-workspace';
/** #240: which of §21's roles the test API key carries; Owner when absent. */
const ROLE_HEADER = 'x-test-role';
/** #240 review: which principal the test API key is; the connectors' creator when absent. */
const PRINCIPAL_HEADER = 'x-test-principal';
const CREATOR_PRINCIPAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_PRINCIPAL = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const connectorAudits: Array<{ subjectId: string; subjectLabel: string }> = [];
let memoryConnectors = createInMemoryConnectorsStoreProvider();

afterEach(() => {
  clearConnectorsRuntime();
  clearRbacRuntime();
});

function useMemoryRuntime(
  identifyActor: () => Promise<{
    readonly principalId: string;
    readonly userId: string | null;
  }> = () =>
    Promise.resolve({
      principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
): void {
  connectorAudits.length = 0;
  memoryConnectors = createInMemoryConnectorsStoreProvider();
  configureConnectorsRuntime({
    connectors: memoryConnectors,
    recordAudit: (_request, event) => {
      connectorAudits.push(event);
      return Promise.resolve();
    },
    // issue #117: every test request is "authenticated" enough to create a connector.
    identifyActor,
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      if (workspaceId === null) {
        return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
      }
      return Promise.resolve({ kind: 'workspace', workspaceId });
    },
  });
  configureRbacRuntime({
    directory: createMemoryDirectory(),
    identify: (request) => {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? null
          : Principal.fromApiKey({
              principalId: request.headers.get(PRINCIPAL_HEADER) ?? CREATOR_PRINCIPAL,
              apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              workspaceId,
              role: parseTestRole(request.headers.get(ROLE_HEADER)),
              label: 'Connector route test',
            }),
      );
    },
  });
}

function parseTestRole(raw: string | null): 'owner' | 'admin' | 'builder' | 'viewer' {
  return raw === 'admin' || raw === 'builder' || raw === 'viewer' ? raw : 'owner';
}

function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    role?: 'admin' | 'builder' | 'viewer';
    principal?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.role !== undefined) headers.set(ROLE_HEADER, options.role);
  if (options.principal !== undefined) headers.set(PRINCIPAL_HEADER, options.principal);
  const contentType = options.contentType === undefined ? 'application/json' : options.contentType;
  if (contentType !== null && options.body !== undefined) headers.set('content-type', contentType);
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function bodyOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

function stdioBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    ...overrides,
  });
}

const PLAINTEXT = 'sk-ant-super-secret-do-not-leak-this-value';

function httpBodyWithCredential(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'GitHub',
    transport: 'http',
    url: 'https://api.example.test/mcp',
    authType: 'bearer',
    credential: PLAINTEXT,
    ...overrides,
  });
}

async function createIn(workspace: string, body: string = stdioBody()): Promise<ConnectorResource> {
  const response = await createRoute(request('POST', '/api/connectors', { workspace, body }));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await bodyOf(response)) as ConnectorResource;
}

describe('the connector routes serve real responses once a runtime is wired', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    // The role gate (issue #388) is wired, so this is the connectors runtime's own answer.
    useMemoryRuntime();
    clearConnectorsRuntime();
    const response = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toMatchObject({
      error: { code: 'connectors_runtime_not_configured' },
    });
  });

  it('answers 401 for a request with no workspace, once wired', async () => {
    useMemoryRuntime();
    const response = await listRoute(request('GET', '/api/connectors'));
    expect(response.status).toBe(401);
  });

  it('creates, lists, gets and deletes a connector end to end', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);
    expect(created).toMatchObject({
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      hasCredential: false,
      enabled: true,
    });

    const listed = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
    expect(listed.status).toBe(200);
    expect((await bodyOf(listed)) as { connectors: ConnectorResource[] }).toMatchObject({
      connectors: [{ id: created.id }],
    });

    const got = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(got.status).toBe(200);
    expect(await bodyOf(got)).toMatchObject({ id: created.id });

    const deleted = await deleteRoute(
      request('DELETE', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(deleted.status).toBe(204);

    const afterDelete = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(afterDelete.status).toBe(404);
  });

  it('never returns the raw credential from create, list, or get', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A, httpBodyWithCredential());
    expect(created.hasCredential).toBe(true);
    expect(JSON.stringify(created)).not.toContain(PLAINTEXT);

    const listed = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
    expect(await listed.clone().text()).not.toContain(PLAINTEXT);

    const got = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(await got.clone().text()).not.toContain(PLAINTEXT);
  });

  it('rotates a saved credential in place without returning either credential', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A, httpBodyWithCredential());
    const rotatedValue = 'rotated-secret-do-not-return';
    const rotated = await rotateRoute(
      request('PATCH', `/api/connectors/${created.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ credential: rotatedValue }),
      }),
      idContext(created.id),
    );
    expect(rotated.status).toBe(200);
    const text = await rotated.text();
    expect(text).not.toContain(PLAINTEXT);
    expect(text).not.toContain(rotatedValue);
    expect(JSON.parse(text)).toMatchObject({ id: created.id, hasCredential: true });
    expect(connectorAudits).toEqual([
      { subjectId: created.id, subjectLabel: 'GitHub' },
      { subjectId: created.id, subjectLabel: 'GitHub' },
    ]);
  });

  it('rejects credential rotation for an unauthenticated connector', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);
    const response = await rotateRoute(
      request('PATCH', `/api/connectors/${created.id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ credential: 'new-secret' }),
      }),
      idContext(created.id),
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'credential_not_configured' } });
  });

  it('rejects a duplicate name with 409', async () => {
    useMemoryRuntime();
    await createIn(WORKSPACE_A);
    const conflict = await createRoute(
      request('POST', '/api/connectors', { workspace: WORKSPACE_A, body: stdioBody() }),
    );
    expect(conflict.status).toBe(409);
  });

  it('rejects an invalid body with 400', async () => {
    useMemoryRuntime();
    const response = await createRoute(
      request('POST', '/api/connectors', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'X' }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("does not let one workspace see or delete another's connector", async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);

    const gotFromB = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_B }),
      idContext(created.id),
    );
    expect(gotFromB.status).toBe(404);

    const deletedFromB = await deleteRoute(
      request('DELETE', `/api/connectors/${created.id}`, { workspace: WORKSPACE_B }),
      idContext(created.id),
    );
    expect(deletedFromB.status).toBe(404);

    const listedByA = await listRoute(
      request('GET', '/api/connectors', { workspace: WORKSPACE_A }),
    );
    expect((await bodyOf(listedByA)) as { connectors: ConnectorResource[] }).toMatchObject({
      connectors: [{ id: created.id }],
    });
  });

  describe('Test Connection', () => {
    it('POST /api/connectors with dryRun:true needs authentication, not a store', async () => {
      const response = await createRoute(
        request('POST', '/api/connectors', {
          body: JSON.stringify({ ...JSON.parse(stdioBody()), dryRun: true }),
        }),
      );
      expect(response.status).toBe(503); // unwired
    });

    it('POST /api/connectors with dryRun:true is 401 with no workspace, once wired', async () => {
      useMemoryRuntime();
      const response = await createRoute(
        request('POST', '/api/connectors', {
          body: JSON.stringify({ ...JSON.parse(stdioBody()), dryRun: true }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('rejects a non-boolean dryRun instead of silently persisting the connector', async () => {
      useMemoryRuntime();
      const response = await createRoute(
        request('POST', '/api/connectors', {
          workspace: WORKSPACE_A,
          body: JSON.stringify({ ...JSON.parse(stdioBody()), dryRun: 'true' }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ error: { code: 'invalid_body' } });

      const listed = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
      expect((await bodyOf(listed)) as { connectors: ConnectorResource[] }).toEqual({
        connectors: [],
      });
    });

    it('POST /api/connectors with dryRun:true on stdio never spawns the command, answers the declared refusal, and creates NOTHING (ADR-0045)', async () => {
      useMemoryRuntime(() => {
        throw new Error('a dry-run probe must not request an owner identity');
      });
      const response = await createRoute(
        request('POST', '/api/connectors', {
          workspace: WORKSPACE_A,
          body: JSON.stringify({
            ...JSON.parse(stdioBody({ command: 'w2cp05-routes-test-no-such-binary' })),
            dryRun: true,
          }),
        }),
      );
      expect(response.status).toBe(200);
      // Not `command-not-found` (that would mean this route tried to spawn it and failed) —
      // `stdio-probe-unavailable`, the refusal `testConnection` returns without ever spawning
      // anything for a `stdio` config. See `docs/adr/0045-the-stdio-connector-probe-runs-in-a-sandbox-or-it-does-not-run.md`.
      expect(await bodyOf(response)).toMatchObject({ ok: false, kind: 'stdio-probe-unavailable' });

      const listed = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
      expect((await bodyOf(listed)) as { connectors: ConnectorResource[] }).toEqual({
        connectors: [],
      });
    });

    it('POST /api/connectors/:id/test-connection resolves a saved connector and never leaks its credential', async () => {
      useMemoryRuntime();
      const created = await createIn(
        WORKSPACE_A,
        httpBodyWithCredential({ url: 'http://127.0.0.1:18291/mcp' }),
      );
      const response = await testSavedRoute(
        request('POST', `/api/connectors/${created.id}/test-connection`, {
          workspace: WORKSPACE_A,
        }),
        idContext(created.id),
      );
      expect(response.status).toBe(200);
      const text = await response.clone().text();
      expect(text).not.toContain(PLAINTEXT);
      const outcome = (await bodyOf(response)) as { ok: boolean; kind: string };
      expect(outcome.ok).toBe(false); // nothing is actually listening at that URL
    });

    it('POST /api/connectors/:id/test-connection is 404 for an unknown id', async () => {
      useMemoryRuntime();
      const response = await testSavedRoute(
        request('POST', '/api/connectors/99999999-9999-4999-8999-999999999999/test-connection', {
          workspace: WORKSPACE_A,
        }),
        idContext('99999999-9999-4999-8999-999999999999'),
      );
      expect(response.status).toBe(404);
    });
  });
});

describe('PATCH /api/connectors/:id as a field update (#240, S-20)', () => {
  function patch(
    id: string,
    body: unknown,
    options: { workspace?: string; role?: 'admin' | 'builder' | 'viewer'; principal?: string } = {},
  ): Promise<Response> {
    return rotateRoute(
      request('PATCH', `/api/connectors/${id}`, {
        workspace: options.workspace ?? WORKSPACE_A,
        body: JSON.stringify(body),
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.principal === undefined ? {} : { principal: options.principal }),
      }),
      idContext(id),
    );
  }

  it('updates name, enabled and url, and never returns the credential', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A, httpBodyWithCredential());
    const response = await patch(created.id, {
      name: 'GitHub (renamed)',
      enabled: false,
      url: 'https://api.example.test/mcp/v2',
      credential: `${PLAINTEXT}-for-v2`,
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(PLAINTEXT);
    expect(JSON.parse(text)).toMatchObject({
      id: created.id,
      name: 'GitHub (renamed)',
      enabled: false,
      url: 'https://api.example.test/mcp/v2',
      authType: 'bearer',
      hasCredential: true,
      ownerPrincipalId: created.ownerPrincipalId,
    });
  });

  describe('a saved credential never follows a retarget (409 credential_required_on_retarget)', () => {
    async function probeUrl(id: string): Promise<string | null> {
      const got = await getRoute(
        request('GET', `/api/connectors/${id}`, { workspace: WORKSPACE_A }),
        idContext(id),
      );
      return ((await bodyOf(got)) as ConnectorResource).url;
    }

    it("refuses an Admin who moves a Builder's credentialed connector without a new credential", async () => {
      useMemoryRuntime();
      const builders = await createIn(WORKSPACE_A, httpBodyWithCredential());
      const asAdmin = { role: 'admin', principal: ADMIN_PRINCIPAL } as const;

      const moved = await patch(builders.id, { url: 'https://attacker.example.test/mcp' }, asAdmin);
      expect(moved.status).toBe(409);
      const text = await moved.text();
      expect(text).not.toContain(PLAINTEXT);
      expect(JSON.parse(text)).toMatchObject({
        error: { code: 'credential_required_on_retarget', message: expect.any(String) as unknown },
      });
      // Nothing landed: not the url, and not a rename sent in the same body.
      const renamedAndMoved = await patch(
        builders.id,
        { name: 'Renamed', url: 'https://attacker.example.test/mcp' },
        asAdmin,
      );
      expect(renamedAndMoved.status).toBe(409);
      expect(await probeUrl(builders.id)).toBe('https://api.example.test/mcp');
    });

    it('refuses a stdio command or args change that would hand the credential to a new process', async () => {
      useMemoryRuntime();
      const builders = await createIn(
        WORKSPACE_A,
        stdioBody({ authType: 'api-key', credential: PLAINTEXT }),
      );
      const asAdmin = { role: 'admin', principal: ADMIN_PRINCIPAL } as const;
      for (const body of [
        { command: 'node' },
        { args: ['./exfiltrate.js'] },
        { args: null },
        { authType: 'bearer', command: 'node' },
      ]) {
        const response = await patch(builders.id, body, asAdmin);
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(await bodyOf(response)).toMatchObject({
          error: { code: 'credential_required_on_retarget' },
        });
      }
      // An unchanged value is not a retarget.
      const same = await patch(builders.id, { command: 'npx', enabled: false }, asAdmin);
      expect(same.status).toBe(200);
    });

    it('lets the retarget through when the same body carries the new credential', async () => {
      useMemoryRuntime();
      const builders = await createIn(WORKSPACE_A, httpBodyWithCredential());
      const response = await patch(
        builders.id,
        { url: 'https://api.example.test/mcp/v2', credential: 'sk-admin-supplied-credential' },
        { role: 'admin', principal: ADMIN_PRINCIPAL },
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('sk-admin-supplied-credential');
      expect(JSON.parse(text)).toMatchObject({
        url: 'https://api.example.test/mcp/v2',
        hasCredential: true,
        ownerPrincipalId: builders.ownerPrincipalId,
      });
    });

    it('lets the retarget through when authType drops the credential, or there is none', async () => {
      useMemoryRuntime();
      const credentialed = await createIn(WORKSPACE_A, httpBodyWithCredential());
      const dropped = await patch(
        credentialed.id,
        { url: 'https://other.example.test/mcp', authType: 'none' },
        { role: 'admin', principal: ADMIN_PRINCIPAL },
      );
      expect(dropped.status).toBe(200);
      expect(await bodyOf(dropped)).toMatchObject({ authType: 'none', hasCredential: false });

      const plain = await createIn(WORKSPACE_A, stdioBody({ name: 'Plain' }));
      const moved = await patch(
        plain.id,
        { command: 'node', args: ['server.js'] },
        { role: 'admin', principal: ADMIN_PRINCIPAL },
      );
      expect(moved.status).toBe(200);
      expect(await bodyOf(moved)).toMatchObject({ command: 'node', args: ['server.js'] });
    });
  });

  it('refuses a body that tries to move the owner or change the transport', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);
    for (const body of [
      { ownerPrincipalId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
      { name: 'x', createdBy: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { transport: 'http' },
      {},
    ]) {
      const response = await patch(created.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ error: { code: 'invalid_body' } });
    }
    const got = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(await bodyOf(got)).toMatchObject({
      ownerPrincipalId: created.ownerPrincipalId,
      transport: 'stdio',
    });
  });

  it("refuses the other transport's fields", async () => {
    useMemoryRuntime();
    const stdio = await createIn(WORKSPACE_A);
    const remote = await createIn(WORKSPACE_A, httpBodyWithCredential());
    expect((await patch(stdio.id, { url: 'https://x.example.test' })).status).toBe(400);
    expect((await patch(remote.id, { command: 'node' })).status).toBe(400);
    expect((await patch(remote.id, { args: ['--x'] })).status).toBe(400);
    const updated = await patch(stdio.id, { command: 'node', args: null });
    expect(await bodyOf(updated)).toMatchObject({ command: 'node', args: null });
  });

  it('adds and drops a credential with authType, and requires one to add it', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);
    const missing = await patch(created.id, { authType: 'api-key' });
    expect(missing.status).toBe(400);

    const added = await patch(created.id, { authType: 'api-key', credential: PLAINTEXT });
    expect(added.status).toBe(200);
    const addedText = await added.text();
    expect(addedText).not.toContain(PLAINTEXT);
    expect(JSON.parse(addedText)).toMatchObject({ authType: 'api-key', hasCredential: true });

    const refused = await patch(created.id, { authType: 'none', credential: 'x' });
    expect(refused.status).toBe(400);
    const dropped = await patch(created.id, { authType: 'none' });
    expect(await bodyOf(dropped)).toMatchObject({ authType: 'none', hasCredential: false });

    const rotateOnNone = await patch(created.id, { credential: 'x', name: 'Filesystem 2' });
    expect(rotateOnNone.status).toBe(409);
    expect(await bodyOf(rotateOnNone)).toMatchObject({
      error: { code: 'credential_not_configured' },
    });
  });

  it('answers 409 connector_name_conflict for a taken name', async () => {
    useMemoryRuntime();
    await createIn(WORKSPACE_A);
    const second = await createIn(WORKSPACE_A, httpBodyWithCredential());
    const response = await patch(second.id, { name: 'Filesystem' });
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({ error: { code: 'connector_name_conflict' } });
  });

  it('is 404 for another workspace and 403 for a Viewer', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A);
    const foreign = await patch(created.id, { enabled: false }, { workspace: WORKSPACE_B });
    expect(foreign.status).toBe(404);
    expect(await bodyOf(foreign)).toMatchObject({ error: { code: 'connector_not_found' } });
    const viewer = await patch(created.id, { enabled: false }, { role: 'viewer' });
    expect(viewer.status).toBe(403);
    const got = await getRoute(
      request('GET', `/api/connectors/${created.id}`, { workspace: WORKSPACE_A }),
      idContext(created.id),
    );
    expect(await bodyOf(got)).toMatchObject({ enabled: true });
  });
});

// Issue #388: the collection routes used to consult only the workspace resolver, so a Viewer —
// whom §21 gives no connector access at all — could list and create connectors. They are gated by
// the shared decision table now, as the `:id` routes already were; a Builder keeps "read any,
// write own".
describe('the connectors collection is gated by the role table', () => {
  it('refuses a viewer on list and create with 403, and creates nothing', async () => {
    useMemoryRuntime();
    await createIn(WORKSPACE_A);

    const list = await listRoute(
      request('GET', '/api/connectors', { workspace: WORKSPACE_A, role: 'viewer' }),
    );
    const create = await createRoute(
      request('POST', '/api/connectors', {
        workspace: WORKSPACE_A,
        role: 'viewer',
        body: stdioBody({ name: 'Smuggled' }),
      }),
    );
    for (const response of [list, create]) {
      expect(response.status).toBe(403);
      expect(await bodyOf(response)).toMatchObject({ error: { code: 'forbidden' } });
    }

    const owner = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
    const body = (await bodyOf(owner)) as { connectors: ConnectorResource[] };
    expect(body.connectors.map((connector) => connector.name)).toEqual(['Filesystem']);
  });

  it('lets a builder list and create', async () => {
    useMemoryRuntime();
    const list = await listRoute(
      request('GET', '/api/connectors', { workspace: WORKSPACE_A, role: 'builder' }),
    );
    expect(list.status).toBe(200);
    const create = await createRoute(
      request('POST', '/api/connectors', {
        workspace: WORKSPACE_A,
        role: 'builder',
        body: stdioBody({ name: 'Builder-owned' }),
      }),
    );
    expect(create.status, await create.clone().text()).toBe(201);
  });
});

describe('the tool connector kinds through the routes (ADR-0113 C15)', () => {
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

  it('creates, lists, gets, patches and deletes both kinds, never returning the credential', async () => {
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
  });

  it('records no audit event for a PATCH dry run and changes nothing', async () => {
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
  });

  describe('the stored OpenAPI document', () => {
    const SPEC_SENTINEL = 'spec-text-sentinel-never-in-a-resource';
    const sentinelDocument = (marker: string): string =>
      JSON.stringify({
        ...(JSON.parse(document) as Record<string, unknown>),
        info: { title: 'Pets', version: '1', description: marker },
      });
    const documentOf = (id: string): Promise<string | null> =>
      memoryConnectors.forWorkspace(WORKSPACE_A).openapiDocument(id);

    it('is kept verbatim, never returned, and each write records one audit event', async () => {
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
    });

    it('has no document for a postgres connector, and reads as absent across workspaces', async () => {
      useMemoryRuntime();
      const pg = await createIn(WORKSPACE_A, postgresBody());
      expect(await documentOf(pg.id)).toBeNull();
      const created = await createIn(WORKSPACE_A, openapiBody({ name: 'other' }));
      expect(
        await memoryConnectors.forWorkspace(WORKSPACE_B).openapiDocument(created.id),
      ).toBeNull();
    });

    it('is untouched by a Viewer create and by a Builder replacing another principal connector', async () => {
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
    });
  });

  it('refuses a name an MCP connector holds with 409', async () => {
    useMemoryRuntime();
    await createIn(WORKSPACE_A, stdioBody({ name: 'shared' }));
    const conflict = await createRoute(
      request('POST', '/api/connectors', {
        workspace: WORKSPACE_A,
        body: openapiBody({ name: 'shared' }),
      }),
    );
    expect(conflict.status).toBe(409);
  });

  it('applies the 2 MiB cap to openapi only: mcp and postgres bodies over 64 KiB get 413', async () => {
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
  });
});
