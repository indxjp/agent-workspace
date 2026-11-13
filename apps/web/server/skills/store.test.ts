/**
 * The skills port on the in-memory catalog, and the port's types against the catalog's (refactoring
 * plan part 07, steps 5–6). The PostgreSQL half is `store.postgres.test.ts`.
 */
import crypto from 'node:crypto';

import {
  createInMemoryCatalog,
  type CatalogSkill,
  type CatalogSkillRevision,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome as CatalogMarkSkillDeletingOutcome,
  type PendingSkillDelete as CatalogPendingSkillDelete,
  type ResourceCatalogRepository,
} from '@agent-workspace/core/db';
import { expect, expectTypeOf, it } from 'vitest';

import type {
  DeleteSkillRowOutcome,
  MarkSkillDeletingOutcome,
  PendingSkillDelete,
  SkillRevisionRow,
  SkillRow,
  SkillRowInput,
} from './ports';
import { parsePendingSkillDelete, skillCatalogOf } from './store';
import { describeSkillCatalogContract } from './store.contract';

describeSkillCatalogContract('the in-memory catalog', () => {
  const provider = createInMemoryCatalog();
  const ids = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  return Promise.resolve({
    catalog: (workspace) => skillCatalogOf(provider.forWorkspace(ids[workspace])),
    ownerA: crypto.randomUUID(),
    assign: (skill) => {
      const agentId = crypto.randomUUID();
      provider.forWorkspace(ids.a).assignSkill(skill.name, agentId);
      return Promise.resolve(agentId);
    },
  });
});

it("the port's types are the catalog's, both ways", () => {
  expectTypeOf<SkillRow>().toEqualTypeOf<CatalogSkill>();
  expectTypeOf<SkillRowInput>().toEqualTypeOf<
    Parameters<ResourceCatalogRepository['putSkill']>[0]
  >();
  expectTypeOf<SkillRevisionRow>().toEqualTypeOf<CatalogSkillRevision>();
  expectTypeOf<PendingSkillDelete>().toEqualTypeOf<CatalogPendingSkillDelete>();
  expectTypeOf<DeleteSkillRowOutcome>().toEqualTypeOf<DeleteCatalogSkillOutcome>();
  expectTypeOf<MarkSkillDeletingOutcome>().toEqualTypeOf<CatalogMarkSkillDeletingOutcome>();
});

it('reads a pending-delete record as the catalog does', () => {
  expect(parsePendingSkillDelete({ ownerPrincipalId: 'p', revisions: [1, 2] })).toEqual({
    ownerPrincipalId: 'p',
    revisions: [1, 2],
  });
  expect(parsePendingSkillDelete({ ownerPrincipalId: 3, revisions: [0] })).toEqual({
    ownerPrincipalId: null,
    revisions: [],
  });
  expect(parsePendingSkillDelete('garbage')).toEqual({ ownerPrincipalId: null, revisions: [] });
});
