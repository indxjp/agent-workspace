import { describe, expect, it } from 'vitest';
import {
  GET as getProfileRoute,
  PATCH as patchProfileRoute,
} from '../../app/api/runtime-profiles/[id]/route';
import { POST as createProfileRoute } from '../../app/api/runtime-profiles/route';
import {
  CREATE_BODY,
  idContext,
  request,
  useAzurePoolRegistry,
  useMemoryRuntime,
  WORKSPACE_A,
  WORKSPACE_B,
} from './runtime-routes.test-support';

const acaBody = (networkPolicy: string) =>
  JSON.stringify({
    name: 'aca-sessions default',
    driver: 'aca-sessions',
    networkPolicy,
    filesystem: 'read-write',
  });

async function createAcaProfile(): Promise<string> {
  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: acaBody('open') }),
  );
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

describe('/api/runtime-profiles — a policy the driver cannot enforce here', () => {
  it(
    'refuses a PATCH that would overwrite the pool-wide policy with none',
    refusesPATCHThatWouldOverwritePoolWidePolicy,
  );

  it(
    'leaves the stored profile running the policy the pool enforces',
    leavesStoredProfileRunningPolicyPoolEnforces,
  );

  it(
    'refuses the same policy at creation, before an unrunnable profile exists',
    refusesSamePolicyAtCreationBeforeUnrunnableProfile,
  );

  it(
    'refuses a driver-only PATCH that would pair the pool with a stored policy it cannot enforce',
    refusesDriverOnlyPATCHThatWouldPairPool,
  );

  it(
    'still accepts the same body for a driver the registry does not restrict',
    stillAcceptsSameBodyDriverRegistryDoesNot,
  );

  it(
    'answers 404 for a profile this workspace does not have, never a policy refusal',
    answers404ProfileThisWorkspaceDoesNotHave,
  );
});

async function refusesDriverOnlyPATCHThatWouldPairPool() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        name: 'Offline',
        driver: 'docker',
        networkPolicy: 'none',
        filesystem: 'read-write',
      }),
    }),
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const response = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ driver: 'aca-sessions' }),
    }),
    idContext(id),
  );
  expect(response.status).toBe(422);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'network_policy_not_enforceable',
  );

  const stored = await getProfileRoute(
    request('GET', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  const row = (await stored.json()) as { driver: string; networkPolicy: string };
  expect(row.driver).toBe('docker');
  expect(row.networkPolicy).toBe('none');
}

async function stillAcceptsSameBodyDriverRegistryDoesNot() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const created = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  const { id } = (await created.json()) as { id: string };

  const response = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ networkPolicy: 'none' }),
    }),
    idContext(id),
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as { networkPolicy: string }).networkPolicy).toBe('none');
}

async function refusesPATCHThatWouldOverwritePoolWidePolicy() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const id = await createAcaProfile();

  const response = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ networkPolicy: 'none' }),
    }),
    idContext(id),
  );

  expect(response.status).toBe(422);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('network_policy_not_enforceable');
  expect(body.error.message).toContain('aca-sessions');
  expect(body.error.message).toContain('"open"');
}

async function leavesStoredProfileRunningPolicyPoolEnforces() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const id = await createAcaProfile();
  await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ networkPolicy: 'none' }),
    }),
    idContext(id),
  );

  const stored = await getProfileRoute(
    request('GET', `/api/runtime-profiles/${id}`, { workspace: WORKSPACE_A }),
    idContext(id),
  );
  expect(((await stored.json()) as { networkPolicy: string }).networkPolicy).toBe('open');
}

async function refusesSamePolicyAtCreationBeforeUnrunnableProfile() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: acaBody('none') }),
  );
  expect(response.status).toBe(422);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'network_policy_not_enforceable',
  );
}

async function answers404ProfileThisWorkspaceDoesNotHave() {
  useMemoryRuntime();
  useAzurePoolRegistry();
  const id = await createAcaProfile();

  const response = await patchProfileRoute(
    request('PATCH', `/api/runtime-profiles/${id}`, {
      workspace: WORKSPACE_B,
      body: JSON.stringify({ networkPolicy: 'none' }),
    }),
    idContext(id),
  );
  expect(response.status).toBe(404);
}
