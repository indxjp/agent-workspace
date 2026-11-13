import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  foreignKeysOf,
  tables,
  leadingIndexedColumns,
  TENANT_EXEMPT,
  TENANT_COLUMN,
} from './tenancy-readers.test-support.js';
export function defineIsolationCases(): void {
  describe('database schema — §25 tenant isolation', () => {
    it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
      '%s is either exempt or fully workspace-scoped',
      (name, table) => {
        const config = getTableConfig(table);
        const workspaceColumn = config.columns.find((column) => column.name === 'workspace_id');

        if (name in TENANT_EXEMPT) {
          // An exempt table must not carry the column: half a scoping is worse than none,
          // because a query can then filter on a column nothing maintains.
          expect(
            workspaceColumn,
            `${name} is on the exemption list (${TENANT_EXEMPT[name] ?? ''}) but has a workspace_id column`,
          ).toBeUndefined();
          return;
        }

        // Not exempt: the table must prove it is tenant-scoped. Each assertion below names the
        // property it requires, so a failure says which one is missing rather than "false".
        expect(
          workspaceColumn,
          `${name} has no workspace_id and is not on the exemption list`,
        ).toBeDefined();
        expect(workspaceColumn?.notNull, `${name}.workspace_id is nullable`).toBe(true);

        // Exactly one foreign key whose whole column list is `workspace_id`: the reference to the
        // tenant root. Filtering on "contains workspace_id" would now match the tenant-paired
        // composite keys too, so this asks for the shape it means.
        //
        // The keys this narrowing drops are not unexamined: every foreign key on the table is
        // classified into a named bucket by the `§25 cross-tenant referential integrity` rule
        // below, whose `else` collects a fault. What is asserted here is the count.
        const rootReferences = foreignKeysOf(table).filter(
          (foreignKey) =>
            foreignKey.columns.length === 1 && foreignKey.columns[0] === TENANT_COLUMN,
        );
        expect(
          rootReferences.map((foreignKey) => foreignKey.name),
          `${name}.workspace_id must have exactly one single-column foreign key, to workspaces`,
        ).toHaveLength(1);
        const rootReference = rootReferences[0];
        expect(
          rootReference?.foreignTable,
          `${name}.workspace_id does not reference workspaces`,
        ).toBe('workspaces');
        expect(
          rootReference?.foreignColumns,
          `${name}.workspace_id references the wrong column of workspaces`,
        ).toEqual(['id']);

        expect(
          leadingIndexedColumns(table),
          `${name}.workspace_id leads no index, so every tenant-scoped query is a sequential scan`,
        ).toContain('workspace_id');
      },
    );
  });
}
