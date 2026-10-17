/**
 * §21's four roles.
 *
 * The assertion worth having here is the one about the *duplication*. `ROLES` is written in
 * `roles.ts` because `packages/core/src/db/schema/memberships.ts`'s `membershipRoles` is not
 * reachable — `packages/core/src/db/index.ts` is a narrow barrel that exports the repository layer
 * and nothing else, and neither file is inside this task's ownership. A duplicated constant with a
 * comment on it drifts; a duplicated constant with a gate on it cannot. This file reads the schema
 * as text and fails if the two lists ever differ, in either direction.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';

import { parseRole, requireRole, ROLES } from './roles';

const MEMBERSHIPS_SCHEMA = 'packages/core/src/db/schema/memberships.ts';

/**
 * The `membershipRoles` tuple, read out of the schema.
 *
 * Total and it throws: a schema this parser cannot read is a hard failure, never an empty list —
 * an empty list would make the equality below pass by having nothing on one side of it.
 */
function schemaRoles(): string[] {
  const source = readFileSync(path.join(REPO_ROOT, MEMBERSHIPS_SCHEMA), 'utf8');
  const match = /export const membershipRoles = \[([^\]]*)\] as const;/u.exec(source);
  if (match === null) {
    throw new Error(
      `${MEMBERSHIPS_SCHEMA} no longer declares "export const membershipRoles = [ … ] as const;", ` +
        `so this gate cannot compare it with apps/web/server/rbac/roles.ts and refuses to pass.`,
    );
  }
  const roles = [...(match[1] ?? '').matchAll(/'([^']+)'/gu)].map((entry) => entry[1] ?? '');
  if (roles.length === 0) {
    throw new Error(
      `${MEMBERSHIPS_SCHEMA} declares membershipRoles with no entries this reader saw.`,
    );
  }
  return roles;
}

describe('the four roles', () => {
  it('are exactly the roles the database schema stores', () => {
    expect([...ROLES]).toEqual(schemaRoles());
  });

  it('are the four spec §21 prints, in descending privilege', () => {
    expect([...ROLES]).toEqual(['owner', 'admin', 'builder', 'viewer']);
  });

  it('parse positively, and refuse everything else rather than defaulting to the least one', () => {
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
    for (const value of [
      'Owner',
      'OWNER',
      'superuser',
      'guest',
      '',
      ' owner',
      42,
      null,
      undefined,
      ['owner'],
      { role: 'owner' },
    ]) {
      expect(parseRole(value), `accepted ${JSON.stringify(value)}`).toBeNull();
    }
  });

  it('throws with the value named when a call site has no null branch', () => {
    expect(() => requireRole('superuser', 'a membership row')).toThrowError(/four roles/u);
    expect(requireRole('admin', 'a membership row')).toBe('admin');
  });
});
