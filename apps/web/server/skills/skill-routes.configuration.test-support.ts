import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { readWhole } from '@agent-workspace/core/storage/streams';
import { describe, expect, it } from 'vitest';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute, GET as listRoute } from '../../app/api/skills/route';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createRepositorySkillsStoreProvider } from '../storage/store';
import { skillFileKey, skillRowFolder } from './keys';
import { fixture, nameContext, postJson, req, WORKSPACE_A } from './skill-routes.test-support';

describe('skills routes, unconfigured', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    // The role gate lives in the same context, so with none installed it answers first; the skills
    // runtime's own answer is the `unavailable` case below.
    clearApplicationContext(); // this suite's beforeEach already configured one — undo it for this case
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'rbac_runtime_not_configured' },
    });
  });

  it('answers the same 503 when the skills storage is unavailable', async () => {
    installTestDomains({ skills: { kind: 'unavailable' } });
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
  });
});

describe('skills write route and the rows service', () => {
  const importBody = {
    name: 'demo',
    files: [
      { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: demo\n---\n').toString('base64') },
    ],
  };

  // @story US-STO-08
  it('[US-STO-08][api][sdk] POST /api/skills with the rows service answers 201 and saves a skills row', async () => {
    const response = await importRoute(postJson(WORKSPACE_A, importBody));

    expect(response.status, await response.clone().text()).toBe(201);
    const listed = await fixture.skillsService.list(
      { workspaceId: WORKSPACE_A },
      'skills',
      skillRowFolder('demo'),
    );
    expect(listed.rows.map((row) => row.path)).toEqual([`${skillRowFolder('demo')}/SKILL.md`]);
    expect(
      await readWhole(
        createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(WORKSPACE_A),
        skillFileKey('demo', 'SKILL.md'),
      ),
    ).toBeNull();
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] POST /api/skills without the rows service answers 503 and writes nothing', async () => {
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store: createRepositorySkillsStoreProvider({
            store: createLocalFilesystemObjectStoreProvider(fixture.rootDir),
            scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]),
          }),
          catalog: fixture.catalogs,
          // No `storage` — the one difference from the suite's own `beforeEach`.
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
        },
      },
    });

    const response = await importRoute(postJson(WORKSPACE_A, importBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
    expect(
      await readWhole(
        createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(WORKSPACE_A),
        skillFileKey('demo', 'SKILL.md'),
      ),
    ).toBeNull();
    expect(await fixture.catalogs.forWorkspaceSync(WORKSPACE_A).listSkills()).toEqual([]);
  });
});

describe('K-4: a store with no catalog wired', () => {
  function useStoreWithoutCatalog(): void {
    const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]);
    const store = createRepositorySkillsStoreProvider({
      store: createLocalFilesystemObjectStoreProvider(fixture.rootDir),
      scopes,
    });
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store,
          // No `catalog` — this is the one difference from the suite's own `beforeEach`.
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
        },
      },
    });
  }

  it('GET /api/skills answers 503 skills_runtime_not_configured', async () => {
    useStoreWithoutCatalog();
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
  });

  it('POST /api/skills answers 503 before writing anything', async () => {
    useStoreWithoutCatalog();
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('x').toString('base64') }],
      }),
    );
    expect(response.status).toBe(503);
  });

  it('GET /api/skills/:name and PATCH /api/skills/:name each answer 503', async () => {
    useStoreWithoutCatalog();
    const getResponse = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    expect(getResponse.status).toBe(503);
    const patchResponse = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patchResponse.status).toBe(503);
  });
});
