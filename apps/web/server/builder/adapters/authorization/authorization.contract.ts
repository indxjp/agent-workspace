import { BUILDER_TOOL_NAMES, BUILDER_TOOLS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { TEST_DOOR } from '../../testing/context';
import { ROLES, type Role } from '../../../rbac/roles';
import type { Facts } from '../../core/facts';
import type { AuthorizationPort, BuilderToolKind, CallContext } from '../../ports';

export interface AuthorizationFixture {
  readonly port: AuthorizationPort;
  /** Create an agent owned by `ownerPrincipalId` in `workspaceId` and return its id. */
  agent(workspaceId: string, ownerPrincipalId: string): Promise<string>;
  /** Give `userId` an `agent_grants` row on `agentId`. */
  grant(workspaceId: string, agentId: string, userId: string): Promise<void>;
}

type Access = Facts['access'];

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SOMEONE_ELSE = '33333333-3333-4333-8333-333333333333';
const KINDS: readonly BuilderToolKind[] = ['read', 'write', 'spend'];

function person(role: string, workspaceId = WORKSPACE): CallContext {
  const principalId = `principal-${role}`;
  return {
    workspaceId: WORKSPACE,
    door: TEST_DOOR,
    runId: 'run-1',
    traceId: 'trace-1',
    modelId: 'model-1',
    promptVersion: 'prompt-1',
    caller: {
      kind: 'person',
      principal: {
        workspaceId,
        principalId,
        ownerPrincipalId: principalId,
        userId: `user-${role}`,
        // An unknown role must fail closed, so the tests may hand one over.
        role: role as Role,
      },
    },
  };
}

const nobody: CallContext = { ...person('owner'), caller: { kind: 'none' } };

/** The permission matrix of design §05 "The Builder gets more power than the person". */
export function describeAuthorizationConformance(
  label: string,
  make: () => AuthorizationFixture,
): void {
  describe(`AuthorizationPort: ${label}`, () => {
    const world = async (role: string) => {
      const fixture = make();
      const ctx = person(role);
      const own = await fixture.agent(WORKSPACE, `principal-${role}`);
      const other = await fixture.agent(WORKSPACE, SOMEONE_ELSE);
      return { fixture, ctx, own, other };
    };

    const matrix: readonly [Role, BuilderToolKind, Access, Access][] = [
      ['owner', 'read', 'allowed', 'allowed'],
      ['owner', 'write', 'allowed', 'allowed'],
      ['owner', 'spend', 'allowed', 'allowed'],
      ['admin', 'read', 'allowed', 'allowed'],
      ['admin', 'write', 'allowed', 'allowed'],
      ['admin', 'spend', 'allowed', 'allowed'],
      ['builder', 'read', 'allowed', 'allowed'],
      ['builder', 'write', 'allowed', 'not_owner'],
      ['builder', 'spend', 'allowed', 'not_owner'],
      ['viewer', 'read', 'allowed', 'allowed'],
      ['viewer', 'write', 'not_permitted', 'not_permitted'],
      ['viewer', 'spend', 'allowed', 'not_owner'],
    ];

    it.each(matrix)('%s, %s: own agent %s, other agent %s', async (role, kind, own, other) => {
      const w = await world(role);
      await expect(w.fixture.port.access(w.ctx, kind, w.own)).resolves.toBe(own);
      await expect(w.fixture.port.access(w.ctx, kind, w.other)).resolves.toBe(other);
    });

    it('no Builder tool needs more than Admin: an Admin is allowed every tool kind on any agent', async () => {
      const w = await world('admin');
      for (const name of BUILDER_TOOL_NAMES) {
        const kind = BUILDER_TOOLS[name].kind;
        await expect(w.fixture.port.access(w.ctx, kind, w.other)).resolves.toBe('allowed');
      }
    });

    it.each(['builder', 'viewer'] as const)(
      'a granted %s may spend on, but never write to, the granted agent',
      async (role) => {
        const w = await world(role);
        await expect(w.fixture.port.access(w.ctx, 'spend', w.other)).resolves.not.toBe('allowed');
        await w.fixture.grant(WORKSPACE, w.other, `user-${role}`);
        await expect(w.fixture.port.access(w.ctx, 'spend', w.other)).resolves.toBe('allowed');
        // draft_save and evals_run are both kind write; the console's evaluations route is a write.
        await expect(w.fixture.port.access(w.ctx, 'write', w.other)).resolves.not.toBe('allowed');
        await expect(w.fixture.port.access(w.ctx, 'read', w.other)).resolves.toBe('allowed');
      },
    );

    it('ignores a grant that names someone else', async () => {
      const w = await world('builder');
      await w.fixture.grant(WORKSPACE, w.other, 'user-viewer');
      await expect(w.fixture.port.access(w.ctx, 'spend', w.other)).resolves.toBe('not_owner');
    });

    it.each(ROLES)('a missing agent and a malformed id are not_owner for %s', async (role) => {
      const w = await world(role);
      const missing = '44444444-4444-4444-8444-444444444444';
      for (const kind of KINDS) {
        await expect(w.fixture.port.access(w.ctx, kind, missing)).resolves.toBe('not_owner');
        await expect(w.fixture.port.access(w.ctx, kind, 'not-a-uuid')).resolves.toBe('not_owner');
      }
    });

    it('treats an agent of another workspace as missing, even for an owner', async () => {
      const w = await world('owner');
      const foreign = await w.fixture.agent(OTHER_WORKSPACE, 'principal-owner');
      await expect(w.fixture.port.access(w.ctx, 'read', foreign)).resolves.toBe('not_owner');
    });

    it.each([
      ['owner', 'allowed', 'allowed', 'not_permitted'],
      ['admin', 'allowed', 'allowed', 'not_permitted'],
      ['builder', 'allowed', 'allowed', 'not_permitted'],
      ['viewer', 'allowed', 'not_permitted', 'not_permitted'],
    ] as const)('names no agent: %s reads %s, writes %s, spends %s', async (role, r, w, s) => {
      const { fixture, ctx } = await world(role);
      await expect(fixture.port.access(ctx, 'read')).resolves.toBe(r);
      await expect(fixture.port.access(ctx, 'write')).resolves.toBe(w);
      await expect(fixture.port.access(ctx, 'spend')).resolves.toBe(s);
    });

    it('fails closed on an unknown role', async () => {
      const w = await world('superuser');
      for (const kind of KINDS) {
        await expect(w.fixture.port.access(w.ctx, kind, w.own)).resolves.toBe('not_permitted');
      }
    });

    it('fails closed with no caller', async () => {
      const { fixture, own } = await world('owner');
      for (const kind of KINDS) {
        await expect(fixture.port.access(nobody, kind, own)).resolves.toBe('not_permitted');
      }
    });

    it('fails closed when the caller belongs to another workspace', async () => {
      const { fixture, own } = await world('owner');
      const stranger = person('owner', OTHER_WORKSPACE);
      for (const kind of KINDS) {
        await expect(fixture.port.access(stranger, kind, own)).resolves.toBe('not_permitted');
      }
    });
  });
}
