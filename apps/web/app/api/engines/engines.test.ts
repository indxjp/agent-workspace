/**
 * `GET /api/engines`, driven as Next.js would drive it — issue #319 (ENG-02c).
 *
 * `apps/web/server/engines/handlers.test.ts` proves the projection; this file proves the
 * **wiring**: that the handler goes through `authorise`, that every one of §21's four roles and
 * both principal kinds may read the catalogue, and that a caller with no usable credential is
 * answered `401` rather than handed the deployment's engine list.
 *
 * ## Concealment is not applicable, and that is a fact about the route
 *
 * There is no `:id` here and no row: the catalogue is the same for every caller in every
 * workspace, which is why `authorise` is given `'not-applicable'` and why there is no
 * cross-tenant case to test. Stated rather than left as an omission a reader has to interpret
 * (ADR-0031).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { EngineListResponseSchema } from '@indx-workspace/contracts/engines';

import { conferredBy } from '../../../server/rbac/conferral';
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

/** One member per role, so the matrix below is driven by real memberships. */
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

describe('GET /api/engines across the role matrix', () => {
  it.each(ROLES.map((role) => [role] as const))(
    'lets a %s read the catalogue this deployment registers',
    async (role: Role) => {
      const built = harness();

      const response = await built.call(GET, {
        method: 'GET',
        path: '/api/engines',
        as: { email: `${role}@example.test` },
      });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        // Every engine this release registers, in registry order. The development image map
        // configures only the Claude runtime image, so only it is installed (ADR-0073 D2).
        engines: [
          {
            id: 'claude-agent-sdk',
            installed: true,
            displayName: 'Claude Agent SDK',
            version: expect.any(String) as unknown,
            capabilities: expect.objectContaining({
              wireProtocols: ['anthropic-messages'],
            }) as unknown,
          },
          {
            id: 'openai-agents',
            installed: false,
            displayName: 'OpenAI Agents SDK',
            version: expect.any(String) as unknown,
            capabilities: expect.objectContaining({
              skills: false,
              maxBudget: 'adapter',
              wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
            }) as unknown,
          },
          {
            id: 'pi',
            installed: false,
            displayName: 'pi coding agent',
            version: expect.any(String) as unknown,
            capabilities: expect.objectContaining({
              mcp: false,
              wireProtocols: ['anthropic-messages'],
            }) as unknown,
          },
          {
            id: 'mastra',
            installed: false,
            displayName: 'Mastra',
            version: expect.any(String) as unknown,
            capabilities: expect.objectContaining({
              mcp: true,
              fork: false,
              maxTurns: 'native',
              wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
            }) as unknown,
          },
        ],
      });
      // `authorise` is the only caller of `forWorkspace` in the program and it calls it on the
      // `allow` branch alone, so this is a positive record that the gate ran.
      expect(built.scopedWorkspaces).toEqual([TEST_WORKSPACE_ID]);
      expect(response.headers.get('cache-control')).toBe('no-store');
    },
  );

  it('answers a body the published contract validates', async () => {
    const built = harness();

    const response = await built.call(GET, {
      method: 'GET',
      path: '/api/engines',
      as: { email: 'viewer@example.test' },
    });

    expect(EngineListResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it('serves an API-key principal, which is the credential `aw engines list` presents', async () => {
    const built = harness();
    const minted = await built.directory.forWorkspace(TEST_WORKSPACE_ID).createApiKey({
      name: 'ci',
      role: conferredBy('owner', 'viewer', 'the fixture in app/api/engines/engines.test.ts'),
      expiresAt: null,
    });
    if (minted.kind !== 'created') throw new Error('the fixture could not mint a key');

    const response = await built.call(GET, {
      method: 'GET',
      path: '/api/engines',
      as: null,
      bearer: minted.presented,
    });

    expect(response.status).toBe(200);
  });
});

describe('GET /api/engines without a usable credential', () => {
  it('answers 401 and scopes nothing', async () => {
    const built = harness();

    const response = await built.call(GET, { method: 'GET', path: '/api/engines', as: null });

    expect(response.status).toBe(401);
    expect(built.scopedWorkspaces).toEqual([]);
    expect(response.text).not.toContain('claude-agent-sdk');
  });

  it('answers 503 on a deployment with no RBAC runtime, because nothing was checked', async () => {
    const built = harness();
    expect(
      (
        await built.call(GET, {
          method: 'GET',
          path: '/api/engines',
          as: { email: 'owner@example.test' },
        })
      ).status,
    ).toBe(200);
    built.teardown();
    live = null;

    const response = await built.call(GET, {
      method: 'GET',
      path: '/api/engines',
      as: { email: 'owner@example.test' },
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: 'rbac_runtime_not_configured',
        message: expect.any(String) as unknown,
        detail: expect.any(String) as unknown,
      },
    });
  });
});
