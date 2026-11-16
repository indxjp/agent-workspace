/**
 * The database adapter of the skills port (`./ports.ts`): the one file of this domain that names
 * `@agent-workspace/core/db` (refactoring plan part 07, steps 5–6).
 *
 * The resource catalog already keeps every rule the port describes, so the adapter is the catalog
 * itself, narrowed to the skill calls. `store.test.ts` checks that each port type equals the
 * catalog type it stands for, both ways, so the two cannot drift through a structural match.
 */
import {
  parsePendingSkillDelete as parseCatalogPendingSkillDelete,
  type ResourceCatalogRepository,
} from '@agent-workspace/core/db';

import type { PendingSkillDelete, SkillCatalog } from './ports';

/** A workspace's resource catalog as the skills port: PostgreSQL and the in-memory catalog alike. */
export function skillCatalogOf(catalog: ResourceCatalogRepository): SkillCatalog {
  return catalog;
}

/** Read a persisted pending-delete record; anything unreadable still marks the delete as pending. */
export function parsePendingSkillDelete(value: unknown): PendingSkillDelete {
  return parseCatalogPendingSkillDelete(value);
}
