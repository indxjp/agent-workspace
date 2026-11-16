import { describe, expect, it } from 'vitest';
import { GET as getRoute, PATCH as rotateRoute } from '../../app/api/connectors/[id]/route';
import {
  ADMIN_PRINCIPAL,
  PLAINTEXT,
  WORKSPACE_A,
  WORKSPACE_B,
  bodyOf,
  createIn,
  httpBodyWithCredential,
  idContext,
  request,
  stdioBody,
  useMemoryRuntime,
} from './connector-routes.test-support';
import type { ConnectorResource } from './contract';

describe('PATCH /api/connectors/:id as a field update (#240, S-20)', () => {
  it(
    'updates name, enabled and url, and never returns the credential',
    updatesNameEnabledUrlNeverReturnsCredential,
  );

  describe('a saved credential never follows a retarget (409 credential_required_on_retarget)', () => {
    it(
      "refuses an Admin who moves a Builder's credentialed connector without a new credential",
      refusesAdminWhoMovesBuilderSCredentialedConnector,
    );

    it(
      'refuses a stdio command or args change that would hand the credential to a new process',
      refusesStdioCommandArgsChangeThatWouldHand,
    );

    it(
      'lets the retarget through when the same body carries the new credential',
      letsRetargetWhenSameBodyCarriesNewCredential,
    );

    it(
      'lets the retarget through when authType drops the credential, or there is none',
      letsRetargetWhenAuthTypeDropsCredentialThereIs,
    );
  });

  it(
    'refuses a body that tries to move the owner or change the transport',
    refusesBodyThatTriesMoveOwnerChangeTransport,
  );

  it("refuses the other transport's fields", refusesOtherTransportSFields);

  it(
    'adds and drops a credential with authType, and requires one to add it',
    addsDropsCredentialAuthTypeRequiresOneAddIt,
  );

  it(
    'answers 409 connector_name_conflict for a taken name',
    answers409ConnectorNameConflictTakenName,
  );

  it('is 404 for another workspace and 403 for a Viewer', is404AnotherWorkspace403Viewer);
});

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

async function probeUrl(id: string): Promise<string | null> {
  const got = await getRoute(
    request('GET', `/api/connectors/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  return ((await bodyOf(got)) as ConnectorResource).url;
}

async function updatesNameEnabledUrlNeverReturnsCredential() {
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
}

async function refusesAdminWhoMovesBuilderSCredentialedConnector() {
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
}

async function refusesStdioCommandArgsChangeThatWouldHand() {
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
}

async function letsRetargetWhenSameBodyCarriesNewCredential() {
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
}

async function letsRetargetWhenAuthTypeDropsCredentialThereIs() {
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
}

async function refusesBodyThatTriesMoveOwnerChangeTransport() {
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
}

async function refusesOtherTransportSFields() {
  useMemoryRuntime();
  const stdio = await createIn(WORKSPACE_A);
  const remote = await createIn(WORKSPACE_A, httpBodyWithCredential());
  expect((await patch(stdio.id, { url: 'https://x.example.test' })).status).toBe(400);
  expect((await patch(remote.id, { command: 'node' })).status).toBe(400);
  expect((await patch(remote.id, { args: ['--x'] })).status).toBe(400);
  const updated = await patch(stdio.id, { command: 'node', args: null });
  expect(await bodyOf(updated)).toMatchObject({ command: 'node', args: null });
}

async function addsDropsCredentialAuthTypeRequiresOneAddIt() {
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
}

async function answers409ConnectorNameConflictTakenName() {
  useMemoryRuntime();
  await createIn(WORKSPACE_A);
  const second = await createIn(WORKSPACE_A, httpBodyWithCredential());
  const response = await patch(second.id, { name: 'Filesystem' });
  expect(response.status).toBe(409);
  expect(await bodyOf(response)).toMatchObject({ error: { code: 'connector_name_conflict' } });
}

async function is404AnotherWorkspace403Viewer() {
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
}
