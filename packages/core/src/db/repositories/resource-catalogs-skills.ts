import { and, asc, desc, eq, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';

import { setTimeout as sleep } from 'node:timers/promises';

import { agentSkills } from '../schema/agent-skills.js';
import { skillRevisions } from '../schema/skill-revisions.js';
import { skills } from '../schema/skills.js';
import {
  pendingDeleteFor,
  SKILL_PUBLISH_POLL_MS,
  STALE_SKILL_REVISION_MS,
  type CatalogSkill,
  type CatalogSkillRevision,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  type PendingSkillDelete,
  type SkillInput,
} from './resource-catalogs-model.js';
import type { ResourceCatalogRepository } from './resource-catalogs-port.js';
import {
  skillColumns,
  toCatalogSkill,
  type CatalogContext,
  type Transaction,
} from './resource-catalogs-sql.js';

type PublishInput = Parameters<ResourceCatalogRepository['publishSkillRevision']>[1];

export async function listSkills({ db, workspaceId }: CatalogContext): Promise<CatalogSkill[]> {
  const rows = await db
    .select(skillColumns)
    .from(skills)
    .where(eq(skills.workspaceId, workspaceId))
    // Code point order, as the memory catalog sorts, whatever the database's collation.
    .orderBy(sql`${skills.name} collate "C"`);
  return rows.map(toCatalogSkill);
}

export async function getSkill(
  { db, workspaceId }: CatalogContext,
  name: string,
): Promise<CatalogSkill | null> {
  const [row] = await db
    .select(skillColumns)
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
    .limit(1);
  return row === undefined ? null : toCatalogSkill(row);
}

export async function putSkill(
  { db, workspaceId }: CatalogContext,
  input: SkillInput,
): Promise<CatalogSkill> {
  const rows = await db
    .insert(skills)
    .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
    .onConflictDoUpdate({
      target: [skills.workspaceId, skills.name],
      // Ownership and compatibility attribution are deliberately absent: a re-upload
      // updates content but never transfers the existing row.
      set: { skillMd: input.skillMd, enabled: input.enabled },
    })
    .returning(skillColumns);
  const row = rows[0];
  if (row === undefined) throw new Error('skill catalog upsert returned no row');
  return toCatalogSkill(row);
}

export async function createSkill(
  { db, workspaceId }: CatalogContext,
  input: SkillInput,
): Promise<CatalogSkill | null> {
  const rows = await db
    .insert(skills)
    .values({ workspaceId, ...input, createdBy: input.createdBy ?? null })
    .onConflictDoNothing({ target: [skills.workspaceId, skills.name] })
    .returning(skillColumns);
  const row = rows[0];
  return row === undefined ? null : toCatalogSkill(row);
}

/** The skill row named `name`, locked for the rest of the transaction. */
const lockSkillRow = (tx: Transaction, workspaceId: string, name: string) =>
  tx
    .select(skillColumns)
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)))
    .for('update');

/** Every agent the skill is assigned to, in id order. */
const assignedAgents = (tx: Transaction, workspaceId: string, skillId: string) =>
  tx
    .select({ agentId: agentSkills.agentId })
    .from(agentSkills)
    .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, skillId)))
    .orderBy(asc(agentSkills.agentId));

export async function deleteSkill(
  { db, workspaceId }: CatalogContext,
  name: string,
  onlyId?: string,
): Promise<DeleteCatalogSkillOutcome> {
  return db.transaction(async (tx): Promise<DeleteCatalogSkillOutcome> => {
    const found = (await lockSkillRow(tx, workspaceId, name))[0];
    if (found === undefined || (onlyId !== undefined && found.id !== onlyId)) {
      return { kind: 'not-found' };
    }
    const skill = toCatalogSkill(found);
    const assignments = await assignedAgents(tx, workspaceId, skill.id);
    if (assignments.length > 0) {
      return { kind: 'in-use', agentIds: assignments.map((row) => row.agentId) };
    }
    await tx
      .delete(skills)
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skill.id)));
    return { kind: 'deleted', skill };
  });
}

