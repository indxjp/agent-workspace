import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  tables,
  NON_TABLE_MODULES,
  leadingIndexedColumns,
  TENANT_EXEMPT,
} from './tenancy-readers.test-support.js';
import {
  findMigrationsDir,
  trackedMigrationTags,
  migrationTagsInOrder,
  migratedTableNames,
  schemaModuleFiles,
  moduleFileFor,
  SCHEMA_DIR,
} from './tenancy-migration-files.test-support.js';
import * as schema from './schema/index.js';

export function defineInventoryCases(): void {
  describe('database schema — §27 table inventory, derived rather than listed', () => {
    const exportedTableNames = tables.map((table) => getTableConfig(table).name).sort();

    it('applies every migration the tree tracks, and tracks every migration it applies', () => {
      // `migratedTableNames` walks the JOURNAL. A committed `.sql` the journal does not list is a
      // migration nothing runs, and every table it creates is invisible to the cross-check below.
      // A journal entry with no committed `.sql` is the mirror image, and `readFileSync` would
      // throw on it. So the two sets are derived separately and compared.
      const migrationsDir = findMigrationsDir();
      expect(trackedMigrationTags(migrationsDir)).toEqual(
        [...migrationTagsInOrder(migrationsDir)].sort(),
      );
    });

    it('exports exactly the tables the committed migrations create', () => {
      // A table added to the schema and never generated into a migration passes typecheck, passes
      // every other assertion in this file, and fails at deploy time against a real database.
      // This is where it fails instead.
      expect(exportedTableNames).toEqual(migratedTableNames());
    });

    it('has one module per table, named after the table', () => {
      const files = new Set(schemaModuleFiles());
      const missing = exportedTableNames
        .map((name) => moduleFileFor(name))
        .filter((file) => !files.has(file));
      expect(missing, `tables whose module is missing or misnamed: ${missing.join(', ')}`).toEqual(
        [],
      );
    });

    it('has no module that is neither a table nor a recorded helper', () => {
      // The direction that catches the mistake a person actually makes: adding `skills.ts` and
      // forgetting the line in `index.ts`. The file exists, no table is exported for it, and it
      // is not on the helper list — so it is named here rather than silently ignored.
      const tableFiles = new Set(exportedTableNames.map((name) => moduleFileFor(name)));
      const unaccounted = schemaModuleFiles().filter(
        (file) => !tableFiles.has(file) && !(file in NON_TABLE_MODULES),
      );
      expect(
        unaccounted,
        `modules that export no table and are not recorded as helpers: ${unaccounted.join(', ')}. ` +
          'Either export the table from index.ts, or add the file to NON_TABLE_MODULES with a reason.',
      ).toEqual([]);
    });

    it('records a reason for every non-table module, and each one exists', () => {
      const files = new Set(schemaModuleFiles());
      for (const [file, reason] of Object.entries(NON_TABLE_MODULES)) {
        expect(files, `${file} is recorded as a helper but is not in ${SCHEMA_DIR}`).toContain(
          file,
        );
        expect(reason.length, `${file} is recorded as a helper with no reason`).toBeGreaterThan(0);
      }
    });

    it('can actually read index definitions (this test guards the reader, not the schema)', () => {
      // Without this, a change in Drizzle's internals that made `leadingIndexedColumns` return
      // nothing would turn every tenant assertion below into a false failure — or, if the
      // assertion were ever written the other way round, into a false pass.
      expect(leadingIndexedColumns(schema.memberships)).toEqual(
        expect.arrayContaining(['workspace_id', 'user_id']),
      );
    });

    it('exempts only tables with a recorded reason', () => {
      const names = new Set(tables.map((table) => getTableConfig(table).name));
      for (const exempt of Object.keys(TENANT_EXEMPT)) {
        expect(names, `${exempt} is exempted but is not a table`).toContain(exempt);
      }
    });
  });
}
