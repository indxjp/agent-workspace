import { expect, it } from 'vitest';
import { DELETE, GET as GET_ONE, PATCH } from '../../app/api/model-connections/[id]/route';
import { POST as ROTATE } from '../../app/api/model-connections/[id]/credential/route';
import { POST as TEST } from '../../app/api/model-connections/[id]/test/route';
import { POST as CREATE } from '../../app/api/model-connections/route';
import { GET as LIST } from '../../app/api/models/route';
import type { ModelHttpFixture } from './routes.fixture.test-support';
import {
  API_KEY,
  ROTATED_KEY,
  type RouteContext,
  request,
  text,
} from './routes.fixture.test-support';
export function registerModelHttpLifecycleTests(
  getFixture: () => Pick<ModelHttpFixture, 'audits' | 'logs'>,
) {
  it('never returns or records a provider key across create/list/get/update/test/rotate/delete', async () => {
    const testContext = getFixture();

    const responses: string[] = [];
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Claude',
        provider: 'anthropic',
        apiKey: API_KEY,
        config: {},
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      id: string;
      hasCredential: boolean;
      ready: boolean;
    };
    expect(createdBody.hasCredential).toBe(true);
    expect(createdBody.ready).toBe(true);
    responses.push(JSON.stringify(createdBody));
    const context: RouteContext = { params: Promise.resolve({ id: createdBody.id }) };

    const listed = await LIST(request('http://web/api/models'));
    expect(listed.status).toBe(200);
    responses.push(await text(listed));

    const fetched = await GET_ONE(
      request(`http://web/api/model-connections/${createdBody.id}`),
      context,
    );
    expect(fetched.status).toBe(200);
    responses.push(await text(fetched));

    const refusedProviderChange = await PATCH(
      request(`http://web/api/model-connections/${createdBody.id}`, 'PATCH', {
        provider: 'openai',
      }),
      context,
    );
    expect(refusedProviderChange.status).toBe(400);
    responses.push(await text(refusedProviderChange));

    const updated = await PATCH(
      request(`http://web/api/model-connections/${createdBody.id}`, 'PATCH', {
        name: 'Claude primary',
      }),
      context,
    );
    expect(updated.status).toBe(200);
    responses.push(await text(updated));

    const tested = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(tested.status).toBe(200);
    responses.push(await text(tested));

    const rotated = await ROTATE(
      request(`http://web/api/model-connections/${createdBody.id}/credential`, 'POST', {
        apiKey: ROTATED_KEY,
      }),
      context,
    );
    expect(rotated.status).toBe(204);
    responses.push(await text(rotated));

    const testedAfterRotation = await TEST(
      request(`http://web/api/model-connections/${createdBody.id}/test`, 'POST'),
      context,
    );
    expect(testedAfterRotation.status).toBe(200);
    responses.push(await text(testedAfterRotation));

    const deleted = await DELETE(
      request(`http://web/api/model-connections/${createdBody.id}`, 'DELETE'),
      context,
    );
    expect(deleted.status).toBe(200);
    const deletedBody = (await deleted.json()) as {
      deleted: boolean;
      referencedBy: readonly unknown[];
    };
    expect(deletedBody).toEqual({ deleted: true, referencedBy: [] });
    responses.push(JSON.stringify(deletedBody));

    for (const key of [API_KEY, ROTATED_KEY]) {
      const sensitive = key.toLowerCase();
      for (const body of responses) expect(body.toLowerCase()).not.toContain(sensitive);
      expect(JSON.stringify(testContext.audits).toLowerCase()).not.toContain(sensitive);
      expect(JSON.stringify(testContext.logs).toLowerCase()).not.toContain(sensitive);
    }
    // create, update, test, rotate, test-again, delete.
    expect(testContext.audits).toHaveLength(6);
  });
}