export async function markSkillDeleting(
  { db, workspaceId }: CatalogContext,
  name: string,
): Promise<MarkSkillDeletingOutcome> {
  return db.transaction(async (tx): Promise<MarkSkillDeletingOutcome> => {
    const found = (await lockSkillRow(tx, workspaceId, name))[0];
    if (found === undefined) return { kind: 'not-found' };
    const skill = toCatalogSkill(found);
    const assignments = await assignedAgents(tx, workspaceId, skill.id);
    const inUse = assignments.length > 0;
    // Pending revisions too: a crashed publish leaves its rows behind.
    const revisions = await tx
      .select({ number: skillRevisions.number })
      .from(skillRevisions)
      .where(
        and(eq(skillRevisions.workspaceId, workspaceId), eq(skillRevisions.skillId, skill.id)),
      );
    const pending = pendingDeleteFor(
      skill,
      revisions.map((row) => row.number),
    );
    // An in-use answer changes nothing: a mark an earlier attempt left must survive it.
    if (inUse) return { kind: 'in-use', agentIds: assignments.map((row) => row.agentId) };
    await tx
      .update(skills)
      .set({ pendingDelete: pending })
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skill.id)));
    return { kind: 'marked', pending };
  });
}

export async function backfillSkillPendingDelete(
  { db, workspaceId }: CatalogContext,
  name: string,
  pending: PendingSkillDelete,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [found] = await lockSkillRow(tx, workspaceId, name);
    if (found === undefined) return false;
    if (found.pendingDelete !== null) return true;
    const [assigned] = await tx
      .select({ agentId: agentSkills.agentId })
      .from(agentSkills)
      .where(and(eq(agentSkills.workspaceId, workspaceId), eq(agentSkills.skillId, found.id)))
      .limit(1);
    if (assigned !== undefined) return false;
    await tx
      .update(skills)
      .set({ pendingDelete: pending })
      .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, found.id)));
    return true;
  });
}

export async function setSkillMeta(
  { db, workspaceId }: CatalogContext,
  name: string,
  meta: unknown,
  onlyIfEmpty: boolean,
): Promise<boolean> {
  const rows = await db
    .update(skills)
    .set({ meta })
    .where(
      and(
        eq(skills.workspaceId, workspaceId),
        eq(skills.name, name),
        onlyIfEmpty ? isNull(skills.meta) : undefined,
      ),
    )
    .returning({ id: skills.id });
  if (rows.length > 0) return true;
  // Nothing updated: no such row, or (onlyIfEmpty) one that already has its record.
  const [row] = await db
    .select({ id: skills.id })
    .from(skills)
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)));
  return row !== undefined && onlyIfEmpty;
}

export async function setSkillBuiltinDigest(
  { db, workspaceId }: CatalogContext,
  name: string,
  digest: string,
): Promise<void> {
  await db
    .update(skills)
    .set({ builtinDigest: digest })
    .where(and(eq(skills.workspaceId, workspaceId), eq(skills.name, name)));
}

export async function listSkillRevisions(
  { db, workspaceId }: CatalogContext,
  name: string,
  options?: { readonly includePending?: boolean },
): Promise<CatalogSkillRevision[]> {
  return db
    .select({
      number: skillRevisions.number,
      fileCount: skillRevisions.fileCount,
      publishedAt: skillRevisions.createdAt,
    })
    .from(skillRevisions)
    .innerJoin(
      skills,
      and(
        eq(skills.id, skillRevisions.skillId),
        eq(skills.workspaceId, skillRevisions.workspaceId),
      ),
    )
    .where(
      and(
        eq(skillRevisions.workspaceId, workspaceId),
        eq(skills.name, name),
        options?.includePending === true ? undefined : eq(skillRevisions.pending, false),
      ),
    )
    .orderBy(desc(skillRevisions.number));
}

/** A revision number committed as pending, and the stale numbers its allocation abandoned. */
interface AllocatedRevision {
  readonly id: string;
  readonly skillId: string;
  readonly number: number;
  readonly abandoned: readonly number[];
}

/** The skill row named `name`, unless a delete has started on it, locked for the transaction. */
const lockPublishableSkill = (tx: Transaction, workspaceId: string, name: string) =>
  tx
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(eq(skills.workspaceId, workspaceId), eq(skills.name, name), isNull(skills.pendingDelete)),
    )
    .for('update');

/** When a pending revision created before this is a crashed publish. */
const staleBefore = (): SQL =>
  sql`now() - make_interval(secs => ${STALE_SKILL_REVISION_MS / 1000})`;

