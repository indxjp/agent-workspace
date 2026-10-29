/**
 * Test world for the skills code: an in-memory catalog and object store behind the real storage
 * service, so a skill is written as `skills` rows the way a deployment does it. A skill stored the
 * old way (a bare object prefix, still read by the bridge) is seeded with {@link seedBareSkill}.
 */
import { createStorageService } from '../storage/service';
import type { SkillObjects } from '../storage/store';
import { skillFileKey, skillMetaKey } from './keys';
import type { SkillRowsWriter } from './tree';

/** The object store a rows service saves into; spelled by the service so the fixture needs no barrel import. */
type RowsObjects = Parameters<typeof createStorageService>[0]['objects'];
type RowsCatalog = Awaited<ReturnType<Parameters<typeof createStorageService>[0]['catalog']>>;

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const ROWS_WORKSPACE_ID = '66666666-6666-4666-8666-666666666666';

/** The owner a skill's rows are saved for in these tests. */
export const ROWS_PRINCIPAL = { principalId: 'owner', userId: null } as const;

/**
 * The test passes the `objects` the rows are stored in (its own `createInMemoryObjectStore()`, or
 * one shared with another server's world: the skills domain does not import the storage barrel),
 * the `catalog` it already holds so the rows and the skill records share one (a skills domain file
 * may not build one), and a `principal` that differs from the default owner.
 */
export function createSkillRowsWorld<Catalog extends RowsCatalog>(
  objects: RowsObjects,
  workspaceId: string,
  catalog: Catalog,
  principal: SkillRowsWriter['principal'] = ROWS_PRINCIPAL,
) {
  const storage = createStorageService({
    catalog: () => Promise.resolve(catalog),
    objects,
    log: noLog,
  });
  const rows: SkillRowsWriter = { storage, workspaceId, principal };
  return { catalog, objects, storage, rows, workspaceId };
}

/** One file of a bare-prefix skill, as the import body spells it. */
export interface BareSkillFile {
  readonly path: string;
  readonly contentBase64: string;
}

/** Store a skill the way releases before the catalog did: its files under the bare prefix, then its record. */
export async function seedBareSkill(
  store: SkillObjects,
  skill: { readonly name: string; readonly files: readonly BareSkillFile[] },
): Promise<void> {
  for (const file of skill.files) {
    const body = new Uint8Array(Buffer.from(file.contentBase64, 'base64'));
    await store.write(skillFileKey(skill.name, file.path), body, { contentType: null });
  }
  const now = new Date().toISOString();
  const record = { name: skill.name, enabled: true, createdAt: now, updatedAt: now };
  const body = new TextEncoder().encode(JSON.stringify(record));
  await store.write(skillMetaKey(skill.name), body, { contentType: 'application/json' });
}
