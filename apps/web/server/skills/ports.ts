/**
 * The skills port: the catalog calls the skills domain makes, in its own words (refactoring plan
 * part 07, steps 5–6). Nothing here names `@agent-workspace/core/db`.
 *
 * Two adapters implement it, and both pass the one contract suite in `store.contract.ts`:
 *
 * - `skillCatalogOf` in `./store.ts` adapts a workspace's PostgreSQL resource catalog. `./store.ts`
 *   is the one file of this domain that names the database, and it checks at compile time that
 *   every type below is the same as the database type it stands for, so the two cannot drift.
 * - The in-memory catalog of `@agent-workspace/core/db`, adapted the same way, backs the tests.
 *
 * The rules each method keeps (row locks, the in-use check, revision numbering) are the catalog's;
 * the method comments below say what the skills code relies on.
 */

/** A delete under way: the owner of the skill it removes, and every revision number it must clear. */
export interface PendingSkillDelete {
  readonly ownerPrincipalId: string | null;
  readonly revisions: readonly number[];
}

/** One skill's catalog row. */
export interface SkillRow {
  readonly id: string;
  readonly name: string;
  readonly skillMd: string;
  readonly enabled: boolean;
  /** Compatibility attribution for a membership principal. */
  readonly createdBy: string | null;
  /** Exact owner; an upsert of an existing name never transfers it. */
  readonly ownerPrincipalId: string;
  /** Set while a delete that passed its in-use check is removing the skill's bytes. */
  readonly pendingDelete: PendingSkillDelete | null;
  /** The digest of the built-in release installed into the row; null for a skill the user made. */
  readonly builtinDigest: string | null;
  /** The platform's record about the skill (name, enabled flag, timestamps); null until written. */
  readonly meta: unknown;
}

/** What the skills code writes to a row; the delete, built-in and meta records have their own calls. */
export type SkillRowInput = Omit<
  SkillRow,
  'id' | 'createdBy' | 'pendingDelete' | 'builtinDigest' | 'meta'
> & {
  readonly createdBy?: string | null;
};

/** One published revision of a skill: an immutable snapshot of its files. */
export interface SkillRevisionRow {
  readonly number: number;
  readonly fileCount: number;
  readonly publishedAt: Date;
}

/** What removing a row can produce; `in-use` names every agent the skill is still assigned to. */
export type DeleteSkillRowOutcome =
  | { readonly kind: 'deleted'; readonly skill: SkillRow }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly agentIds: readonly string[] };

/** What marking a skill for deletion can produce. */
export type MarkSkillDeletingOutcome =
  | { readonly kind: 'marked'; readonly pending: PendingSkillDelete }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'in-use'; readonly agentIds: readonly string[] };

/** One workspace's skill rows. A port is obtained per workspace; no call takes a workspace id. */
export interface SkillCatalog {
  listSkills(): Promise<readonly SkillRow[]>;
  /** The row named `name`, or `null`. */
  getSkill(name: string): Promise<SkillRow | null>;
  /** Insert or update by name; the owner of an existing row is kept. */
  putSkill(input: SkillRowInput): Promise<SkillRow>;
  /** Insert only when the name is free; `null` when anyone holds it. */
  createSkill(input: SkillRowInput): Promise<SkillRow | null>;
  /** Remove the row unless an agent has it assigned; with `onlyId`, only the row with that id. */
  deleteSkill(name: string, onlyId?: string): Promise<DeleteSkillRowOutcome>;
  /** Start a delete: record the owner and every revision number, unless the skill is in use. */
  markSkillDeleting(name: string): Promise<MarkSkillDeletingOutcome>;
  /** Copy a legacy marker into the row unless it already has one or is in use; whether it now has one. */
  backfillSkillPendingDelete(name: string, pending: PendingSkillDelete): Promise<boolean>;
  /** Write the platform record (`null` clears it), or with `onlyIfEmpty` only when there is none. */
  setSkillMeta(name: string, meta: unknown, onlyIfEmpty?: boolean): Promise<boolean>;
  /** Record the digest of the built-in release installed into the row. */
  setSkillBuiltinDigest(name: string, digest: string): Promise<void>;
  /** Allocate the next revision number, call `write`, then record it complete; `null` for no skill. */
  publishSkillRevision(
    name: string,
    input: {
      readonly fileCount: number;
      readonly write: (
        number: number,
        abandoned: readonly number[],
      ) => Promise<Pick<SkillRow, 'skillMd' | 'enabled'> | undefined>;
    },
  ): Promise<SkillRevisionRow | null>;
  /** The complete revisions, newest first; `includePending` adds those still being written. */
  listSkillRevisions(
    name: string,
    options?: { readonly includePending?: boolean },
  ): Promise<readonly SkillRevisionRow[]>;
}
