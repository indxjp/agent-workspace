import type { FileStatus } from '../schema/files.js';
import { type CatalogSkill, type ResourceCatalogRepository } from './resource-catalogs.js';
export interface CatalogConformanceFixture {
  readonly catalog: (workspace: 'a' | 'b') => ResourceCatalogRepository;
  readonly ownerA: string;
  readonly ownerB: string;
  /** A member of workspace `'a'`, valid as a row's `createdBy`. */
  readonly actorA: string;
  /** Put a file row in any state, bypassing the port, the way a raw insert does. Rejects on a duplicate. */
  readonly seed: (
    workspace: 'a' | 'b',
    row: { readonly path: string; readonly status: FileStatus; readonly objectId: string },
  ) => Promise<void>;
}

export interface SkillCatalogConformanceFixture {
  readonly catalog: (workspace: 'a' | 'b') => ResourceCatalogRepository;
  readonly ownerA: string;
  readonly ownerB: string;
  /** A member of workspace `'a'`, valid as a skill's `createdBy`. */
  readonly actorA: string;
  /** Assign `skill` to a new agent in `workspace`, the way an agent version does; returns the agent id. */
  readonly assign: (workspace: 'a' | 'b', skill: CatalogSkill) => Promise<string>;
  /** Remove the assignment `assign` made, as an agent version dropping the skill does. */
  readonly unassign: (workspace: 'a' | 'b', skill: CatalogSkill, agentId: string) => Promise<void>;
  /** Date the pending revisions of the skill named `name` in `'a'` past the stale window. */
  readonly ageRevisions: (name: string) => Promise<void>;
}
