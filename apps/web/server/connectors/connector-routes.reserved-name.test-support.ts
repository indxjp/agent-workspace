import { describe, expect, it } from 'vitest';
import { PATCH as rotateRoute } from '../../app/api/connectors/[id]/route';
import { POST as createRoute, GET as listRoute } from '../../app/api/connectors/route';
import {
  WORKSPACE_A,
  bodyOf,
  createIn,
  idContext,
  request,
  stdioBody,
  useMemoryRuntime,
} from './connector-routes.test-support';

describe('the aw-control connector name is reserved for the platform (#1846)', () => {
  const postgresBody = (name: string): string =>
    JSON.stringify({
      kind: 'postgres',
      name,
      credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
      tables: ['public.orders'],
      readOnly: true,
    });

  async function expectConflict(response: Response): Promise<void> {
    expect(response.status).toBe(409);
    expect(((await bodyOf(response)) as { error: { code: string } }).error.code).toBe(
      'connector_name_conflict',
    );
  }

  async function connectorNames(): Promise<string[]> {
    const list = await listRoute(request('GET', '/api/connectors', { workspace: WORKSPACE_A }));
    return ((await bodyOf(list)) as { connectors: Array<{ name: string }> }).connectors.map(
      (connector) => connector.name,
    );
  }

  it('refuses to create an mcp or a tool connector with that name, and stores nothing', async () => {
    useMemoryRuntime();
    for (const name of ['aw-control', 'AW-Control', ' aw-control ']) {
      for (const body of [stdioBody({ name }), postgresBody(name)]) {
        await expectConflict(
          await createRoute(request('POST', '/api/connectors', { workspace: WORKSPACE_A, body })),
        );
      }
    }
    expect(await connectorNames()).toEqual([]);
  });

  it('refuses to rename an mcp or a tool connector to that name', async () => {
    useMemoryRuntime();
    const mcp = await createIn(WORKSPACE_A, stdioBody());
    const tool = await createIn(WORKSPACE_A, postgresBody('shop'));
    for (const [id, body] of [
      [mcp.id, { name: 'aw-control' }],
      [tool.id, { name: 'aw-control' }],
      [tool.id, JSON.parse(postgresBody('aw-control')) as unknown],
    ] as const) {
      const response = await rotateRoute(
        request('PATCH', `/api/connectors/${id}`, {
          workspace: WORKSPACE_A,
          body: JSON.stringify(body),
        }),
        idContext(id),
      );
      await expectConflict(response);
    }
    expect((await connectorNames()).sort()).toEqual(['Filesystem', 'shop']);
  });

  it('still creates aw-dev-tools, which aw dev and aw push register', async () => {
    useMemoryRuntime();
    const created = await createIn(WORKSPACE_A, stdioBody({ name: 'aw-dev-tools' }));
    expect(created.name).toBe('aw-dev-tools');
  });
});
