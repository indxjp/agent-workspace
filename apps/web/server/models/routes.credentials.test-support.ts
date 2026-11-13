import { expect, it } from 'vitest';
import { POST as ROTATE } from '../../app/api/model-connections/[id]/credential/route';
import { POST as TEST } from '../../app/api/model-connections/[id]/test/route';
import { POST as CREATE } from '../../app/api/model-connections/route';

import { API_KEY, ROTATED_KEY, type RouteContext, request } from './routes.fixture.test-support';
export function registerModelHttpCredentialsTests() {
  it('rejects an unknown field on the rotation route without touching the stored credential', async () => {
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Rotation guard',
        provider: 'openai',
        apiKey: API_KEY,
        config: {},
      }),
    );
    const createdBody = (await created.json()) as { id: string };
    const context: RouteContext = { params: Promise.resolve({ id: createdBody.id }) };

    const rejected = await ROTATE(
      request(`http://web/api/model-connections/${createdBody.id}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
        extra: 'nope',
      }),
      context,
    );
    expect(rejected.status).toBe(400);

    const tested = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(tested.status).toBe(200);
  });

  it('reports 404 for a rotation targeting a connection that does not exist', async () => {
    const missingId = '99999999-9999-4999-8999-999999999999';
    const context: RouteContext = { params: Promise.resolve({ id: missingId }) };
    const response = await ROTATE(
      request(`http://web/api/model-connections/${missingId}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
      }),
      context,
    );
    expect(response.status).toBe(404);
  });
}
