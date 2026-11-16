import { describe } from 'vitest';
import { registerPendingWritesTests } from './resource-catalogs.contract-catalog-pending.js';
import { registerCatalogRemovalTests } from './resource-catalogs.contract-catalog-removal.js';
import { registerReplacementVisibilityTests } from './resource-catalogs.contract-catalog-replacement-visibility.js';
import { registerReplacementWritesTests } from './resource-catalogs.contract-catalog-replacement-writes.js';
import { registerUploadReservationsTests } from './resource-catalogs.contract-catalog-reservations.js';
import { registerCatalogTenancyTests } from './resource-catalogs.contract-catalog-tenancy.js';
import { registerReservationTokensTests } from './resource-catalogs.contract-catalog-tokens.js';
import { registerCatalogTreeTests } from './resource-catalogs.contract-catalog-tree.js';
import { registerUploadVisibilityTests } from './resource-catalogs.contract-catalog-visibility.js';
import type {
  CatalogConformanceFixture,
  SkillCatalogConformanceFixture,
} from './resource-catalogs.contract-fixture.js';
import { registerSkillRemovalTests } from './resource-catalogs.contract-skill-catalog-removal.js';
import { registerSkillRevisionsTests } from './resource-catalogs.contract-skill-catalog-revisions.js';
import { registerSkillRowsTests } from './resource-catalogs.contract-skill-catalog-rows.js';
export type {
  CatalogConformanceFixture,
  SkillCatalogConformanceFixture,
} from './resource-catalogs.contract-fixture.js';
/** Run the same file catalog contract against each adapter. */
export function describeCatalogConformance(
  label: string,
  makeFixture: () => Promise<CatalogConformanceFixture>,
): void {
  describe(`catalog conformance: ${label}`, () => {
    registerUploadVisibilityTests(makeFixture);
    registerUploadReservationsTests(makeFixture);
    registerPendingWritesTests(makeFixture);
    registerCatalogTreeTests(makeFixture);
    registerCatalogRemovalTests(makeFixture);
    registerReplacementVisibilityTests(makeFixture);
    registerReplacementWritesTests(makeFixture);
    registerReservationTokensTests(makeFixture);
    registerCatalogTenancyTests(makeFixture);
  });
}
/** Run the same skill revision contract against each adapter. */
export function describeSkillCatalogConformance(
  label: string,
  makeFixture: () => Promise<SkillCatalogConformanceFixture>,
): void {
  describe(`skill catalog conformance: ${label}`, () => {
    registerSkillRowsTests(makeFixture);
    registerSkillRemovalTests(makeFixture);
    registerSkillRevisionsTests(makeFixture);
  });
}
