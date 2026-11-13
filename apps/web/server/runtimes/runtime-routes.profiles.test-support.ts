import { afterEach, describe, expect, it } from 'vitest';
import {
  DELETE as deleteProfileRoute,
  GET as getProfileRoute,
  PATCH as patchProfileRoute,
} from '../../app/api/runtime-profiles/[id]/route';
import {
  POST as createProfileRoute,
  GET as listProfilesRoute,
} from '../../app/api/runtime-profiles/route';
import { clearApplicationContext } from '../application-context';
import {
  CREATE_BODY,
  idContext,
  request,
  useMemoryRuntime,
  WORKSPACE_A,
  WORKSPACE_B,
} from './runtime-routes.test-support';

describe('/api/runtime-profiles — configured', () => {
  afterEach(() => clearApplicationContext());

  it(
    '401s with no workspace header, and never leaks whether a store exists',
    checks401sNoWorkspaceHeaderNeverLeaksWhetherStore,
  );

  it('creates a profile and returns it with a generated id', createsProfileReturnsItGeneratedId);

  it(
    'accepts allowedDomains: null, the value a profile reads back (BH061-080)',
    acceptsAllowedDomainsNullValueProfileReadsBackBH061,
  );

  it(
    'rejects a body with an unknown driver, naming the field',
    rejectsBodyUnknownDriverNamingField,
  );

  // ADR-0088 D2: a Builder reads every profile, so a credential must not hide in driverConfig.
  it(
    'refuses a credential-looking driverConfig key on create and patch, naming it',
    refusesCredentialLookingDriverConfigKeyCreatePatchNaming,
  );

  // FX-4: a persist path the launcher would refuse after the run is refused when it is stored.
  it(
    'refuses a persistPaths entry outside the workspace on create and patch, naming its index',
    refusesPersistPathsEntryOutsideWorkspaceCreatePatchNaming,
  );

  it(
    'accepts settings and secret references whose names only contain a credential word',
    acceptsSettingsSecretReferencesWhoseNamesOnlyContain,
  );

  it(
    'refuses a driverConfig nested deeper than 32 levels with 400, not 500',
    refusesDriverConfigNestedDeeperThan32Levels400,
  );

  it(
    'refuses a second profile with the same name in the same workspace',
    refusesSecondProfileSameNameSameWorkspace,
  );

  it("lists only the caller's workspace's profiles", listsOnlyCallerSWorkspaceSProfiles);

  it(
    'reads, updates and deletes a profile — and another workspace never sees it (§25)',
    readsUpdatesDeletesProfileAnotherWorkspaceNeverSees,
  );

  it(
    '404s a non-UUID id as invalid rather than not-found, and a well-formed unknown id as not-found',
    checks404sNonUUIDIdInvalidRatherThanNot,
  );
});

async function checks401sNoWorkspaceHeaderNeverLeaksWhetherStore() {
  useMemoryRuntime();
  const response = await listProfilesRoute(request('GET', '/api/runtime-profiles'));
  expect(response.status).toBe(401);
}

async function createsProfileReturnsItGeneratedId() {
  useMemoryRuntime();
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; name: string; driver: string };
  expect(body.name).toBe('Standard');
  expect(body.driver).toBe('docker');
  expect(typeof body.id).toBe('string');
}

async function acceptsAllowedDomainsNullValueProfileReadsBackBH061() {
  useMemoryRuntime();
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), allowedDomains: null }),
    }),
  );
  expect(response.status).toBe(201);
  expect(((await response.json()) as { allowedDomains: unknown }).allowedDomains).toBeNull();
}

async function rejectsBodyUnknownDriverNamingField() {
  useMemoryRuntime();
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), driver: 'my-cloud' }),
    }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { code: string; details?: string[] } };
  expect(body.error.code).toBe('invalid_body');
  expect(body.error.details?.some((d) => d.includes('driver'))).toBe(true);
}

