import { describe, expect, it } from 'vitest';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute } from '../../app/api/skills/route';
import { nameContext, postJson, req, WORKSPACE_A, WORKSPACE_B } from './skill-routes.test-support';

describe('GET/PATCH /api/skills/:name', () => {
  async function importDemo(): Promise<void> {
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('---\nname: demo\n---\nbody\n').toString('base64'),
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
  }

  it('404s a skill nobody imported', async () => {
    const response = await detailRoute(
      req('GET', '/api/skills/nope', { workspace: WORKSPACE_A }),
      nameContext('nope'),
    );
    expect(response.status).toBe(404);
  });

  it('gets the imported skill back', async () => {
    await importDemo();
    const response = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skill: { name: string } };
    expect(body.skill.name).toBe('demo');
  });

  it("one workspace cannot read or edit another workspace's skill by name", async () => {
    await importDemo();
    const get = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_B }),
      nameContext('demo'),
    );
    expect(get.status).toBe(404);

    const patch = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_B,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patch.status).toBe(404);

    // Proof A's copy is untouched by B's rejected patch.
    const stillEnabled = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    const body = (await stillEnabled.json()) as { skill: { enabled: boolean } };
    expect(body.skill.enabled).toBe(true);
  });

  it('disables a skill via PATCH', async () => {
    await importDemo();
    const patch = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { skill: { enabled: boolean } };
    expect(body.skill.enabled).toBe(false);
  });
});
