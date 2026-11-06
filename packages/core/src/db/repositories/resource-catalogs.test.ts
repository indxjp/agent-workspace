import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInMemoryCatalog } from './memory-catalog.js';
import {
  describeCatalogConformance,
  describeSkillCatalogConformance,
} from './resource-catalogs.contract.js';
import { describeCatalogFileTests } from './resource-catalogs.files.test-support.js';
import { defineCatalogPostgresFixture } from './resource-catalogs.fixture.test-support.js';
import { describeCatalogFolderTests } from './resource-catalogs.folders.test-support.js';
import { describeCatalogParentTests } from './resource-catalogs.parents.test-support.js';
import { describeCatalogRevisionTests } from './resource-catalogs.revisions.test-support.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

describeCatalogConformance('the in-memory catalog', () => {
  const provider = createInMemoryCatalog();
  const workspaceIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  return Promise.resolve({
    catalog: (workspace) => provider.forWorkspace(workspaceIds[workspace]),
    ownerA,
    ownerB,
    actorA: crypto.randomUUID(),
    seed: (workspace, row) =>
      Promise.resolve().then(() =>
        provider
          .forWorkspace(workspaceIds[workspace])
          .seed({ ...row, ownerPrincipalId: workspace === 'a' ? ownerA : ownerB }),
      ),
  });
});

describeSkillCatalogConformance('the in-memory catalog', () => {
  const provider = createInMemoryCatalog();
  const workspaceIds = { a: crypto.randomUUID(), b: crypto.randomUUID() };
  return Promise.resolve({
    catalog: (workspace) => provider.forWorkspace(workspaceIds[workspace]),
    ownerA: crypto.randomUUID(),
    ownerB: crypto.randomUUID(),
    actorA: crypto.randomUUID(),
    assign: (workspace, skill) => {
      const agentId = crypto.randomUUID();
      provider.forWorkspace(workspaceIds[workspace]).assignSkill(skill.name, agentId);
      return Promise.resolve(agentId);
    },
    unassign: (workspace, skill, agentId) =>
      Promise.resolve().then(() =>
        provider.forWorkspace(workspaceIds[workspace]).unassignSkill(skill.name, agentId),
      ),
    ageRevisions: (name) =>
      Promise.resolve().then(() => provider.forWorkspace(workspaceIds.a).ageSkillRevisions(name)),
  });
});

it('failNext rejects the next call of one operation, once', async () => {
  const provider = createInMemoryCatalog();
  const catalog = provider.forWorkspace(crypto.randomUUID());
  const input = {
    ownerPrincipalId: crypto.randomUUID(),
    sizeBytes: 1,
    contentType: null,
    objectId: crypto.randomUUID(),
  };
  provider.failNext('reserve', new Error('store down'));
  await expect(catalog.get('a.txt')).resolves.toBeNull();
  await expect(catalog.reserve('a.txt', input)).rejects.toThrow('store down');
  await expect(catalog.reserve('a.txt', input)).resolves.toMatchObject({ kind: 'reserved' });
});

describe.skipIf(!hasDatabase)('ResourceCatalogRepository against PostgreSQL', () => {
  defineCatalogPostgresFixture();
  describeCatalogFileTests();
  describeCatalogParentTests();
  describeCatalogFolderTests();
  describeCatalogRevisionTests();
});
