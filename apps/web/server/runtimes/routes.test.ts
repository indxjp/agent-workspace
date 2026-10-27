/**
 * The runtime-profile and runtime-connection route handlers, imported as Next.js will import them
 * and driven with real `Request` objects. Copies `apps/web/server/agents/routes.test.ts`'s shape
 * and reasoning exactly — see that file's header for why a route file must be exercised directly
 * rather than trusted from its handler's own unit tests, and why the test-only resolver reading a
 * header is the strongest attacker position a cross-workspace assertion can be given.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GET as listProfilesRoute,
  POST as createProfileRoute,
} from '../../app/api/runtime-profiles/route';
import {
  DELETE as deleteProfileRoute,
  GET as getProfileRoute,
  PATCH as patchProfileRoute,
} from '../../app/api/runtime-profiles/[id]/route';
import {
  GET as listConnectionsRoute,
  POST as createConnectionRoute,
} from '../../app/api/runtime-connections/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { installRuntimesApi } from '../composition/services';
import { installWorkspaceHeaderRbac, TEST_ROLE_HEADER } from '../rbac/testing';
import { createInMemoryRuntimeConnectionStoreProvider } from './connections';
import { createInMemoryRuntimeProfileStoreProvider } from './memory-store';
import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  createWebRuntimeRegistry,
} from './registry';
import type { WorkspaceResolution } from './runtime';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const WORKSPACE_HEADER = 'x-test-workspace';

afterEach(() => {
  clearApplicationContext();
  clearWebRuntimeRegistry();
});

type TestRole = 'owner' | 'admin' | 'builder' | 'viewer';

function useMemoryRuntime(): void {
  // Every route here is gated by the shared decision table (issue #388): §21 grants runtimes to
  // Owner and Admin, and a Builder reads profiles only (ADR-0088). The identity reads the same
  // header the workspace resolver does.
  installWorkspaceHeaderRbac(WORKSPACE_HEADER);
  installTestDomains({
    runtimes: {
      kind: 'serving',
      runtime: {
        profiles: createInMemoryRuntimeProfileStoreProvider(),
        connections: createInMemoryRuntimeConnectionStoreProvider(),
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
}

/**
 * Install a registry whose ACA row reports the one policy an egress-enabled pool can enforce, the
 * shape `installDriverRegistry` builds on an Azure preview. Docker is registered beside it with no
 * restriction, so the same body can be shown to differ only by the driver it names.
 */
function useAzurePoolRegistry(): void {
  configureWebRuntimeRegistry(
    createWebRuntimeRegistry({
      registry: {
        wasVerified: () => true,
        test: () => Promise.reject(new Error('this suite never runs Test Runtime')),
      },
      entries: [
        {
          id: 'aca-sessions',
          label: 'Azure Container Apps dynamic sessions',
          connectionExists: true,
          imageReachable: true,
          networkPolicies: ['open'],
        },
        { id: 'docker', label: 'Docker', connectionExists: true, imageReachable: true },
      ],
      configFor: () => ({ sessionId: 'unused', workspacePath: 'unused', engine: 'unused' }),
      requestForEcho: String,
      renderEvent: String,
    }),
  );
}

function request(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: string;
    contentType?: string | null;
    role?: TestRole;
  } = {},
): Request {
  const headers = new Headers();
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.role !== undefined) headers.set(TEST_ROLE_HEADER, options.role);
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

const CREATE_BODY = JSON.stringify({
  name: 'Standard',
  driver: 'docker',
  networkPolicy: 'restricted',
  allowedDomains: ['api.anthropic.com'],
  filesystem: 'read-write',
  cpu: 1,
  memoryMb: 1024,
});

describe('/api/runtime-profiles — unconfigured', () => {
  it('answers 503 by name, never 401 and never an empty 200', async () => {
    // The role gate lives in the same context, so with none installed it answers first; the
    // runtimes runtime's own answer is the `unavailable` case below.
    const response = await listProfilesRoute(
      request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rbac_runtime_not_configured');
  });

  it('answers the same 503 on both APIs while the runtimes are unavailable (no secrets service)', async () => {
    installWorkspaceHeaderRbac(WORKSPACE_HEADER);
    const built = await installRuntimesApi(
      () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
      () => Promise.resolve(null),
      {} as unknown as DatabaseRoot,
      null,
    );
    expect(built).toEqual({ runtimes: { kind: 'unavailable' }, runtimeSwitchAudit: null });
    installTestDomains({ runtimes: built.runtimes });
    for (const response of [
      await listProfilesRoute(request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A })),
      await listConnectionsRoute(
        request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
      ),
    ]) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('runtimes_runtime_not_configured');
    }
  });
});

