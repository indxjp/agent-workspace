import { describe, expect, it, vi } from 'vitest';

import {
  createInMemoryCatalog,
  createInMemoryStorageMigrationRuns,
} from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { listAll } from '@agent-workspace/core/storage/streams';

import { deleteSkill } from '../skills/delete';
import { skillDeleteMarkerKey, skillFileKey } from '../skills/keys';
import {
  createSkillRowsWorld,
  ROWS_PRINCIPAL,
  ROWS_WORKSPACE_ID,
  seedBareSkill,
} from '../skills/rows-fixture';
import { ensureSkillRows, skillFiles } from '../skills/tree';
import { runSkillsAdoptStage, type SkillsAdoptDependencies } from './migrate-skills';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const SKILL_MD = '---\nname: demo\ndescription: A demo.\n---\n\nbody\n';
const b64 = (text: string) => Buffer.from(text).toString('base64');

function world(owner: string | null = 'owner') {
  const catalogs = createInMemoryCatalog();
  const catalog = catalogs.forWorkspace(ROWS_WORKSPACE_ID);
  const old = createInMemoryObjectStoreProvider().forWorkspace(ROWS_WORKSPACE_ID);
  const { storage } = createSkillRowsWorld(createInMemoryObjectStore(), ROWS_WORKSPACE_ID, catalog);
  const runs = createInMemoryStorageMigrationRuns();
  const deps: SkillsAdoptDependencies = {
    workspaceIds: () => Promise.resolve([ROWS_WORKSPACE_ID]),
    objects: () => old,
    catalog: () => Promise.resolve(catalog),
    ownerPrincipalId: () => Promise.resolve(owner),
    storage,
    runs,
    log: noLog,
  };
  const rowPaths = async (folder: string) =>
    (await storage.list({ workspaceId: ROWS_WORKSPACE_ID }, 'skills', folder)).rows
      .map((row) => row.path)
      .toSorted();
  const seedDemo = () =>
    seedBareSkill(old, {
      name: 'demo',
      files: [
        { path: 'SKILL.md', contentBase64: b64(SKILL_MD) },
        { path: 's/run.sh', contentBase64: b64('run') },
      ],
    });
  const putDemo = () =>
    catalog.putSkill({
      name: 'demo',
      skillMd: SKILL_MD,
      enabled: true,
      ownerPrincipalId: 'owner',
      createdBy: null,
    });
  const putRevision = (revision: number) =>
    old.write(`skill-revisions/demo/${revision}/SKILL.md`, new TextEncoder().encode(SKILL_MD), {
      contentType: null,
    });
  return { catalog, old, storage, runs, deps, rowPaths, seedDemo, putDemo, putRevision };
}

