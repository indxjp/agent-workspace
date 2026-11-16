import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  foreignKeysOf,
  tablesByName,
  hasUniqueKeyOver,
  tables,
  TENANT_EXEMPT,
  TENANT_COLUMN,
  isTenantScoped,
  tenantPairingFault,
  referenceIdentityOf,
  workspaceSelfPairingFault,
  workspaceSelfReferenceIdentityOf,
  REFERENCE_SUFFIX,
  NON_REFERENCE_ID_COLUMNS,
  splitDeclarationKey,
} from './tenancy-readers.test-support.js';
import * as schema from './schema/index.js';

export function defineReferenceCases(): void {
  describe('database schema — §25 cross-tenant referential integrity', () => {
    it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
      'every reference %s makes is either tenant-paired or provably cannot be',
      (name, table) => {
        // Each foreign key must land in exactly one accepted bucket. Anything that lands in none
        // is collected and fails the test by name — this is the explicit `else` that REJECTS,
        // rather than a filter that quietly matches nothing (ADR-0015).
        const faults: string[] = [];
        const allForeignKeys = foreignKeysOf(table);

        // The references that ARE tenant-paired, by reference identity. A constraint that is not
        // paired is acceptable only when a paired constraint says the same thing.
        //
        // This narrowing builds an ALLOWANCE set, so dropping a member can only make the rule
        // stricter, never green: a key that does not land here still has to be classified by the
        // loop below, and the loop's `else` pushes a fault.
        const pairedIdentities = new Set(
          allForeignKeys
            .filter(
              (foreignKey) =>
                isTenantScoped(foreignKey.foreignTable) &&
                tenantPairingFault(foreignKey) === undefined,
            )
            .map(referenceIdentityOf),
        );

        // The `workspaces`-scoped mirror of the set above, built only when it can be non-empty —
        // see `workspaceSelfPairingFault`'s comment for why this table alone gets one.
        const workspaceSelfPairedIdentities =
          name === 'workspaces'
            ? new Set(
                allForeignKeys
                  .filter(
                    (foreignKey) =>
                      isTenantScoped(foreignKey.foreignTable) &&
                      workspaceSelfPairingFault(foreignKey) === undefined,
                  )
                  .map(workspaceSelfReferenceIdentityOf),
              )
            : new Set<string>();

        for (const foreignKey of allForeignKeys) {
          const fault = foreignKeyFault(
            name,
            foreignKey,
            pairedIdentities,
            workspaceSelfPairedIdentities,
          );
          if (fault !== undefined) faults.push(fault);
        }

        expect(faults, `${name}: ${faults.join('; ')}`).toEqual([]);
      },
    );

    it.each(tables.map((table) => [getTableConfig(table).name, table] as const))(
      'every *_id column on %s is a foreign key or a declared non-reference',
      (name, table) => {
        // Without this, the pairing rule above could be satisfied by deleting the constraint:
        // a bare `agent_id not null` with no foreign key at all has nothing to pair, so it would
        // pass by having no references to check. Here it fails.
        //
        // The contributing set is derived by shape — every column whose name ends in `_id`, at
        // any SQL type — and every member is CLASSIFIED, not filtered. The `else` at the bottom
        // rejects by name, so a column the classifier cannot place is a failure rather than a
        // column the gate silently stopped covering (ADR-0027).
        const referenced = new Set(
          foreignKeysOf(table).flatMap((foreignKey) => foreignKey.columns),
        );
        // DECLARED NARROWING (ADR-0028), and the one this file cannot convert. The subject of this
        // rule IS the `*_id` naming convention, so this line is a filter: a column named `owner` or
        // `parent` that holds a foreign identifier is dropped here and no `else` rejects it.
        // Nothing in Drizzle's metadata identifies an intended referent for a column that carries
        // no foreign key, so there is no positive rule to classify the complement with. What would
        // make this wrong is a table in a later wave holding a reference in a column without the
        // suffix; the pull request declares it, and the failure message below prints the set this
        // line derived so a reader can see what was inspected.
        const idColumns = getTableConfig(table).columns.filter((column) =>
          column.name.endsWith(REFERENCE_SUFFIX),
        );
        const derived = idColumns.map((column) => `${column.name} ${column.getSQLType()}`);
        const faults: string[] = [];

        for (const column of idColumns) {
          const key = `${name}.${column.name}`;
          const sqlType = column.getSQLType();

          if (referenced.has(column.name)) {
            // Bucket 1: a live reference, covered by a foreign key. The pairing rule above then
            // decides whether that foreign key is tenant-paired.
            if (key in NON_REFERENCE_ID_COLUMNS) {
              faults.push(
                `${key} is declared in NON_REFERENCE_ID_COLUMNS but IS covered by a foreign key; ` +
                  'the declaration is dead and must be deleted',
              );
            }
            continue;
          }

          const declared = NON_REFERENCE_ID_COLUMNS[key];
          if (declared === undefined) {
            // The else that rejects. This is the whole gate.
            faults.push(
              `${key} (${sqlType}) is named like a reference, is covered by no foreign key, and ` +
                'is not declared in NON_REFERENCE_ID_COLUMNS. Either give it a foreign key, or ' +
                'declare it there with its SQL type and the reason it refers to nothing in this ' +
                'schema',
            );
            continue;
          }
          if (declared.sqlType !== sqlType) {
            faults.push(
              `${key} is declared as ${declared.sqlType} but is ${sqlType}; the declaration was ` +
                'written about a different column and must be re-taken',
            );
            continue;
          }
          if (declared.why.trim() === '') {
            faults.push(`${key} is declared a non-reference with no reason`);
            continue;
          }
          // Bucket 2: a declared non-reference, at the type it was declared at, with a reason.
        }

        expect(
          faults,
          `${name}: ${faults.join('; ')}. The *_id columns this gate derived on ${name}: ` +
            `${derived.length === 0 ? '(none)' : derived.join(', ')}`,
        ).toEqual([]);
      },
    );

    it('declares no non-reference *_id column that is stale or misnamed', () => {
      // The registry is only as good as its entries. An entry naming a column that no longer
      // exists is a declaration nothing is testing, and it would sit there excusing a name a
      // later table might reuse.
      const faults: string[] = [];
      for (const [key, declared] of Object.entries(NON_REFERENCE_ID_COLUMNS)) {
        const [tableName, columnName] = splitDeclarationKey(key);
        if (!columnName.endsWith(REFERENCE_SUFFIX)) {
          faults.push(`${key} does not end in ${REFERENCE_SUFFIX}, so this gate never inspects it`);
          continue;
        }
        const table = tablesByName.get(tableName);
        if (table === undefined) {
          faults.push(`${key} names ${tableName}, which the schema barrel does not export`);
          continue;
        }
        const column = getTableConfig(table).columns.find((each) => each.name === columnName);
        if (column === undefined) {
          faults.push(`${key} names a column ${tableName} does not have`);
          continue;
        }
        if (declared.why.trim() === '') faults.push(`${key} is declared with no reason`);
      }
      expect(
        faults,
        `${faults.join('; ')}. Declared non-references: ${Object.keys(NON_REFERENCE_ID_COLUMNS).join(', ')}`,
      ).toEqual([]);
    });

    it('can actually read foreign keys and unique keys (this test guards the readers)', () => {
      // The companion to the index-reader canary above. If a Drizzle internals change made
      // `foreignKeysOf` return nothing, every assertion in this file would pass vacuously — which
      // is precisely the failure ADR-0015 exists to forbid. These two facts are read from the
      // schema, so they break loudly instead.
      const sessionKeys = foreignKeysOf(schema.sessions).map((foreignKey) => foreignKey.name);
      expect(sessionKeys).toContain('sessions_agent_workspace_fk');
      expect(hasUniqueKeyOver(schema.agents, ['id', 'workspace_id'])).toBe(true);
      expect(hasUniqueKeyOver(schema.agents, ['id', 'name'])).toBe(false);
    });
  });
}

