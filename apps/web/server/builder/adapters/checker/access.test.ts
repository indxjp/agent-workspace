import { describe, expect, it, vi } from 'vitest';

import { decide, type Ownership } from '../../../rbac/decide';
import { ROLES } from '../../../rbac/roles';
import { mayCheck } from './access';

const denied = vi.hoisted(() => ({ pointers: false }));

vi.mock('../../../rbac/decide', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../rbac/decide')>();
  return {
    ...real,
    decide: (query: Parameters<typeof real.decide>[0]) =>
      denied.pointers && query.method === 'PUT' && query.path.endsWith('/pointers')
        ? { ...real.decide(query), effect: 'deny' as const }
        : real.decide(query),
  };
});

const OWNER = 'p-owner';
const AGENT = { id: 'a1', ownerPrincipalId: OWNER };

describe('mayCheck on an existing agent', () => {
  it.each(ROLES.flatMap((role) => (['own', 'other'] as const).map((who) => ({ role, who }))))(
    'is the conjunction of POST versions and PUT pointers for $role, $who agent',
    ({ role, who }) => {
      const ownership: Ownership = who;
      const caller = { role, ownerPrincipalId: who === 'own' ? OWNER : 'p-someone-else' };
      const allowed = (method: 'POST' | 'PUT', sub: string) =>
        decide({
          role,
          method,
          scope: null,
          path: `/api/agents/${AGENT.id}/${sub}`,
          ownership,
        }).effect === 'allow';

      denied.pointers = false;
      expect(mayCheck(caller, AGENT)).toBe(
        allowed('POST', 'versions') && allowed('PUT', 'pointers'),
      );
    },
  );

  it('is false wherever PUT pointers is denied, though POST versions is allowed', () => {
    const caller = { role: 'builder' as const, ownerPrincipalId: OWNER };
    denied.pointers = false;
    expect(mayCheck(caller, AGENT)).toBe(true);
    denied.pointers = true;
    expect(mayCheck(caller, AGENT)).toBe(false);
    expect(mayCheck(caller, undefined)).toBe(true);
    denied.pointers = false;
  });
});
