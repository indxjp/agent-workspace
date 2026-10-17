/**
 * `GET /api/platforms` (issue #968) driven as Next.js would drive it: the handler goes through
 * `authorise`, every role may read the catalogue, and a caller with no credential gets `401`.
 * Concealment is not applicable: the catalogue is the same for every caller and has no `:id`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PlatformListResponseSchema } from '@indx-workspace/contracts/platforms';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';

import { ROLES, type Role } from '../../../server/rbac/roles';
import {
  installRbacHarness,
  TEST_WORKSPACE_ID,
  type RbacHarness,
} from '../../../server/rbac/testing';

import { GET } from './route';

let live: RbacHarness | null = null;

afterEach(() => {
  live?.teardown();
  live = null;
});

function harness(): RbacHarness {
  const built = installRbacHarness(
    ROLES.map((role) => ({
      email: `${role}@example.test`,
      name: `A ${role}`,
      workspaceId: TEST_WORKSPACE_ID,
      role,
    })),
  );
  live = built;
  return built;
}

describe('GET /api/platforms', () => {
  it.each(ROLES.map((role) => [role] as const))(
    'lets a %s read every target, as the published contract',
    async (role: Role) => {
      const built = harness();

      const response = await built.call(GET, {
        method: 'GET',
        path: '/api/platforms',
        as: { email: `${role}@example.test` },
      });

      expect(response.status).toBe(200);
      const parsed = PlatformListResponseSchema.parse(response.body);
      expect(parsed.platforms.map((platform) => platform.id)).toStrictEqual(
        PLATFORM_TARGETS.map((target) => target.id),
      );
      expect(response.text).not.toContain('optionsSchema');
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('answers 401 and serves nothing without a usable credential', async () => {
    const built = harness();

    const response = await built.call(GET, { method: 'GET', path: '/api/platforms', as: null });

    expect(response.status).toBe(401);
    expect(response.text).not.toContain('copilot-studio');
  });
});
