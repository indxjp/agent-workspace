import type { DatabaseRoot } from '@agent-workspace/core/db';
import { describe, expect, it } from 'vitest';
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as rotateRoute,
} from '../../app/api/connectors/[id]/route';
import { POST as testSavedRoute } from '../../app/api/connectors/[id]/test-connection/route';
import { POST as createRoute, GET as listRoute } from '../../app/api/connectors/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installConnectorsApi } from '../composition/services';
import {
  PLAINTEXT,
  WORKSPACE_A,
  WORKSPACE_B,
  bodyOf,
  connectorAudits,
  createIn,
  httpBodyWithCredential,
  idContext,
  request,
  stdioBody,
  useMemoryRuntime,
} from './connector-routes.test-support';
import type { ConnectorResource } from './contract';

describe('the connector routes serve real responses once a runtime is wired', () => {
  it(
    'answers 503, not 401 and not an empty 200, while nothing is wired',
    answers503Not401NotEmpty200While,
  );

  it(
    'answers the same 503 while connectors are unavailable',
    answersSame503WhileConnectorsAreUnavailable,
  );

  it(
    'builds no connectors runtime without the encrypted secrets service',
    buildsNoConnectorsRuntimeWithoutEncryptedSecretsService,
  );

  it(
    'answers 401 for a request with no workspace, once wired',
    answers401RequestNoWorkspaceOnceWired,
  );

  it(
    'creates, lists, gets and deletes a connector end to end',
    createsListsGetsDeletesConnectorEndEnd,
  );

  it(
    'never returns the raw credential from create, list, or get',
    neverReturnsRawCredentialCreateListGet,
  );

  it(
    'rotates a saved credential in place without returning either credential',
    rotatesSavedCredentialPlaceWithoutReturningEitherCredential,
  );

  it(
    'rejects credential rotation for an unauthenticated connector',
    rejectsCredentialRotationUnauthenticatedConnector,
  );

  it('rejects a duplicate name with 409', rejectsDuplicateName409);

  it('rejects an invalid body with 400', rejectsInvalidBody400);

  it(
    "does not let one workspace see or delete another's connector",
    doesNotLetOneWorkspaceSeeDeleteAnother,
  );

  describe('Test Connection', () => {
    it(
      'POST /api/connectors with dryRun:true needs authentication, not a store',
      postApiConnectorsDryRunTrueNeedsAuthenticationNot,
    );

    it(
      'POST /api/connectors with dryRun:true is 401 with no workspace, once wired',
      postApiConnectorsDryRunTrueIs401No,
    );

    it(
      'rejects a non-boolean dryRun instead of silently persisting the connector',
      rejectsNonBooleanDryRunInsteadSilentlyPersistingConnector,
    );

    it(
      'POST /api/connectors with dryRun:true on stdio never spawns the command, answers the declared refusal, and creates NOTHING (ADR-0045)',
      postApiConnectorsDryRunTrueStdioNeverSpawns,
    );

    it(
      'POST /api/connectors/:id/test-connection resolves a saved connector and never leaks its credential',
      postApiConnectorsIdTestConnectionResolvesSaved,
    );

    it(
      'POST /api/connectors/:id/test-connection is 404 for an unknown id',
      postApiConnectorsIdTestConnectionIs404,
    );
  });
});

async function answers503Not401NotEmpty200While() {
  // The role gate (issue #388) lives in the same context, so with none installed it answers
  // first; the connectors runtime's own answer is the `unavailable` case below.
  useMemoryRuntime();
  clearApplicationContext();
  const response = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  expect(response.status).toBe(503);
  expect(await bodyOf(response)).toMatchObject({
    error: { code: 'rbac_runtime_not_configured' },
  });
}

async function answersSame503WhileConnectorsAreUnavailable() {
  useMemoryRuntime();
  installTestDomains({ connectors: { kind: 'unavailable' } });
  const response = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  expect(response.status).toBe(503);
  expect(await bodyOf(response)).toMatchObject({
    error: { code: 'connectors_runtime_not_configured' },
  });
}

async function buildsNoConnectorsRuntimeWithoutEncryptedSecretsService() {
  const connectors = await installConnectorsApi(
    () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
    () => Promise.resolve(null),
    {} as unknown as DatabaseRoot,
    null,
  );
  expect(connectors).toEqual({ kind: 'unavailable' });
}

async function answers401RequestNoWorkspaceOnceWired() {
  useMemoryRuntime();
  const response = await listRoute(request('GET', '/api/connectors'));
  expect(response.status).toBe(401);
}

async function createsListsGetsDeletesConnectorEndEnd() {
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
}

async function neverReturnsRawCredentialCreateListGet() {
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
}

async function rotatesSavedCredentialPlaceWithoutReturningEitherCredential() {
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
}

async function rejectsCredentialRotationUnauthenticatedConnector() {
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
}

async function rejectsDuplicateName409() {
  useMemoryRuntime();
  await createIn(WORKSPACE_A);
  const conflict = await createRoute(
    request('POST', '/api/connectors', { workspace: WORKSPACE_A, body: stdioBody() }),
  );
  expect(conflict.status).toBe(409);
}

async function rejectsInvalidBody400() {
  useMemoryRuntime();
  const response = await createRoute(
    request('POST', '/api/connectors', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ name: 'X' }),
    }),
  );
  expect(response.status).toBe(400);
}

async function doesNotLetOneWorkspaceSeeDeleteAnother() {
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

  const listedByA = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
  expect((await bodyOf(listedByA)) as { connectors: ConnectorResource[] }).toMatchObject({
    connectors: [{ id: created.id }],
  });
}

async function postApiConnectorsDryRunTrueNeedsAuthenticationNot() {
  const response = await createRoute(
    request('POST', '/api/connectors', {
      body: JSON.stringify({ ...JSON.parse(stdioBody()), dryRun: true }),
    }),
  );
  expect(response.status).toBe(503); // unwired
}

async function postApiConnectorsDryRunTrueIs401No() {
  useMemoryRuntime();
  const response = await createRoute(
    request('POST', '/api/connectors', {
      body: JSON.stringify({ ...JSON.parse(stdioBody()), dryRun: true }),
    }),
  );
  expect(response.status).toBe(401);
}

async function rejectsNonBooleanDryRunInsteadSilentlyPersistingConnector() {
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
}

async function postApiConnectorsDryRunTrueStdioNeverSpawns() {
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
}

async function postApiConnectorsIdTestConnectionResolvesSaved() {
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
}

async function postApiConnectorsIdTestConnectionIs404() {
  useMemoryRuntime();
  const response = await testSavedRoute(
    request('POST', '/api/connectors/99999999-9999-4999-8999-999999999999/test-connection', {
      workspace: WORKSPACE_A,
    }),
    idContext('99999999-9999-4999-8999-999999999999'),
  );
  expect(response.status).toBe(404);
}
