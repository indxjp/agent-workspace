import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { describe, expect, it } from 'vitest';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { skillPayloadFile, type SkillPayloadFile } from '../skills/fixtures';
import { createSkillRowsWorld } from '../skills/rows-fixture';
import { importSkillWithId, patchSkillWithId, publishSkillRevisionWithId } from '../skills/service';
import { createAgentRunResourceLoader, skillInboxPath } from './resource-loader';
import { OWNER_PRINCIPAL, sourceText, WORKSPACE } from './resource-loader.test-support';

describe('a pinned skill revision (SDK-19, N-1)', () => {
  const PRINCIPAL = { ownerPrincipalId: OWNER_PRINCIPAL, userId: null, workspaceId: WORKSPACE };
  const skillMd = (body: string): SkillPayloadFile =>
    skillPayloadFile('SKILL.md', `---\nname: triage\n---\n${body}\n`);

  const file = skillPayloadFile;

  async function setup() {
    const skills = createInMemoryObjectStoreProvider();
    const store = skills.forWorkspace(WORKSPACE);
    const catalogs = createInMemoryCatalogStore();
    const repository = catalogs.forWorkspaceSync(WORKSPACE);
    const { rows, storage } = createSkillRowsWorld(
      createInMemoryObjectStore(),
      WORKSPACE,
      repository,
    );

    const imported = await importSkillWithId(
      store,
      repository,
      PRINCIPAL,
      { name: 'triage', files: [skillMd('v0')] },
      rows,
    );
    expect(imported.status).toBe(201);
    const skillId = (await repository.listSkills()).find((skill) => skill.name === 'triage')?.id;
    if (skillId === undefined) throw new Error('no catalog row for the imported skill');
    const publish = async (files: SkillPayloadFile[]): Promise<void> => {
      const published = await publishSkillRevisionWithId(
        store,
        repository,
        PRINCIPAL,
        'triage',
        { files },
        rows,
      );
      expect(published.status, JSON.stringify(published.body)).toBe(201);
    };
    const loader = createAgentRunResourceLoader({ catalog: catalogs, skills, storage });
    // What a run composed from this assignment would materialise: path -> text.
    const loadedFiles = async (
      skillRevisions?: Record<string, number>,
    ): Promise<Record<string, string>> => {
      const loaded = await loader.load(WORKSPACE, {
        files: [],
        skillIds: [skillId],
        connectorIds: [],
        storageGrants: [],
        ...(skillRevisions === undefined ? {} : { skillRevisions }),
      });
      const entries = await Promise.all(
        (loaded.skills[0]?.files ?? []).map(async (entry): Promise<[string, string]> => [
          entry.path,
          (await sourceText(loaded, skillInboxPath('triage', entry.path))) ?? '',
        ]),
      );
      return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
    };
    return { store, repository, rows, publish, loadedFiles, skillId };
  }

  it('keeps loading revision 2 after the skill is patched, while an unpinned agent follows the patch', async () => {
    const { store, repository, rows, publish, loadedFiles, skillId } = await setup();
    await publish([skillMd('v1')]);
    await publish([skillMd('v2')]);
    const patched = await patchSkillWithId(
      store,
      repository,
      PRINCIPAL,
      'triage',
      { files: [skillMd('patched')] },
      rows,
    );
    expect(patched.status).toBe(200);

    expect((await loadedFiles({ [skillId]: 2 }))['SKILL.md']).toContain('v2');
    expect((await loadedFiles({ [skillId]: 1 }))['SKILL.md']).toContain('v1');
    expect((await loadedFiles())['SKILL.md']).toContain('patched');
  });

  it("loads exactly revision N's files for a pinned run, still after N+1 is published, while latest follows N+1", async () => {
    const { publish, loadedFiles, skillId } = await setup();
    await publish([skillMd('first'), file('notes/guide.md', 'guide for one')]);
    const pinned = { [skillId]: 1 };
    const before = await loadedFiles(pinned);
    expect(Object.keys(before).sort()).toEqual(['SKILL.md', 'notes/guide.md']);
    expect(before['SKILL.md']).toContain('first');
    expect(before['notes/guide.md']).toBe('guide for one');
    expect(await loadedFiles()).toEqual(before);

    await publish([skillMd('second'), file('extra.txt', 'only in two')]);

    // The run pinned to 1 loads the same files and bytes it did before 2 existed.
    expect(await loadedFiles(pinned)).toEqual(before);
    // `latest` (no pin) now follows revision 2, and a pin to 2 loads the same set.
    const latest = await loadedFiles();
    expect(Object.keys(latest).sort()).toEqual(['SKILL.md', 'extra.txt']);
    expect(latest['SKILL.md']).toContain('second');
    expect(await loadedFiles({ [skillId]: 2 })).toEqual(latest);
  });
});
