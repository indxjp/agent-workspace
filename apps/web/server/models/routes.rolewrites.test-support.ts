import { expect, it } from 'vitest';
import { DELETE, PATCH } from '../../app/api/model-connections/[id]/route';
import { POST as ROTATE } from '../../app/api/model-connections/[id]/credential/route';
import { POST as TEST } from '../../app/api/model-connections/[id]/test/route';
import { POST as CREATE } from '../../app/api/model-connections/route';
import type { ModelAuthorizationFixture } from './routes.fixture.test-support';
import { API_KEY, type RouteContext } from './routes.fixture.test-support';
export function registerModelAuthorizationRoleWritesTests(
  getFixture: () => Pick<
    ModelAuthorizationFixture,
    'ROLES' | 'roleRequest' | 'ALLOWED' | 'connectionId'
  >,
) {
  const testContext = getFixture();

  it.each(testContext.ROLES)(
    'POST /api/model-connections refuses %s unless the role manages the resource',
    async (role) => {
      const testContext1 = getFixture();

      const response = await CREATE(
        testContext1.roleRequest('http://web/api/model-connections', 'POST', role, {
          body: { name: `Created by ${role}`, provider: 'anthropic', apiKey: API_KEY, config: {} },
        }),
      );
      expect(response.status).toBe(testContext1.ALLOWED.has(role) ? 201 : 403);
    },
  );

  it.each(testContext.ROLES)(
    'PATCH /api/model-connections/:id refuses %s unless the role manages the resource',
    async (role) => {
      const testContext2 = getFixture();

      const context: RouteContext = { params: Promise.resolve({ id: testContext2.connectionId }) };
      const response = await PATCH(
        testContext2.roleRequest(
          `http://web/api/model-connections/${testContext2.connectionId}`,
          'PATCH',
          role,
          {
            body: { name: `Renamed by ${role}` },
          },
        ),
        context,
      );
      expect(response.status).toBe(testContext2.ALLOWED.has(role) ? 200 : 403);
    },
  );

  it.each(testContext.ROLES)(
    'POST /api/model-connections/:id/credential refuses %s unless the role manages the resource',
    async (role) => {
      const testContext3 = getFixture();

      const context: RouteContext = { params: Promise.resolve({ id: testContext3.connectionId }) };
      const response = await ROTATE(
        testContext3.roleRequest(
          `http://web/api/model-connections/${testContext3.connectionId}/credential`,
          'POST',
          role,
          {
            body: { apiKey: `rotated-by-${role}` },
          },
        ),
        context,
      );
      expect(response.status).toBe(testContext3.ALLOWED.has(role) ? 204 : 403);
    },
  );

  it.each(testContext.ROLES)(
    'POST /api/model-connections/:id/test refuses %s unless the role manages the resource',
    async (role) => {
      const testContext4 = getFixture();

      const context: RouteContext = { params: Promise.resolve({ id: testContext4.connectionId }) };
      const response = await TEST(
        testContext4.roleRequest(
          `http://web/api/model-connections/${testContext4.connectionId}/test`,
          'POST',
          role,
        ),
        context,
      );
      expect(response.status).toBe(testContext4.ALLOWED.has(role) ? 200 : 403);
    },
  );

  it.each(testContext.ROLES)(
    'DELETE /api/model-connections/:id refuses %s unless the role manages the resource',
    async (role) => {
      const testContext5 = getFixture();

      // Its own connection per role, never the shared fixture: an allowed role actually deletes the
      // row, and reusing one row across this matrix would make a later iteration's 404 look like a
      // second refusal instead of what it is — the row already being gone.
      const created = await CREATE(
        testContext5.roleRequest('http://web/api/model-connections', 'POST', 'owner', {
          body: {
            name: `To delete as ${role}`,
            provider: 'anthropic',
            apiKey: API_KEY,
            config: {},
          },
        }),
      );
      const { id } = (await created.json()) as { id: string };
      const context: RouteContext = { params: Promise.resolve({ id }) };
      const response = await DELETE(
        testContext5.roleRequest(`http://web/api/model-connections/${id}`, 'DELETE', role),
        context,
      );
      expect(response.status).toBe(testContext5.ALLOWED.has(role) ? 200 : 403);
    },
  );
}
