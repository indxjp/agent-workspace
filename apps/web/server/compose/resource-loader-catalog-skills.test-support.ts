import { listCatalogFiles } from '@agent-workspace/core/db';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { expect, it } from 'vitest';
import { skillPayloadFile } from '../skills/fixtures';
import { seedBareSkill } from '../skills/rows-fixture';
import { patchSkillWithId } from '../skills/service';
import { createStorageService } from '../storage/service';
import { createAgentRunResourceLoader, skillInboxPath } from './resource-loader';
import { bytesOf, ctxOf, noLog, sourceText, type World } from './resource-loader.test-support';
export function defineCatalogSkillsCases(setup: () => Promise<World>): void {
  /** A catalog service over `world`, a skill catalog row `demo`, and a loader that delivers it. */
  async function skillWorld() {
    const world = await setup();
    const skills = createInMemoryObjectStoreProvider();
    const storage = createStorageService({
      catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: noLog,
    });
    const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
    const skill = await catalog.putSkill({
      name: 'demo',
      skillMd: '# demo',
      enabled: true,
      ownerPrincipalId: world.a.principalId,
      createdBy: world.a.userId,
    });
    const saveRow = async (path: string, text: string) => {
      const saved = await storage.save(ctxOf(world.a), {
        area: 'skills',
        path,
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf(text)),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    };
    const loader = createAgentRunResourceLoader({
      catalog: world.catalogs,
      skills,
      storage,
    });
    const loadFiles = async (skillRevisions?: Record<string, number>) => {
      const loaded = await loader.load(world.a.workspaceId, {
        files: [],
        skillIds: [skill.id],
        connectorIds: [],
        storageGrants: [],
        ...(skillRevisions === undefined ? {} : { skillRevisions }),
      });
      return Object.fromEntries(
        await Promise.all(
          (loaded.skills[0]?.files ?? []).map(async (file): Promise<[string, string | null]> => [
            file.path,
            await sourceText(loaded, skillInboxPath('demo', file.path)),
          ]),
        ),
      );
    };
    return { world, skills, skill, storage, saveRow, loadFiles, loader };
  }

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill stored as catalog rows is delivered to a run', async () => {
    const { saveRow, loadFiles } = await skillWorld();
    await saveRow('.skills/demo/SKILL.md', '# demo from rows');
    await saveRow('.skills/demo/scripts/run.sh', 'echo rows');
    await saveRow('.skills/demo-two/SKILL.md', '# another skill');

    expect(await loadFiles()).toEqual({
      'SKILL.md': '# demo from rows',
      'scripts/run.sh': 'echo rows',
    });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a pinned revision stored as rows is delivered, not the current files', async () => {
    const { skill, saveRow, loadFiles } = await skillWorld();
    await saveRow('.skills/demo/SKILL.md', '# current');
    await saveRow('.skills/demo@1/SKILL.md', '# revision one');
    await saveRow('.skills/demo@1/notes.md', 'frozen');
    await saveRow('.skills/demo@2/SKILL.md', '# revision two');

    expect(await loadFiles({ [skill.id]: 1 })).toEqual({
      'SKILL.md': '# revision one',
      'notes.md': 'frozen',
    });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill row granted directly by id is not delivered as a run file', async () => {
    const { world, saveRow, loader } = await skillWorld();
    await saveRow('.skills/demo/SKILL.md', '# demo from rows');
    const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
    const skillRow = (await listCatalogFiles(catalog)).find(
      (file) => file.path === '.skills/demo/SKILL.md',
    );
    if (skillRow === undefined) throw new Error('the skill row was not saved');

    await expect(
      loader.load(world.a.workspaceId, {
        files: [{ fileId: skillRow.id, access: 'read' }],
        skillIds: [],
        connectorIds: [],
        storageGrants: [],
      }),
    ).rejects.toThrow('disappeared before the run was composed');
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a legacy skill (prefix only, no rows) is still delivered to a run', async () => {
    const { world, skills, saveRow, loadFiles } = await skillWorld();
    const store = skills.forWorkspace(world.a.workspaceId);
    await store.write('skills/demo/SKILL.md', Buffer.from('# legacy'), {});
    await store.write('skills/demo/scripts/run.sh', Buffer.from('echo legacy'), {});

    expect(await loadFiles()).toEqual({
      'SKILL.md': '# legacy',
      'scripts/run.sh': 'echo legacy',
    });

    // The rows win once they exist: a leftover prefix is never merged into them.
    await saveRow('.skills/demo/SKILL.md', '# from rows');
    expect(await loadFiles()).toEqual({ 'SKILL.md': '# from rows' });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a patched legacy skill is migrated to rows and the run receives the patch', async () => {
    const { world, skills, storage, loadFiles } = await skillWorld();
    const store = skills.forWorkspace(world.a.workspaceId);
    await seedBareSkill(store, {
      name: 'demo',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from('# legacy').toString('base64') },
        { path: 'scripts/run.sh', contentBase64: Buffer.from('echo legacy').toString('base64') },
      ],
    });
    const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);

    const patched = await patchSkillWithId(
      store,
      catalog,
      { ownerPrincipalId: world.a.principalId, userId: world.a.userId },
      'demo',
      {
        files: [skillPayloadFile('SKILL.md', '# patched')],
      },
      { storage, workspaceId: world.a.workspaceId },
    );

    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await loadFiles()).toEqual({
      'SKILL.md': '# patched',
      'scripts/run.sh': 'echo legacy',
    });
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a folder grant never delivers a skill row', async () => {
    const { world, loader, saveRow } = await skillWorld();
    await saveRow('.skills/demo/SKILL.md', '# demo');
    const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
    const folder = (await listCatalogFiles(catalog)).find((row) => row.path === '.skills');
    if (folder === undefined) throw new Error('saving a skill row created no folder row');

    const loaded = await loader.load(world.a.workspaceId, {
      files: [{ fileId: folder.id, access: 'read' }],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });
    expect(loaded.files.filter((file) => file.kind === 'file')).toEqual([]);
  });
}