// @story US-STO-13
describe('the skills adopt stage', () => {
  it('[US-STO-13][unit][cli] moves every old skill form into rows and records a clean pass', async () => {
    const { catalog, old, runs, deps, rowPaths, seedDemo, putDemo, putRevision } = world();
    await seedDemo();
    await putDemo();
    await catalog.publishSkillRevision('demo', {
      fileCount: 1,
      write: () => Promise.resolve(undefined),
    });
    await putRevision(1);

    const report = await runSkillsAdoptStage(deps);

    expect(report).toEqual({
      workspaces: 1,
      skills: 1,
      moved: 3,
      remaining: 0,
      orphans: 0,
      failed: 0,
    });
    expect(await rowPaths('.skills/demo')).toEqual([
      '.skills/demo/SKILL.md',
      '.skills/demo/s/run.sh',
    ]);
    expect(await rowPaths('.skills/demo@1')).toEqual(['.skills/demo@1/SKILL.md']);
    expect((await catalog.listSkills()).map((skill) => [skill.name, skill.meta !== null])).toEqual([
      ['demo', true],
    ]);
    expect(await listAll(old, 'skills/demo')).toEqual([]);
    expect(await runs.latest('skills')).toMatchObject({
      rowsChecked: 1,
      legacyRows: 0,
      mismatches: 0,
    });
    // The pass that gates deleting old objects is not touched.
    expect(await runs.latest()).toBeNull();
  });

  it('[US-STO-13][unit][cli] never replaces a row and is safe to repeat', async () => {
    const { storage, old, deps, seedDemo } = world();
    await seedDemo();
    const row = {
      area: 'skills' as const,
      path: '.skills/demo/SKILL.md',
      maxBytes: 1024,
      replace: true,
      body: new Blob(['newer']).stream(),
    };
    await storage.save({ workspaceId: ROWS_WORKSPACE_ID, principalId: 'owner', userId: null }, row);

    await runSkillsAdoptStage(deps);
    await runSkillsAdoptStage(deps);

    const files = await skillFiles(
      old,
      { storage, workspaceId: ROWS_WORKSPACE_ID },
      '.skills/demo',
      'skills/demo',
    );
    const skillMd = files.find((file) => file.relativePath === 'SKILL.md');
    expect(new TextDecoder().decode((await skillMd?.read()) ?? undefined)).toBe('newer');
    expect(files.map((file) => file.relativePath)).toEqual(['SKILL.md', 's/run.sh']);
  });

  it('[US-STO-13][unit][cli] two instances running together leave one complete set of rows', async () => {
    const { catalog, runs, deps, rowPaths, seedDemo } = world();
    await seedDemo();

    const reports = await Promise.all([runSkillsAdoptStage(deps), runSkillsAdoptStage(deps)]);

    expect(reports.map((report) => report.failed)).toEqual([0, 0]);
    expect(await rowPaths('.skills/demo')).toEqual([
      '.skills/demo/SKILL.md',
      '.skills/demo/s/run.sh',
    ]);
    expect(await catalog.listSkills()).toHaveLength(1);
    expect(await runs.latest('skills')).toMatchObject({ legacyRows: 0, mismatches: 0 });
  });

  it('[US-STO-13][unit][cli] reports what it cannot convert instead of claiming completion', async () => {
    const { old, deps, runs, rowPaths } = world();
    // Bytes whose skill record is gone are not a skill: no row is made for them.
    await old.write(skillFileKey('ghost', 'SKILL.md'), new Uint8Array([1]), { contentType: null });

    await runSkillsAdoptStage(deps);
    expect(await rowPaths('.skills/ghost')).toEqual([]);
    expect(await runs.latest('skills')).toMatchObject({ legacyRows: 1, mismatches: 0 });

    // A workspace with no owner has nobody to own the rows; its skills stay old and are counted.
    const ownerless = world(null);
    await ownerless.seedDemo();
    await runSkillsAdoptStage(ownerless.deps);
    expect(await ownerless.runs.latest('skills')).toMatchObject({ rowsChecked: 0, legacyRows: 3 });
  });

  it('[US-STO-13][unit][cli] leaves the bare files of a skill whose delete is pending alone', async () => {
    const { catalog, old, deps, rowPaths, seedDemo, putDemo } = world();
    await seedDemo();
    await putDemo();
    await catalog.markSkillDeleting('demo');

    await runSkillsAdoptStage(deps);

    expect(await rowPaths('.skills/demo')).toEqual([]);
    expect((await listAll(old, 'skills/demo')).length).toBeGreaterThan(0);
  });

  it('[US-STO-13][unit][cli] leaves a skill alone whose delete an earlier release recorded as a marker', async () => {
    const { old, deps, rowPaths, seedDemo, putDemo } = world();
    await seedDemo();
    await putDemo();
    await old.write(
      skillDeleteMarkerKey('demo'),
      new TextEncoder().encode(JSON.stringify({ ownerPrincipalId: 'owner', revisions: [] })),
      { contentType: 'application/json' },
    );

    await runSkillsAdoptStage(deps);

    expect(await rowPaths('.skills/demo')).toEqual([]);
    expect((await listAll(old, 'skills/demo')).length).toBeGreaterThan(0);
  });

  it('[US-STO-13][unit][cli] does not move a revision prefix that has no revision record', async () => {
    const { old, deps, runs, rowPaths, seedDemo, putRevision } = world();
    await seedDemo();
    await putRevision(2);

    await runSkillsAdoptStage(deps);

    expect(await rowPaths('.skills/demo')).toEqual([
      '.skills/demo/SKILL.md',
      '.skills/demo/s/run.sh',
    ]);
    expect(await rowPaths('.skills/demo@2')).toEqual([]);
    expect(await listAll(old, 'skill-revisions/demo/2')).toHaveLength(1);
    // The orphan bytes are counted apart from the legacy skills, so a reviewer can see them.
    expect(await runs.latest('skills')).toMatchObject({ legacyRows: 0, orphans: 1 });
  });

  it('[US-STO-13][unit][cli] records orphan revision files apart from legacy rows', async () => {
    const { catalog, runs, deps, seedDemo, putDemo, putRevision } = world();
    await seedDemo();
    await putDemo();
    await catalog.publishSkillRevision('demo', {
      fileCount: 1,
      write: () => Promise.resolve(undefined),
    });
    await putRevision(1);
    await putRevision(7);

    await runSkillsAdoptStage(deps);

    expect(await runs.latest('skills')).toMatchObject({
      legacyRows: 0,
      mismatches: 0,
      orphans: 1,
      proofVersion: 2,
    });
  });

  it('[US-STO-13][unit][cli] warns once per workspace with orphans, naming the workspace and count only', async () => {
    const { deps, seedDemo, putRevision } = world();
    await seedDemo();
    await putRevision(2);
    await putRevision(7);
    const warnings: unknown[][] = [];

    await runSkillsAdoptStage({
      ...deps,
      log: { ...noLog, warn: (...args) => warnings.push(args) },
    });

    expect(warnings).toEqual([
      [expect.any(String), { stage: 'skills', workspaceId: ROWS_WORKSPACE_ID, orphans: 2 }],
    ]);
    expect(JSON.stringify(warnings)).not.toContain('demo');
  });

  it('[US-STO-13][unit][cli] counts a recorded revision left unmoved as a legacy row, not an orphan', async () => {
    const { catalog, runs, deps, seedDemo, putDemo, putRevision } = world();
    await seedDemo();
    await putDemo();
    await catalog.publishSkillRevision('demo', {
      fileCount: 1,
      write: () => Promise.resolve(undefined),
    });
    await putRevision(1);
    // A pending delete keeps the pass from moving the recorded revision's bytes.
    await catalog.markSkillDeleting('demo');

    await runSkillsAdoptStage(deps);

    const latest = await runs.latest('skills');
    expect(latest).toMatchObject({ orphans: 0 });
    expect(latest?.legacyRows).toBeGreaterThanOrEqual(1);
  });

  it('[US-STO-13][unit][cli] an adopt that copies between the delete steps leaves no rows behind the delete', async () => {
    const { catalog, old, storage, rowPaths, seedDemo, putDemo } = world();
    await seedDemo();
    await putDemo();
    const writer = { storage, workspaceId: ROWS_WORKSPACE_ID, principal: ROWS_PRINCIPAL };
    let copied = false;
    const rows = {
      workspaceId: ROWS_WORKSPACE_ID,
      storage: {
        ...storage,
        remove: async (...args: Parameters<typeof storage.remove>) => {
          const gone = await storage.remove(...args);
          // An adopt that read the skill before the mark copies its bare prefix now, after the
          // delete swept the rows and before it walks the prefix.
          if (!copied) {
            copied = true;
            await ensureSkillRows(old, writer, 'demo');
          }
          return gone;
        },
      },
    };

    const deleted = await deleteSkill(old, catalog, 'demo', rows);

    expect(copied).toBe(true);
    expect(deleted.status).toBe(204);
    expect(await rowPaths('.skills/demo')).toEqual([]);
    expect(await catalog.listSkills()).toEqual([]);
  });

  it('[US-STO-13][unit][cli] a delete that starts while adopt copies wins: adopt removes what it wrote', async () => {
    const { catalog, old, storage, deps, rowPaths, seedDemo, putDemo } = world();
    await seedDemo();
    await putDemo();
    let marked = false;
    const racing = {
      ...storage,
      save: async (...args: Parameters<typeof storage.save>) => {
        if (!marked) {
          marked = true;
          await catalog.markSkillDeleting('demo');
        }
        return storage.save(...args);
      },
    };

    await runSkillsAdoptStage({ ...deps, storage: racing });

    expect(marked).toBe(true);
    expect(await rowPaths('.skills/demo')).toEqual([]);
    const deleted = await deleteSkill(old, catalog, 'demo', {
      storage,
      workspaceId: ROWS_WORKSPACE_ID,
    });
    expect(deleted.status).toBe(204);
    expect(await rowPaths('.skills/demo')).toEqual([]);
  });

  // #1925 item 5: each moved skill's pending-delete check listed every skill row, so a first pass
  // over n skills read the whole skills table about 2n times.
  it('[US-STO-13][unit][cli] a first pass reads the skill list a fixed number of times, however many skills move', async () => {
    const listings = async (count: number) => {
      const { catalog, old, deps } = world();
      for (let index = 0; index < count; index += 1) {
        const name = `skill-${String(index)}`;
        await seedBareSkill(old, {
          name,
          files: [
            { path: 'SKILL.md', contentBase64: b64(SKILL_MD.replace('demo', name)) },
            { path: 's/run.sh', contentBase64: b64('run') },
          ],
        });
      }
      const listSkills = vi.spyOn(catalog, 'listSkills');
      const report = await runSkillsAdoptStage(deps);
      expect(report).toMatchObject({ skills: count, moved: 2 * count, remaining: 0, failed: 0 });
      return listSkills.mock.calls.length;
    };

    expect(await listings(5)).toBe(await listings(1));
  });

  it('[US-STO-13][unit][cli] every pass is recorded, an unchanged one included', async () => {
    const { runs, deps } = world();
    const recorded = vi.spyOn(runs, 'record');

    await runSkillsAdoptStage(deps);
    await runSkillsAdoptStage(deps);

    expect(recorded).toHaveBeenCalledTimes(2);
    expect(await runs.latest('skills')).toMatchObject({ clean: true, proofVersion: 2 });
  });

  it('[US-STO-13][unit][cli] a pass that throws is recorded as unclean and still throws', async () => {
    const { runs, deps } = world();
    await runSkillsAdoptStage(deps);

    await expect(
      runSkillsAdoptStage({ ...deps, workspaceIds: () => Promise.reject(new Error('down')) }),
    ).rejects.toThrow('down');

    expect(await runs.latest('skills')).toMatchObject({
      clean: false,
      mismatches: 1,
      proofVersion: 2,
    });
  });

  it('[US-STO-13][unit][cli] a workspace whose skill list is refused is counted as failed', async () => {
    const { old, deps, runs } = world();
    // An unreadable SKILL.md makes the list answer 500 store_inconsistent without throwing.
    await seedBareSkill(old, {
      name: 'broken',
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from([0x80]).toString('base64') }],
    });
    const warnings: unknown[] = [];

    await runSkillsAdoptStage({
      ...deps,
      log: { ...noLog, warn: (...args) => warnings.push(args) },
    });

    expect(await runs.latest('skills')).toMatchObject({ mismatches: 1 });
    expect(warnings).toEqual([
      [expect.any(String), { stage: 'skills', code: 'store_inconsistent' }],
    ]);
  });

  // #1925 item 7: a failed workspace was counted once per failure, so the count was inflated.
  it('[US-STO-13][unit][cli] a workspace that fails twice in one pass is counted once', async () => {
    const { old, catalog, deps, runs } = world();
    await seedBareSkill(old, {
      name: 'broken',
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from([0x80]).toString('base64') }],
    });
    await catalog.putSkill({
      name: 'kept',
      skillMd: SKILL_MD,
      enabled: true,
      ownerPrincipalId: 'owner',
      createdBy: null,
    });
    vi.spyOn(catalog, 'listSkillRevisions').mockRejectedValue(new Error('down'));

    const report = await runSkillsAdoptStage(deps);

    expect(report).toMatchObject({ workspaces: 1, failed: 1 });
    expect(await runs.latest('skills')).toMatchObject({ clean: false, mismatches: 1 });
  });

  it('[US-STO-13][unit][cli] a workspace that fails is counted and does not stop the run', async () => {
    const { deps, runs } = world();
    await runSkillsAdoptStage({
      ...deps,
      workspaceIds: () => Promise.resolve(['gone', ROWS_WORKSPACE_ID]),
      objects: (workspaceId) => {
        if (workspaceId === 'gone') throw new Error('the workspace is gone');
        return deps.objects(workspaceId);
      },
    });
    expect(await runs.latest('skills')).toMatchObject({ mismatches: 1 });
  });
});