describe('/api/runtime-profiles — configured', () => {
  afterEach(() => clearApplicationContext());

  it('401s with no workspace header, and never leaks whether a store exists', async () => {
    useMemoryRuntime();
    const response = await listProfilesRoute(request('GET', '/api/runtime-profiles'));
    expect(response.status).toBe(401);
  });

  it('creates a profile and returns it with a generated id', async () => {
    useMemoryRuntime();
    const response = await createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; name: string; driver: string };
    expect(body.name).toBe('Standard');
    expect(body.driver).toBe('docker');
    expect(typeof body.id).toBe('string');
  });

  it('accepts allowedDomains: null, the value a profile reads back (BH061-080)', async () => {
    useMemoryRuntime();
    const response = await createProfileRoute(
      request('POST', '/api/runtime-profiles', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ ...JSON.parse(CREATE_BODY), allowedDomains: null }),
      }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { allowedDomains: unknown }).allowedDomains).toBeNull();
  });

  it('rejects a body with an unknown driver, naming the field', async () => {
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
  });

  // ADR-0088 D2: a Builder reads every profile, so a credential must not hide in driverConfig.
  it('refuses a credential-looking driverConfig key on create and patch, naming it', async () => {
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
  });

  // FX-4: a persist path the launcher would refuse after the run is refused when it is stored.
  it('refuses a persistPaths entry outside the workspace on create and patch, naming its index', async () => {
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
  });

  it('accepts settings and secret references whose names only contain a credential word', async () => {
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
  });

  it('refuses a driverConfig nested deeper than 32 levels with 400, not 500', async () => {
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
  });

  it('refuses a second profile with the same name in the same workspace', async () => {
    useMemoryRuntime();
    await createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    const response = await createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    expect(response.status).toBe(409);
  });

  it("lists only the caller's workspace's profiles", async () => {
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
  });

  it('reads, updates and deletes a profile — and another workspace never sees it (§25)', async () => {
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
  });

  it('404s a non-UUID id as invalid rather than not-found, and a well-formed unknown id as not-found', async () => {
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
  });
});

describe('/api/runtime-profiles — a policy the driver cannot enforce here', () => {
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

  it('refuses a PATCH that would overwrite the pool-wide policy with none', async () => {
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
  });

  it('leaves the stored profile running the policy the pool enforces', async () => {
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
  });

  it('refuses the same policy at creation, before an unrunnable profile exists', async () => {
    useMemoryRuntime();
    useAzurePoolRegistry();
    const response = await createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: acaBody('none') }),
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'network_policy_not_enforceable',
    );
  });

  it('refuses a driver-only PATCH that would pair the pool with a stored policy it cannot enforce', async () => {
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
  });

  it('still accepts the same body for a driver the registry does not restrict', async () => {
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
  });

  it('answers 404 for a profile this workspace does not have, never a policy refusal', async () => {
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
  });
});