function foreignKeyFault(
  name: string,
  foreignKey: ReturnType<typeof foreignKeysOf>[number],
  pairedIdentities: ReadonlySet<string>,
  workspaceSelfPairedIdentities: ReadonlySet<string>,
): string | undefined {
  const isRootReference =
    foreignKey.columns.length === 1 &&
    foreignKey.columns[0] === TENANT_COLUMN &&
    foreignKey.foreignTable === 'workspaces';

  if (isRootReference) {
    // Bucket 1: the reference to the tenant root itself, checked in detail above.
    return undefined;
  }

  if (foreignKey.foreignTable === 'workspaces') {
    return (
      `${foreignKey.name} references workspaces through (${foreignKey.columns.join(', ')}); ` +
      `the only reference to the tenant root may be the single ${TENANT_COLUMN} column`
    );
  }

  if (!isTenantScoped(foreignKey.foreignTable)) {
    // Bucket 2: a reference to a tenant-exempt table — a global identity. It CANNOT be
    // tenant-paired, because the target has no workspace_id to pair against, so pairing
    // is not required. It must also not pretend to: a workspace_id in this key would be
    // matched against a column that does not exist.
    if (foreignKey.columns.includes(TENANT_COLUMN)) {
      return (
        `${foreignKey.name} includes ${TENANT_COLUMN} but targets ` +
        `${foreignKey.foreignTable}, which is tenant-exempt ` +
        `(${TENANT_EXEMPT[foreignKey.foreignTable] ?? ''})`
      );
    }
    return undefined;
  }

  // Bucket 3: a reference from one tenant-scoped table to another. It MUST be paired —
  // by this constraint, or by a sibling constraint saying the same thing (see
  // `referenceIdentityOf`) — and its target must be a declared unique key, or PostgreSQL
  // would not accept it.
  const fault = tenantPairingFault(foreignKey);
  if (fault !== undefined) {
    if (pairedIdentities.has(referenceIdentityOf(foreignKey))) {
      // Bucket 4: unpaired, but a tenant-paired sibling constrains the same reference.
      return undefined;
    }
    if (
      name === 'workspaces' &&
      (workspaceSelfPairingFault(foreignKey) === undefined ||
        workspaceSelfPairedIdentities.has(workspaceSelfReferenceIdentityOf(foreignKey)))
    ) {
      // Bucket 5, `workspaces`-only: paired against this table's own `id` instead of a
      // `workspace_id` it structurally cannot have — directly, or by a self-paired sibling
      // constraint saying the same thing. See `workspaceSelfPairingFault`'s comment.
      return undefined;
    }
    return (
      `${foreignKey.name} -> ${foreignKey.foreignTable} ${fault}, and no other constraint ` +
      `pairs the same reference. Both tables are tenant-scoped, so this lets a ${name} ` +
      `row point at a ${foreignKey.foreignTable} row in a different workspace`
    );
  }

  const target = tablesByName.get(foreignKey.foreignTable);
  if (target === undefined) {
    return (
      `${foreignKey.name} targets ${foreignKey.foreignTable}, which the schema barrel ` +
      'does not export, so this test cannot verify its key'
    );
  }
  if (!hasUniqueKeyOver(target, foreignKey.foreignColumns)) {
    return (
      `${foreignKey.name} targets ${foreignKey.foreignTable} ` +
      `(${foreignKey.foreignColumns.join(', ')}), which is not a unique key of that ` +
      'table; PostgreSQL will reject the migration'
    );
  }

  return undefined;
}
