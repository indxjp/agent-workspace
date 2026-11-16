import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  type RequiredReference,
  foreignKeysOf,
  tablesByName,
  hasUniqueKeyOver,
} from './tenancy-readers.test-support.js';
import * as schema from './schema/index.js';

export function defineReferences(): void {
  const REQUIRED_REFERENCES: readonly RequiredReference[] = [
    {
      table: schema.sessions,
      name: 'sessions_member_workspace_fk',
      columns: ['workspace_id', 'user_id'],
      foreignTable: 'memberships',
      foreignColumns: ['workspace_id', 'user_id'],
      why:
        '§21/§25: the person a session belongs to must hold a membership in that workspace. ' +
        '`user_id -> users.id` only says the identity exists globally, so without this a ' +
        'workspace can be handed a session owned by someone who was never a member of it.',
    },
  ];

  describe('database schema — references that must be named, because no structural rule implies them', () => {
    it('has at least one required reference to check', () => {
      // The registry is the whole gate. An empty one would make every assertion below pass
      // vacuously, which is the ADR-0015 failure this file exists to forbid.
      expect(REQUIRED_REFERENCES.length).toBeGreaterThan(0);
    });

    it.each(REQUIRED_REFERENCES.map((required) => [required.name, required] as const))(
      '%s is declared, with exactly the columns it must have',
      (name, required) => {
        const found = foreignKeysOf(required.table).find((foreignKey) => foreignKey.name === name);
        expect(
          found,
          `${name} is not declared on ${getTableConfig(required.table).name}. ${required.why}`,
        ).toBeDefined();
        expect(found?.columns, `${name} does not carry the columns it must`).toEqual([
          ...required.columns,
        ]);
        expect(found?.foreignTable, `${name} points at the wrong table`).toBe(
          required.foreignTable,
        );
        expect(found?.foreignColumns, `${name} points at the wrong columns`).toEqual([
          ...required.foreignColumns,
        ]);
        // A composite foreign key PostgreSQL would reject is not a gate either.
        const target = tablesByName.get(required.foreignTable);
        expect(
          target,
          `${name} targets ${required.foreignTable}, which the barrel does not export`,
        ).toBeDefined();
        expect(
          target !== undefined && hasUniqueKeyOver(target, required.foreignColumns),
          `${name} targets ${required.foreignTable} (${required.foreignColumns.join(', ')}), ` +
            'which is not a unique key of that table',
        ).toBe(true);
      },
    );
  });
}
