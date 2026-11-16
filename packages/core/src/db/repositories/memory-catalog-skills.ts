import { setTimeout as sleep } from 'node:timers/promises';
import {
  pendingDeleteFor,
  type CatalogSkill,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  SKILL_PUBLISH_POLL_MS,
  STALE_SKILL_REVISION_MS,
} from './resource-catalogs.js';
import {
  assertSkillShape,
  later,
  byName,
  type SkillState,
  type StoredRevision,
  served,
  type InMemoryWorkspaceCatalog,
} from './memory-catalog-model.js';

export function createMemorySkillCatalog(
  state: SkillState,
): Pick<
  InMemoryWorkspaceCatalog,
  | 'listSkills'
  | 'getSkill'
  | 'putSkill'
  | 'createSkill'
  | 'deleteSkill'
  | 'markSkillDeleting'
  | 'backfillSkillPendingDelete'
  | 'setSkillMeta'
  | 'setSkillBuiltinDigest'
  | 'publishSkillRevision'
  | 'listSkillRevisions'
  | 'assignSkill'
  | 'unassignSkill'
  | 'tryAssignSkill'
  | 'ageSkillRevisions'
> {
  return {
    // @story US-STO-08
    listSkills: () => later(() => [...state.skills.values()].sort(byName)),

    getSkill: (name) => later(() => state.skills.get(name) ?? null),

    putSkill: (input) =>
      later(() => {
        assertSkillShape(input);
        const existing = state.skills.get(input.name);
        const skill: CatalogSkill = {
          id: existing?.id ?? crypto.randomUUID(),
          name: input.name,
          skillMd: input.skillMd,
          enabled: input.enabled,
          createdBy: existing === undefined ? (input.createdBy ?? null) : existing.createdBy,
          ownerPrincipalId: existing?.ownerPrincipalId ?? input.ownerPrincipalId,
          pendingDelete: existing?.pendingDelete ?? null,
          builtinDigest: existing?.builtinDigest ?? null,
          meta: existing?.meta ?? null,
        };
        state.skills.set(skill.name, skill);
        return skill;
      }),

    createSkill: (input) =>
      later(() => {
        assertSkillShape(input);
        if (state.skills.has(input.name)) return null;
        const skill: CatalogSkill = {
          id: crypto.randomUUID(),
          name: input.name,
          skillMd: input.skillMd,
          enabled: input.enabled,
          createdBy: input.createdBy ?? null,
          ownerPrincipalId: input.ownerPrincipalId,
          pendingDelete: null,
          builtinDigest: null,
          meta: null,
        };
        state.skills.set(skill.name, skill);
        return skill;
      }),

    deleteSkill: (name, onlyId) =>
      later((): DeleteCatalogSkillOutcome => {
        const skill = state.skills.get(name);
        if (skill === undefined || (onlyId !== undefined && skill.id !== onlyId)) {
          return { kind: 'not-found' };
        }
        const agents = state.assignments.get(skill.id);
        if (agents !== undefined && agents.size > 0) {
          return { kind: 'in-use', agentIds: [...agents].sort() };
        }
        state.skills.delete(name);
        state.revisions.delete(skill.id);
        state.assignments.delete(skill.id);
        return { kind: 'deleted', skill };
      }),

    markSkillDeleting: (name) =>
      later((): MarkSkillDeletingOutcome => {
        const skill = state.skills.get(name);
        if (skill === undefined) return { kind: 'not-found' };
        const agents = state.assignments.get(skill.id);
        if (agents !== undefined && agents.size > 0) {
          return { kind: 'in-use', agentIds: [...agents].sort() };
        }
        const numbers = (state.revisions.get(skill.id) ?? []).map((r) => r.number);
        const pending = pendingDeleteFor(skill, numbers);
        state.skills.set(name, { ...skill, pendingDelete: pending });
        return { kind: 'marked', pending };
      }),

    backfillSkillPendingDelete: (name, pending) =>
      later(() => {
        const skill = state.skills.get(name);
        if (skill === undefined) return false;
        if (skill.pendingDelete !== null) return true;
        if ((state.assignments.get(skill.id)?.size ?? 0) > 0) return false;
        state.skills.set(name, { ...skill, pendingDelete: pending });
        return true;
      }),

    setSkillMeta: (name, meta, onlyIfEmpty = false) =>
      later(() => {
        const skill = state.skills.get(name);
        if (skill === undefined) return false;
        if (!onlyIfEmpty || skill.meta === null) state.skills.set(name, { ...skill, meta });
        return true;
      }),

    setSkillBuiltinDigest: (name, digest) =>
      later(() => {
        const skill = state.skills.get(name);
        if (skill !== undefined) state.skills.set(name, { ...skill, builtinDigest: digest });
      }),

    publishSkillRevision: async (name, input) => {
      // Allocated in one synchronous step, as the database does under the skill row's lock.
      const skill = await later(() => state.skills.get(name));
      if (skill === undefined || skill.pendingDelete !== null) return null;
      const staleBefore = Date.now() - STALE_SKILL_REVISION_MS;
      const all = state.revisions.get(skill.id) ?? [];
      const stale = (r: StoredRevision) => r.pending && r.publishedAt.getTime() < staleBefore;
      const abandoned = all.filter(stale).map((r) => r.number);
      const kept = all.filter((r) => !stale(r));
      // Numbered before stale rows go, so an abandoned number is never handed out again.
      const number = Math.max(0, ...all.map((r) => r.number)) + 1;
      const allocated: StoredRevision = {
        id: crypto.randomUUID(),
        number,
        fileCount: input.fileCount,
        publishedAt: new Date(),
        pending: true,
      };
      state.revisions.set(skill.id, [allocated, ...kept]);
      const waiting = () =>
        (state.revisions.get(skill.id) ?? []).some(
          (r) => r.pending && r.number < number && r.publishedAt.getTime() >= staleBefore,
        );
      while (waiting()) await sleep(SKILL_PUBLISH_POLL_MS);
      // Keyed on the row's id, as the database does: once abandoned as stale, it is gone for good.
      const mine = (r: StoredRevision) => r.id === allocated.id && r.pending;
      let content;
      try {
        content = await input.write(number, abandoned);
      } catch (error) {
        state.revisions.set(
          skill.id,
          (state.revisions.get(skill.id) ?? []).filter((r) => !mine(r)),
        );
        throw error;
      }
      const current = state.skills.get(name);
      const revisions = state.revisions.get(skill.id) ?? [];
      if (current?.id !== skill.id || current.pendingDelete !== null || !revisions.some(mine)) {
        return null;
      }
      const done: StoredRevision = { ...allocated, pending: false };
      state.revisions.set(
        skill.id,
        revisions.map((r) => (mine(r) ? done : r)),
      );
      const newer = revisions.some((r) => !r.pending && r.number > number);
      if (content !== undefined && !newer) state.skills.set(name, { ...current, ...content });
      return served(done);
    },

    listSkillRevisions: (name, options) =>
      later(() => {
        const skill = state.skills.get(name);
        return skill === undefined
          ? []
          : (state.revisions.get(skill.id) ?? [])
              .filter((r) => options?.includePending === true || !r.pending)
              .map(served);
      }),

    assignSkill: (name, agentId) => {
      const skill = state.skills.get(name);
      if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
      state.assignments.set(skill.id, (state.assignments.get(skill.id) ?? new Set()).add(agentId));
    },

    unassignSkill: (name, agentId) => {
      const skill = state.skills.get(name);
      if (skill === undefined) throw new Error(`no skill named ${name} to unassign`);
      state.assignments.get(skill.id)?.delete(agentId);
    },

    tryAssignSkill: (name, agentId) => {
      const skill = state.skills.get(name);
      if (skill === undefined) throw new Error(`no skill named ${name} to assign`);
      // The refusal the PostgreSQL assignment writers make: a skill being deleted is not assignable.
      if (skill.pendingDelete !== null) return false;
      state.assignments.set(skill.id, (state.assignments.get(skill.id) ?? new Set()).add(agentId));
      return true;
    },

    ageSkillRevisions: (name) => {
      const skill = state.skills.get(name);
      if (skill === undefined) throw new Error(`no skill named ${name} to age`);
      const aged = new Date(Date.now() - STALE_SKILL_REVISION_MS - 1000);
      state.revisions.set(
        skill.id,
        (state.revisions.get(skill.id) ?? []).map((r) =>
          r.pending ? { ...r, publishedAt: aged } : r,
        ),
      );
    },
  };
}
