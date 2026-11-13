import { describe, expect, it } from 'vitest';
import { POST as createRoute, GET as listRoute } from '../../app/api/connectors/route';
import {
  WORKSPACE_A,
  bodyOf,
  createIn,
  request,
  stdioBody,
  useMemoryRuntime,
} from './connector-routes.test-support';
import type { ConnectorResource } from './contract';

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