export async function publishSkillRevision(
  context: CatalogContext,
  name: string,
  input: PublishInput,
): Promise<CatalogSkillRevision | null> {
  const allocated = await allocateRevision(context, name, input.fileCount);
  if (allocated === null) return null;
  // Keyed on the row's id: once abandoned as stale, this row is gone for good.
  const thisRevision = and(
    eq(skillRevisions.workspaceId, context.workspaceId),
    eq(skillRevisions.id, allocated.id),
    eq(skillRevisions.pending, true),
  );
  await waitForEarlierRevisions(context, allocated);
  // No transaction is open here: the write takes its own connections from the pool.
  let content;
  try {
    content = await input.write(allocated.number, allocated.abandoned);
  } catch (error) {
    await context.db.delete(skillRevisions).where(thisRevision);
    throw error;
  }
  return completeRevision(context, { name, allocated, thisRevision, content });
}

function allocateRevision(
  { db, workspaceId }: CatalogContext,
  name: string,
  fileCount: number,
): Promise<AllocatedRevision | null> {
  return db.transaction(async (tx) => {
    const skill = (await lockPublishableSkill(tx, workspaceId, name))[0];
    if (skill === undefined) return null;
    const ofSkill = and(
      eq(skillRevisions.workspaceId, workspaceId),
      eq(skillRevisions.skillId, skill.id),
    );
    // Numbered before stale rows go, so an abandoned number is never handed out again.
    const [latest] = await tx
      .select({ number: sql<number>`coalesce(max(${skillRevisions.number}), 0)::int` })
      .from(skillRevisions)
      .where(ofSkill);
    const abandoned = await tx
      .delete(skillRevisions)
      .where(
        and(ofSkill, eq(skillRevisions.pending, true), lt(skillRevisions.createdAt, staleBefore())),
      )
      .returning({ number: skillRevisions.number });
    const number = (latest?.number ?? 0) + 1;
    const [inserted] = await tx
      .insert(skillRevisions)
      .values({ workspaceId, skillId: skill.id, number, fileCount, pending: true })
      .returning({ id: skillRevisions.id });
    if (inserted === undefined) throw new Error('skill revision insert returned no row');
    return {
      id: inserted.id,
      skillId: skill.id,
      number,
      abandoned: abandoned.map((row) => row.number),
    };
  });
}

/** Earlier publishes write first; each check is one query, so no connection is held between. */
async function waitForEarlierRevisions(
  { db, workspaceId }: CatalogContext,
  { skillId, number }: AllocatedRevision,
): Promise<void> {
  for (;;) {
    const [earlier] = await db
      .select({ number: skillRevisions.number })
      .from(skillRevisions)
      .where(
        and(
          eq(skillRevisions.workspaceId, workspaceId),
          eq(skillRevisions.skillId, skillId),
          eq(skillRevisions.pending, true),
          lt(skillRevisions.number, number),
          gt(skillRevisions.createdAt, staleBefore()),
        ),
      )
      .limit(1);
    if (earlier === undefined) return;
    await sleep(SKILL_PUBLISH_POLL_MS);
  }
}

/**
 * Record the revision as complete, and write the publisher's `SKILL.md` and enabled flag to the
 * skill row unless a newer revision completed first.
 */
function completeRevision(
  { db, workspaceId }: CatalogContext,
  completion: {
    readonly name: string;
    readonly allocated: AllocatedRevision;
    readonly thisRevision: SQL | undefined;
    readonly content: Awaited<ReturnType<PublishInput['write']>>;
  },
): Promise<CatalogSkillRevision | null> {
  const { name, allocated, thisRevision, content } = completion;
  const { skillId, number } = allocated;
  return db.transaction(async (tx) => {
    const skill = (await lockPublishableSkill(tx, workspaceId, name))[0];
    if (skill?.id !== skillId) return null;
    const [row] = await tx
      .update(skillRevisions)
      .set({ pending: false })
      .where(thisRevision)
      .returning({
        number: skillRevisions.number,
        fileCount: skillRevisions.fileCount,
        publishedAt: skillRevisions.createdAt,
      });
    if (row === undefined) return null;
    const [newer] = await tx
      .select({ number: skillRevisions.number })
      .from(skillRevisions)
      .where(
        and(
          eq(skillRevisions.workspaceId, workspaceId),
          eq(skillRevisions.skillId, skillId),
          eq(skillRevisions.pending, false),
          gt(skillRevisions.number, number),
        ),
      )
      .limit(1);
    if (content !== undefined && newer === undefined) {
      await tx
        .update(skills)
        .set({ skillMd: content.skillMd, enabled: content.enabled })
        .where(and(eq(skills.workspaceId, workspaceId), eq(skills.id, skillId)));
    }
    return row;
  });
}
