import { expect, it } from 'vitest';
import { PATCH } from '../../app/api/model-connections/[id]/route';
import { POST as CREATE } from '../../app/api/model-connections/route';
import type { Role } from '../rbac/core/roles';
import type { ModelAuthorizationFixture } from './routes.fixture.test-support';
import { API_KEY } from './routes.fixture.test-support';
export function registerModelAuthorizationIsolationTests(
  getFixture: () => Pick<ModelAuthorizationFixture, 'roleRequest' | 'WORKSPACE_B' | 'connectionId'>,
) {
  it('answers 500 authorisation_undecidable, never a silent allow, for a role decide() cannot classify', async () => {
    const testContext = getFixture();

    // The `refuse` branch (`server/models/http.ts`): `decide()` returns it for a role
    // `parseRole` does not accept — unreachable in production through these routes (a
    // `WorkspaceMembership.role` is always one of the four), but round 1 verification (finding 4)
    // found no test exercised it, so a mutation collapsing `refuse` into `run` survived every
    // suite. This asserts the mapping directly.
    const response = await CREATE(
      testContext.roleRequest('http://web/api/model-connections', 'POST', 'superuser' as Role, {
        body: { name: 'Unclassified role', provider: 'anthropic', apiKey: API_KEY, config: {} },
      }),
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('authorisation_undecidable');
  });

  it('conceals workspace A’s connection from workspace B’s Owner exactly like a nonexistent id, and refuses a Viewer of A identically for both', async () => {
    const testContext1 = getFixture();

    const randomId = '99999999-9999-4999-8999-999999999999';

    const asForeignOwner = (id: string): Promise<Response> =>
      PATCH(
        testContext1.roleRequest(`http://web/api/model-connections/${id}`, 'PATCH', 'owner', {
          body: { name: 'renamed from workspace B' },
          workspace: testContext1.WORKSPACE_B,
        }),
        { params: Promise.resolve({ id }) },
      );
    const foreignReal = await asForeignOwner(testContext1.connectionId);
    const foreignRandom = await asForeignOwner(randomId);
    expect(foreignReal.status).toBe(foreignRandom.status);
    expect(await foreignReal.text()).toBe(await foreignRandom.text());

    const asViewerOfA = (id: string): Promise<Response> =>
      PATCH(
        testContext1.roleRequest(`http://web/api/model-connections/${id}`, 'PATCH', 'viewer', {
          body: { name: 'renamed by a viewer' },
        }),
        { params: Promise.resolve({ id }) },
      );
    const viewerReal = await asViewerOfA(testContext1.connectionId);
    const viewerRandom = await asViewerOfA(randomId);
    expect(viewerReal.status).toBe(viewerRandom.status);
    expect(await viewerReal.text()).toBe(await viewerRandom.text());
  });
}
