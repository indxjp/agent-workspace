import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import { describe, expect, it, vi } from 'vitest';
import { POST as importRoute, GET as listRoute } from '../../app/api/skills/route';
import { skillMetaKey } from './keys';
import { fixture, postJson, req, WORKSPACE_A, WORKSPACE_B } from './skill-routes.test-support';

describe('POST /api/skills then GET /api/skills', () => {
  it('imports a skill and lists it back', async () => {
    const skillMd = '---\nname: demo\ndescription: A demo skill\n---\n\nBody.\n';
    const upload = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from(skillMd, 'utf8').toString('base64') },
        ],
      }),
    );
    expect(upload.status, await upload.clone().text()).toBe(201);
    const imported = (await upload.json()) as {
      skill: { name: string; description: string | null };
    };
    expect(imported.skill.name).toBe('demo');
    expect(imported.skill.description).toBe('A demo skill');

    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(['demo']);
  });

  it('rejects application/json-less bodies with 415', async () => {
    const response = await importRoute(
      req('POST', '/api/skills', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'demo', files: [] }),
      }),
    );
    expect(response.status).toBe(415);
  });

  it("a workspace cannot see another workspace's skills", async () => {
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'a-only',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('x').toString('base64') }],
      }),
    );
    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_B }));
    const body = (await list.json()) as { skills: Array<{ name: string }> };
    expect(body.skills).toEqual([]);
  });
});

describe('POST /api/skills when the catalog write fails', () => {
  it('leaves no trace of an import whose catalog write fails', async () => {
    vi.spyOn(fixture.catalogs.forWorkspaceSync(WORKSPACE_A), 'putSkill').mockRejectedValueOnce(
      new Error('database blip'),
    );
    const importBody = {
      name: 'demo',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from('# Demo').toString('base64') },
        { path: 'scripts/run.py', contentBase64: Buffer.from('print(1)').toString('base64') },
      ],
    };

    // The route rethrows; Next.js turns the unhandled error into the 500.
    await expect(importRoute(postJson(WORKSPACE_A, importBody))).rejects.toThrow('database blip');

    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ skills: [] });
    const objectStore = createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(
      WORKSPACE_A,
    );
    expect(await listAll(objectStore, 'skills/demo', { recursive: true })).toEqual([]);
    expect(await readWhole(objectStore, skillMetaKey('demo'))).toBeNull();

    expect((await importRoute(postJson(WORKSPACE_A, importBody))).status).toBe(201);
  });
});
