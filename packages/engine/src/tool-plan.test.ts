/**
 * The permission → tool plan (#951): switches, the `runCommands` withholding and network egress.
 */
import type { AgentPermissionKey, AgentPermissions } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { permissionToolPlan, toolPlanAllowsPermission } from './tool-plan.js';

const NAMES = ['read', 'write', 'edit', 'bash'] as const;
const PERMISSION_OF: Readonly<Record<(typeof NAMES)[number], AgentPermissionKey>> = {
  read: 'readFiles',
  write: 'writeFiles',
  edit: 'writeFiles',
  bash: 'runCommands',
};
const ALL: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};

describe('permissionToolPlan', () => {
  it('offers every tool whose switch is on, in `names` order', () => {
    expect(permissionToolPlan(NAMES, PERMISSION_OF, ALL, false)).toEqual({
      tools: ['read', 'write', 'edit', 'bash'],
      networkEgress: true,
    });
    expect(
      permissionToolPlan(NAMES, PERMISSION_OF, { ...ALL, writeFiles: false }, false).tools,
    ).toEqual(['read', 'bash']);
  });

  it('withholds every runCommands tool while a read-only grant exists', () => {
    expect(permissionToolPlan(NAMES, PERMISSION_OF, ALL, true).tools).toEqual([
      'read',
      'write',
      'edit',
    ]);
  });

  it('reports network egress from the switch alone', () => {
    const closed = permissionToolPlan(
      NAMES,
      PERMISSION_OF,
      { ...ALL, unrestrictedNetwork: false },
      false,
    );
    expect(closed.networkEgress).toBe(false);
  });
});

describe('toolPlanAllowsPermission', () => {
  it('reads a tool permission off the tools and the network off egress', () => {
    const plan = permissionToolPlan(
      NAMES,
      PERMISSION_OF,
      { ...ALL, unrestrictedNetwork: false },
      true,
    );
    expect(toolPlanAllowsPermission(plan, PERMISSION_OF, 'readFiles')).toBe(true);
    expect(toolPlanAllowsPermission(plan, PERMISSION_OF, 'runCommands')).toBe(false);
    expect(toolPlanAllowsPermission(plan, PERMISSION_OF, 'unrestrictedNetwork')).toBe(false);
    expect(
      toolPlanAllowsPermission(
        { ...plan, networkEgress: true },
        PERMISSION_OF,
        'unrestrictedNetwork',
      ),
    ).toBe(true);
  });
});
