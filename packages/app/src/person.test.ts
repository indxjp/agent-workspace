import { describe, expect, it } from 'vitest';

import { allows, type Person } from './person.js';
import type { AccessRule } from './resource.js';

const principal = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';

function personWith(role: Person['role']): Person {
  return { principalId: principal, workspaceId: 'w', role, via: 'person' };
}

const ROLES = ['viewer', 'builder', 'admin', 'owner'] as const;

describe('allows', () => {
  // Each role rule against each role: `role:<x>` admits x and every higher role (ADR-0152).
  it.each([
    ['role:viewer', ['viewer', 'builder', 'admin', 'owner']],
    ['role:builder', ['builder', 'admin', 'owner']],
    ['role:admin', ['admin', 'owner']],
    ['role:owner', ['owner']],
    ['member', ['viewer', 'builder', 'admin', 'owner']],
  ] as const)('%s admits exactly %j', (rule, admitted) => {
    for (const role of ROLES) {
      expect(allows(rule, personWith(role)), `${rule} for ${role}`).toBe(
        (admitted as readonly string[]).includes(role),
      );
    }
  });

  it('never admits a person without a role to member or a role rule', () => {
    const guest = personWith(null);
    for (const rule of ['member', 'role:viewer', 'role:owner'] as const) {
      expect(allows(rule, guest)).toBe(false);
    }
  });

  it('admits through a person field only when the record names the person', () => {
    const viewer = personWith('viewer');
    expect(allows('assignee', viewer, { assignee: principal })).toBe(true);
    expect(allows('assignee', viewer, { assignee: 'someone-else' })).toBe(false);
    expect(allows('assignee', viewer, { assignee: null })).toBe(false);
    expect(allows('assignee', viewer)).toBe(false);
  });

  it('reads an array as any one of its rules, and an empty one as nobody', () => {
    const rules: readonly AccessRule[] = ['role:admin', 'assignee'];
    expect(allows(rules, personWith('owner'))).toBe(true);
    expect(allows(rules, personWith('builder'))).toBe(false);
    expect(allows(rules, personWith('builder'), { assignee: principal })).toBe(true);
    expect(allows([], personWith('owner'))).toBe(false);
  });

  it('refuses a role rule naming no role', () => {
    expect(allows('role:superuser', personWith('owner'))).toBe(false);
  });
});
