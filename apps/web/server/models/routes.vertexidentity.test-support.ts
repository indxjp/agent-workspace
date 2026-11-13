import { expect, it, vi } from 'vitest';
import { POST as CREATE } from '../../app/api/model-connections/route';
import type { VertexCompositionFixture } from './routes.fixture.test-support';
import { request } from './routes.fixture.test-support';
export function registerVertexCompositionVertexIdentityTests(
  getFixture: () => Pick<VertexCompositionFixture, 'build'>,
) {
  it('reads AW_VERTEX_PROJECT_ID and refuses a foreign project through the real runtime', async () => {
    const testContext = getFixture();

    vi.stubEnv('AW_VERTEX_PROJECT_ID', 'install-project-1');
    vi.stubEnv('AW_VERTEX_LOCATION', 'eu');
    const models = await testContext.build();
    if (models.kind !== 'serving') throw new Error('the models API was not installed');
    expect(models.runtime.vertexDefaults).toEqual({
      projectId: 'install-project-1',
      location: 'eu',
    });
    const foreign = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Foreign',
        provider: 'vertex',
        config: { projectId: 'someone-elses-1' },
      }),
    );
    expect(foreign.status).toBe(400);
  });

  it('refuses a vertex create with a task-first message when the install has no Google Cloud project', async () => {
    const testContext1 = getFixture();

    vi.stubEnv('AW_VERTEX_PROJECT_ID', '');
    await testContext1.build();
    const response = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Vertex',
        provider: 'vertex',
        config: { projectId: 'my-project-123' },
      }),
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'vertex_not_configured' },
    });
  });
}
