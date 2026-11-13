import { describe, expect, it } from 'vitest';
import {
  POST as createConnectionRoute,
  GET as listConnectionsRoute,
} from '../../app/api/runtime-connections/route';
import {
  DELETE as deleteProfileRoute,
  GET as getProfileRoute,
  PATCH as patchProfileRoute,
} from '../../app/api/runtime-profiles/[id]/route';
import {
  POST as createProfileRoute,
  GET as listProfilesRoute,
} from '../../app/api/runtime-profiles/route';
import {
  CREATE_BODY,
  idContext,
  request,
  type TestRole,
  useMemoryRuntime,
  WORKSPACE_A,
} from './runtime-routes.test-support';

async function seedProfile(): Promise<string> {
  const response = await createProfileRoute(
    request('POST', '/api/runtime-profiles', { workspace: WORKSPACE_A, body: CREATE_BODY }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function profileReads(role: TestRole, profileId: string): Promise<Response>[] {
  const as = { workspace: WORKSPACE_A, role };
  return [
    listProfilesRoute(request('GET', '/api/runtime-profiles', as)),
    getProfileRoute(request('GET', `/api/runtime-profiles/${profileId}`, as), idContext(profileId)),
  ];
}

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

describe('who reaches the runtime-profile and runtime-connection routes', () => {
  /** The two profile reads — what the agent editor and agent-definition import need. */

  /**
   * Every profile write, and both runtime-connection routes (credential-bearing, reads too), as
   * thunks run one at a time: a delete must not overtake the patch of the same row.
   */

  // Issue #388: a Builder reads profiles — choosing an agent's runtime profile is part of
  // creating an agent (§21 "Create/edit/run agents"), and the agent editor cannot submit without
  // one — but writes them, and reaches runtime connections, not at all.
  it(
    'lets a Builder read profiles, and refuses it every write and both connection routes',
    letsBuilderReadProfilesRefusesItEveryWrite,
  );

  it(
    'refuses a Viewer every route with 403, and changes nothing',
    refusesViewerEveryRoute403ChangesNothing,
  );

  it('lets an Admin read and change them', letsAdminReadChangeThem);
});

async function letsBuilderReadProfilesRefusesItEveryWrite() {
  useMemoryRuntime();
  const profileId = await seedProfile();

  const [list, get] = await Promise.all(profileReads('builder', profileId));
  expect(list?.status).toBe(200);
  const listed = (await list?.json()) as { runtimeProfiles: { id: string }[] };
  expect(listed.runtimeProfiles.map((profile) => profile.id)).toEqual([profileId]);
  expect(get?.status).toBe(200);

  await expectRefused(await sequentially(managementRoutes('builder', profileId)));
  await expectUnchanged(profileId);
}

async function refusesViewerEveryRoute403ChangesNothing() {
  useMemoryRuntime();
  const profileId = await seedProfile();

  await expectRefused([
    ...(await Promise.all(profileReads('viewer', profileId))),
    ...(await sequentially(managementRoutes('viewer', profileId))),
  ]);
  await expectUnchanged(profileId);
}

async function letsAdminReadChangeThem() {
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
}