describe('/api/runtime-connections', () => {
  afterEach(() => clearApplicationContext());

  it('answers 503 unconfigured, never a fabricated list', async () => {
    const response = await listConnectionsRoute(
      request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
    );
    expect(response.status).toBe(503);
  });

  it('creates a connection and never echoes its credential back', async () => {
    useMemoryRuntime();
    // Bound the real clock around the request rather than excluding one wrong constant
    // (round-3 repair — ADR-0015: `expect(body.createdAt).not.toBe(new Date(0).toISOString())`
    // decided on the absence of a single negative, which `new Date(1)` would still have passed).
    // A positive assertion that the returned instant falls inside [before, after] cannot be
    // satisfied by any fabricated constant, past or future.
    const before = Date.now();
    const response = await createConnectionRoute(
      request('POST', '/api/runtime-connections', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          name: 'Primary Docker host',
          driver: 'docker',
          endpoint: 'tcp://docker.internal:2376',
          credential: 'super-secret-client-cert',
        }),
      }),
    );
    const after = Date.now();
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toContain('super-secret-client-cert');
    expect(text).not.toContain('tcp://docker.internal:2376');
    const body = JSON.parse(text) as { name: string; driver: string; createdAt: string };
    // The response carries the STORED name, not the caller's raw display string — see
    // connections.ts's header (W3-CP-06-B2). A caller-supplied name is encoded before it is ever
    // persisted, so this is the value both create() and a later list() agree on.
    expect(body.name).toBe('RUNTIME_CONNECTION__DOCKER__PRIMARY_DOCKER_HOST');
    expect(body.driver).toBe('docker');
    const createdAtMs = new Date(body.createdAt).getTime();
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });

  it("rejects a body naming a driver outside §14.2's catalogue", async () => {
    useMemoryRuntime();
    const response = await createConnectionRoute(
      request('POST', '/api/runtime-connections', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          name: 'x',
          driver: 'my-cloud',
          endpoint: 'https://x',
          credential: 'y',
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("lists only the caller's workspace's connections, and never a credential", async () => {
    useMemoryRuntime();
    await createConnectionRoute(
      request('POST', '/api/runtime-connections', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          name: 'Conn A',
          driver: 'docker',
          endpoint: 'https://a',
          credential: 'secret-a',
        }),
      }),
    );
    const responseA = await listConnectionsRoute(
      request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
    );
    const responseB = await listConnectionsRoute(
      request('GET', '/api/runtime-connections', { workspace: WORKSPACE_B }),
    );
    const textA = await responseA.text();
    expect(textA).not.toContain('secret-a');
    const bodyA = JSON.parse(textA) as { runtimeConnections: unknown[] };
    const bodyB = (await responseB.json()) as { runtimeConnections: unknown[] };
    expect(bodyA.runtimeConnections).toHaveLength(1);
    expect(bodyB.runtimeConnections).toHaveLength(0);
  });
});

// Issue #388: these routes used to answer every member or API key of the workspace whatever its
// role, because they consulted only the workspace resolver. §21 grants runtimes to Owner and
// Admin (`permissions.ts`: `MANAGE`). A Builder reads runtime profiles and nothing else here
// (`READ_ONLY`, ADR-0088); a Viewer falls to `NOTHING`.
describe('who reaches the runtime-profile and runtime-connection routes', () => {
  async function seedProfile(): Promise<string> {
    const response = await createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
    );
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  /** The two profile reads — what the agent editor and agent-definition import need. */
  function profileReads(role: TestRole, profileId: string): Promise<Response>[] {
    const as = { workspace: WORKSPACE_A, role };
    return [
      listProfilesRoute(request('GET', '/api/runtime-profiles', as)),
      getProfileRoute(
        request('GET', `/api/runtime-profiles/${profileId}`, as),
        idContext(profileId),
      ),
    ];
  }

  /**
   * Every profile write, and both runtime-connection routes (credential-bearing, reads too), as
   * thunks run one at a time: a delete must not overtake the patch of the same row.
   */
  function managementRoutes(role: TestRole, profileId: string): (() => Promise<Response>)[] {
    const as = { workspace: WORKSPACE_A, role };
    return [
      () =>
        createProfileRoute(
          request('POST', '/api/runtime-profiles', {
            ...as,
            body: JSON.stringify({ ...(JSON.parse(CREATE_BODY) as object), name: `By ${role}` }),
          }),
        ),
      () =>
        patchProfileRoute(
          request('PATCH', `/api/runtime-profiles/${profileId}`, {
            ...as,
            body: JSON.stringify({ cpu: 2 }),
          }),
          idContext(profileId),
        ),
      () =>
        deleteProfileRoute(
          request('DELETE', `/api/runtime-profiles/${profileId}`, as),
          idContext(profileId),
        ),
      () => listConnectionsRoute(request('GET', '/api/runtime-connections', as)),
      () =>
        createConnectionRoute(
          request('POST', '/api/runtime-connections', {
            ...as,
            body: JSON.stringify({ driver: 'docker', name: 'smuggled', credential: 'x' }),
          }),
        ),
    ];
  }

  async function sequentially(calls: (() => Promise<Response>)[]): Promise<Response[]> {
    const responses: Response[] = [];
    for (const call of calls) responses.push(await call());
    return responses;
  }

  async function expectRefused(responses: Response[]): Promise<void> {
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
  }

  async function expectUnchanged(profileId: string): Promise<void> {
    const listed = await listProfilesRoute(
      request('GET', '/api/runtime-profiles', { workspace: WORKSPACE_A }),
    );
    const body = (await listed.json()) as { runtimeProfiles: { id: string; cpu: number }[] };
    expect(body.runtimeProfiles.map((profile) => profile.id)).toEqual([profileId]);
    expect(body.runtimeProfiles[0]?.cpu).toBe(1);
  }

  // Issue #388: a Builder reads profiles — choosing an agent's runtime profile is part of
  // creating an agent (§21 "Create/edit/run agents"), and the agent editor cannot submit without
  // one — but writes them, and reaches runtime connections, not at all.
  it('lets a Builder read profiles, and refuses it every write and both connection routes', async () => {
    useMemoryRuntime();
    const profileId = await seedProfile();

    const [list, get] = await Promise.all(profileReads('builder', profileId));
    expect(list?.status).toBe(200);
    const listed = (await list?.json()) as { runtimeProfiles: { id: string }[] };
    expect(listed.runtimeProfiles.map((profile) => profile.id)).toEqual([profileId]);
    expect(get?.status).toBe(200);

    await expectRefused(await sequentially(managementRoutes('builder', profileId)));
    await expectUnchanged(profileId);
  });

  it('refuses a Viewer every route with 403, and changes nothing', async () => {
    useMemoryRuntime();
    const profileId = await seedProfile();

    await expectRefused([
      ...(await Promise.all(profileReads('viewer', profileId))),
      ...(await sequentially(managementRoutes('viewer', profileId))),
    ]);
    await expectUnchanged(profileId);
  });

  it('lets an Admin read and change them', async () => {
    useMemoryRuntime();
    const profileId = await seedProfile();

    const [list, get] = await Promise.all(profileReads('admin', profileId));
    expect(list?.status).toBe(200);
    expect(get?.status).toBe(200);
    const [create, patch, remove, connections] = await sequentially(
      managementRoutes('admin', profileId).slice(0, 4),
    );
    expect(create?.status, await create?.clone().text()).toBe(201);
    expect(patch?.status, await patch?.clone().text()).toBe(200);
    expect([200, 204]).toContain(remove?.status);
    expect(connections?.status).toBe(200);
  });
});

