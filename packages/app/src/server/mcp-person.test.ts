import type { IdentityAssertionPayload } from '@indx-workspace/contracts/identity-assertion';
import { describe, expect, it } from 'vitest';

import {
  agentPerson,
  cachedMemberDirectory,
  ROLE_CACHE_TTL_MS,
  type MemberRole,
} from './mcp-person.js';

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const MEMBER = '11111111-1111-4111-8111-111111111111';

function payload(overrides: Partial<IdentityAssertionPayload> = {}): IdentityAssertionPayload {
  return {
    sub: MEMBER,
    principalKind: 'membership',
    workspace: WORKSPACE,
    runId: 'run_1',
    aud: 'connector_1',
    exp: 2_000_000_000,
    ...overrides,
  };
}

function directoryOver(members: readonly MemberRole[], clock = { now: 0 }) {
  let fetches = 0;
  const directory = cachedMemberDirectory(
    () => {
      fetches += 1;
      return Promise.resolve(members);
    },
    { now: () => clock.now },
  );
  return { directory, fetches: () => fetches, clock };
}

describe('agentPerson', () => {
  it('gives a member their role, through an agent, in the assertion’s run', async () => {
    const { directory } = directoryOver([{ principalId: MEMBER, role: 'admin' }]);
    expect(await agentPerson(payload(), directory)).toEqual({
      principalId: MEMBER,
      workspaceId: WORKSPACE,
      role: 'admin',
      via: 'agent',
      runId: 'run_1',
    });
  });

  it('gives a membership subject that is no longer a member no role', async () => {
    const { directory } = directoryOver([{ principalId: crypto.randomUUID(), role: 'owner' }]);
    expect((await agentPerson(payload(), directory)).role).toBeNull();
  });

  it.each(['api-key', 'visitor'] as const)(
    'gives an %s subject no role and never looks one up',
    async (principalKind) => {
      const { directory, fetches } = directoryOver([{ principalId: MEMBER, role: 'owner' }]);
      const person = await agentPerson(payload({ principalKind }), directory);
      expect(person).toMatchObject({ principalId: MEMBER, role: null, via: 'agent' });
      expect(fetches()).toBe(0);
    },
  );
});

describe('cachedMemberDirectory', () => {
  it('fetches the members once per 60 s', async () => {
    const { directory, fetches, clock } = directoryOver([{ principalId: MEMBER, role: 'viewer' }]);
    expect(await directory.roleOf(MEMBER)).toBe('viewer');
    clock.now = ROLE_CACHE_TTL_MS - 1;
    expect(await directory.roleOf(MEMBER.toUpperCase())).toBe('viewer');
    expect(fetches()).toBe(1);
    clock.now = ROLE_CACHE_TTL_MS;
    await directory.roleOf(MEMBER);
    expect(fetches()).toBe(2);
  });

  it('shares one fetch between concurrent lookups', async () => {
    const { directory, fetches } = directoryOver([{ principalId: MEMBER, role: 'builder' }]);
    await Promise.all([directory.roleOf(MEMBER), directory.roleOf(MEMBER)]);
    expect(fetches()).toBe(1);
  });

  it('does not cache a failed fetch', async () => {
    let attempts = 0;
    const directory = cachedMemberDirectory(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('down'))
        : Promise.resolve([{ principalId: MEMBER, role: 'owner' as const }]);
    });
    await expect(directory.roleOf(MEMBER)).rejects.toThrow('down');
    expect(await directory.roleOf(MEMBER)).toBe('owner');
  });
});