async function refusesCredentialLookingDriverConfigKeyCreatePatchNaming() {
  useMemoryRuntime();
  const refused = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        ...JSON.parse(CREATE_BODY),
        driverConfig: { registry: { host: 'registry.example', API_Key: 'k' } },
      }),
    }),
  );
  expect(refused.status).toBe(400);
  const refusal = (await refused.json()) as { error: { code: string; details?: string[] } };
  expect(refusal.error.code).toBe('invalid_body');
  expect(refusal.error.details).toEqual([
    'driverConfig.registry.API_Key: driverConfig must not carry credentials; store them on a ' +
      'runtime connection and reference it with runtimeConnectionId',
  ]);

  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), driverConfig: { region: 'eu' } }),
    }),
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  for (const key of [
    'clientSecret',
    'password',
    'auth_token',
    'privateKey',
    'APIKey',
    'access-key-id',
    'connectionString',
    'sasToken',
    'secrets',
    // Digit-suffixed and digit-separated words.
    'APIKey2',
    'token2',
    'webhookSecret2',
    'oauth2token',
    // Run-together lowercase keys.
    'dbpassword',
    'adminpassword',
    'apitoken',
    'githubtoken',
    'secretkey',
    'accesskeyid',
    'cookie',
    'sessionCookie',
    // Plurals of the credential pairs.
    'apiKeys',
    'api_keys',
    'accessKeys',
    'privateKeys',
    'authTokens',
    'accessTokens',
  ]) {
    const patched = await patchProfileRoute(
      request('PATCH', `/api/runtime-profiles/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ driverConfig: { pools: [{ [key]: 'x' }] } }),
      }),
      idContext(id),
    );
    expect(patched.status, key).toBe(400);
    const body = (await patched.json()) as { error: { details?: string[] } };
    expect(body.error.details?.[0]?.startsWith(`driverConfig.pools.0.${key}: `), key).toBe(true);
  }
}

async function refusesPersistPathsEntryOutsideWorkspaceCreatePatchNaming() {
  useMemoryRuntime();
  const refused = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), persistPaths: ['out', '../etc'] }),
    }),
  );
  expect(refused.status).toBe(400);
  const refusal = (await refused.json()) as { error: { code: string; details?: string[] } };
  expect(refusal.error.code).toBe('invalid_body');
  expect(refusal.error.details).toEqual([
    'persistPaths.1: must be a relative path inside the workspace',
  ]);

  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), persistPaths: ['/workspace/out'] }),
    }),
  );
  expect(created.status, await created.clone().text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const patched = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ persistPaths: ['/etc/passwd'] }),
    }),
    idContext(id),
  );
  expect(patched.status).toBe(400);
  const body = (await patched.json()) as { error: { details?: string[] } };
  expect(body.error.details).toEqual([
    'persistPaths.0: must be a relative path inside the workspace',
  ]);
}

async function acceptsSettingsSecretReferencesWhoseNamesOnlyContain() {
  useMemoryRuntime();
  const driverConfig = {
    tokenizer: 'cl100k',
    maxTokens: 4096,
    passwordless: true,
    secretName: 'registry-credentials',
    secretRef: { name: 'pull', key: 'dockerconfigjson' },
    tokenRefs: ['a', 'b'],
    imagePullSecrets: [{ name: 'registry' }],
  };
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), driverConfig }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

async function refusesDriverConfigNestedDeeperThan32Levels400() {
  useMemoryRuntime();
  let driverConfig: Record<string, unknown> = { leaf: true };
  for (let level = 0; level < 40; level += 1) driverConfig = { nested: driverConfig };
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ ...JSON.parse(CREATE_BODY), driverConfig }),
    }),
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { details?: string[] } };
  expect(body.error.details).toEqual([
    'driverConfig: nests deeper than 32 levels, which is refused',
  ]);
}

async function refusesSecondProfileSameNameSameWorkspace() {
  useMemoryRuntime();
  await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  expect(response.status).toBe(409);
}

async function listsOnlyCallerSWorkspaceSProfiles() {
  useMemoryRuntime();
  await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  const responseA = await listProfilesRoute(
    request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A }),
  );
  const responseB = await listProfilesRoute(
    request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_B }),
  );
  const bodyA = (await responseA.json()) as { runtimeProfiles: unknown[] };
  const bodyB = (await responseB.json()) as { runtimeProfiles: unknown[] };
  expect(bodyA.runtimeProfiles).toHaveLength(1);
  expect(bodyB.runtimeProfiles).toHaveLength(0);
}

async function readsUpdatesDeletesProfileAnotherWorkspaceNeverSees() {
  useMemoryRuntime();
  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  const { id } = (await created.json()) as { id: string };

  const getA = await getProfileRoute(
    request('GET', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  expect(getA.status).toBe(200);

  const getB = await getProfileRoute(
    request('GET', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_B }),
    idContext(id),
  );
  expect(getB.status).toBe(404);

  const patched = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ cpu: 4 }),
    }),
    idContext(id),
  );
  expect(patched.status).toBe(200);
  const patchedBody = (await patched.json()) as { cpu: number };
  expect(patchedBody.cpu).toBe(4);

  const deletedFromB = await deleteProfileRoute(
    request('DELETE', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_B }),
    idContext(id),
  );
  expect(deletedFromB.status).toBe(404);

  const deleted = await deleteProfileRoute(
    request('DELETE', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  expect(deleted.status).toBe(204);

  const goneAgain = await deleteProfileRoute(
    request('DELETE', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  expect(goneAgain.status).toBe(404);
}

async function checks404sNonUUIDIdInvalidRatherThanNot() {
  useMemoryRuntime();
  const badId = await getProfileRoute(
    request('GET', '/api/runtime-profiles/not-a-uuid', { workspace: WORKSPACE_A }),
    idContext('not-a-uuid'),
  );
  expect(badId.status).toBe(400);

  const unknownId = await getProfileRoute(
    request('GET', '/api/runtime-profiles/99999999-9999-4999-8999-999999999999', {
      workspace: WORKSPACE_A,
    }),
    idContext('99999999-9999-4999-8999-999999999999'),
  );
  expect(unknownId.status).toBe(404);
}