describe('external runtime provider', () => {
  function externalBody(driverConfig?: unknown, driver = 'external'): string {
    return JSON.stringify({
      name: `Sandbox ${Math.random().toString(36).slice(2)}`,
      driver,
      networkPolicy: 'none',
      filesystem: 'read-write',
      ...(driverConfig === undefined ? {} : { driverConfig }),
    });
  }

  async function create(body: string): Promise<Response> {
    return createProfileRoute(
      request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body }),
    );
  }

  async function patch(id: string, body: unknown): Promise<Response> {
    return patchProfileRoute(
      request('PATCH', `/api/runtime-profiles/${id}`, {
        workspace: WORKSPACE_A,
        body: JSON.stringify(body),
      }),
      idContext(id),
    );
  }

  async function errorCode(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  it('accepts provider e2b and an absent provider, which means e2b', async () => {
    useMemoryRuntime();
    expect((await create(externalBody({ provider: 'e2b' }))).status).toBe(201);
    expect((await create(externalBody())).status).toBe(201);
    expect((await create(externalBody({ region: 'eu' }))).status).toBe(201);
  });

  it('refuses an unknown provider by name with a typed 422', async () => {
    useMemoryRuntime();
    const response = await create(externalBody({ provider: 'modal' }));
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('runtime_provider_unsupported');
    expect(body.error.message).toContain('"modal"');
    expect(body.error.message).toContain('"e2b"');
  });

  it('refuses a provider that is not text', async () => {
    useMemoryRuntime();
    for (const provider of [7, null, ['e2b'], { name: 'e2b' }]) {
      const response = await create(externalBody({ provider }));
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toBe('runtime_provider_unsupported');
    }
  });

  it('leaves driverConfig an escape hatch for every other driver', async () => {
    useMemoryRuntime();
    expect((await create(externalBody({ provider: 'x' }, 'docker'))).status).toBe(201);
  });

  it('refuses a PATCH that sets an unknown provider on a stored external profile', async () => {
    useMemoryRuntime();
    const { id } = (await (await create(externalBody({ provider: 'e2b' }))).json()) as {
      id: string;
    };
    const response = await patch(id, { driverConfig: { provider: 'modal' } });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('runtime_provider_unsupported');
    expect((await patch(id, { driverConfig: { provider: 'e2b' } })).status).toBe(200);
  });

  it('refuses a PATCH that moves a profile carrying an unknown provider to external', async () => {
    useMemoryRuntime();
    const { id } = (await (await create(externalBody({ provider: 'modal' }, 'docker'))).json()) as {
      id: string;
    };
    const response = await patch(id, { driver: 'external' });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('runtime_provider_unsupported');
  });
});
