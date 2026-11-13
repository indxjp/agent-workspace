/**
 * SDK conformance, tokens: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  BROWSER_TOKEN_PATTERN,
  MintTokenRequestSchema,
  MintTokenResponseSchema,
} from '@indx-workspace/contracts/tokens';
import { WorkspaceSwitchResponseSchema } from '@indx-workspace/contracts/workspaces';
import { POST as switchWorkspaceRoute } from '../app/api/auth/workspace/route';
import { POST as mintTokenRoute } from '../app/api/tokens/route';
import { mintSessionToken, newSessionClaims, sessionCookieName } from './auth/session';
import { mintBrowserToken } from './rbac/browser-token';
import { createMemoryDirectory } from './rbac/memory-directory';
import type { WorkspaceRepositoryPort } from './workspaces/runtime';
import { installRbacHarness, TEST_WORKSPACE_ID } from './rbac/testing';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';

const TOKENS_WORKSPACE_ID = TEST_WORKSPACE_ID;

const TOKENS_OWNER = { email: 'tokens-conformance-owner@example.test' };

const TOKENS_RUN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

function tokensHarnessAndRuntime(): {
  readonly harness: ReturnType<typeof installRbacHarness>;
  readonly cleanup: () => void;
} {
  const harness = installRbacHarness([
    { email: TOKENS_OWNER.email, name: 'Owner', workspaceId: TOKENS_WORKSPACE_ID, role: 'owner' },
  ]);
  installTestDomains({
    tokens: {
      kind: 'serving',
      runtime: {
        findTarget: (principal, scope) =>
          Promise.resolve(
            scope.id === TOKENS_RUN_ID
              ? { kind: 'found', ownerPrincipalId: principal.principalId }
              : { kind: 'not-found' },
          ),
        issue: async (_principal, scope) => {
          if (scope.id !== TOKENS_RUN_ID) return null;
          const minted = await mintBrowserToken();
          return { token: minted.presented, expiresAt: new Date(Date.now() + 300_000) };
        },
      },
    },
  });
  return {
    harness,
    cleanup: () => {
      harness.teardown();
      clearApplicationContext();
    },
  };
}

const SWITCH_SECRET = 'workspace-switch-conformance-session-secret-32';

const SWITCH_EMAIL = 'switch-conformance@example.test';

const SWITCH_WORKSPACE = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  slug: 'switch-conformance',
  name: 'Switch Conformance',
};

function switchWorkspaceRepository(): WorkspaceRepositoryPort {
  const notImplemented = (): never => {
    throw new Error('not used by this conformance fixture');
  };
  const record = {
    id: SWITCH_WORKSPACE.id,
    slug: SWITCH_WORKSPACE.slug,
    name: SWITCH_WORKSPACE.name,
    publicSharingEnabled: false,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
  return {
    listForUser: notImplemented,
    ownerPrincipalId: notImplemented,
    get: (id) => Promise.resolve(id === record.id ? { ...record } : null),
    getForMember: (id) =>
      Promise.resolve(id === record.id ? { ...record, role: 'owner' as const } : null),
    create: notImplemented,
    update: notImplemented,
    archive: notImplemented,
    restore: notImplemented,
  };
}

describe('tokens (issue #236, SDK-04, S-1)', () => {
  it('reads a real request through MintTokenRequestSchema and rejects what it rejects', async () => {
    const { harness, cleanup } = tokensHarnessAndRuntime();
    try {
      for (const body of [
        { scope: { kind: 'run', id: TOKENS_RUN_ID } },
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, ttlSeconds: 600 },
      ]) {
        expect(MintTokenRequestSchema.safeParse(body).success).toBe(true);
        const response = await harness.call(mintTokenRoute, {
          method: 'POST',
          path: '/api/tokens',
          as: TOKENS_OWNER,
          body,
        });
        expect(response.status, JSON.stringify(body)).toBe(201);
      }
      for (const body of [
        {},
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, extra: 1 },
        { scope: { kind: 'run', id: TOKENS_RUN_ID }, ttlSeconds: 1 },
      ]) {
        expect(MintTokenRequestSchema.safeParse(body).success).toBe(false);
        const response = await harness.call(mintTokenRoute, {
          method: 'POST',
          path: '/api/tokens',
          as: TOKENS_OWNER,
          body,
        });
        expect(response.status, JSON.stringify(body)).toBe(400);
      }
    } finally {
      cleanup();
    }
  });
});

describe('tokens (issue #236, SDK-04, S-1)', () => {
  it('renders the real mint response into a body MintTokenResponseSchema accepts', async () => {
    const { harness, cleanup } = tokensHarnessAndRuntime();
    try {
      const response = await harness.call(mintTokenRoute, {
        method: 'POST',
        path: '/api/tokens',
        as: TOKENS_OWNER,
        body: { scope: { kind: 'run', id: TOKENS_RUN_ID } },
      });
      expect(response.status, response.text).toBe(201);
      const parsed = MintTokenResponseSchema.safeParse(response.body);
      expect(
        parsed.success,
        `the mint body does not satisfy MintTokenResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.scope).toEqual({ kind: 'run', id: TOKENS_RUN_ID });
      expect(BROWSER_TOKEN_PATTERN.test(parsed.data.token)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('workspace switch, JSON branch (issue #236, SDK-04, S-2)', () => {
  it('renders the real 200 body into a shape WorkspaceSwitchResponseSchema accepts', async () => {
    const directory = createMemoryDirectory({
      workspaces: [SWITCH_WORKSPACE],
      users: [
        {
          email: SWITCH_EMAIL,
          name: 'Switcher',
          workspaceId: SWITCH_WORKSPACE.id,
          role: 'owner',
        },
      ],
    });
    installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
    installTestDomains({ workspaces: { repository: switchWorkspaceRepository() } });
    const previousSecret = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = SWITCH_SECRET;
    try {
      const session = await mintSessionToken(
        newSessionClaims(SWITCH_EMAIL, SWITCH_WORKSPACE.slug),
        SWITCH_SECRET,
      );
      const response = await switchWorkspaceRoute(
        new Request('https://control-plane.test/api/auth/workspace', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://control-plane.test',
            host: 'control-plane.test',
            cookie: `${sessionCookieName(process.env)}=${session}`,
          },
          body: JSON.stringify({ workspace: SWITCH_WORKSPACE.slug }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const parsed = WorkspaceSwitchResponseSchema.safeParse(await response.json());
      expect(
        parsed.success,
        `the switch body does not satisfy WorkspaceSwitchResponseSchema: ${JSON.stringify(parsed)}`,
      ).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.workspace.slug).toBe(SWITCH_WORKSPACE.slug);
      expect(
        response.headers
          .getSetCookie()
          .some((c) => c.startsWith(`${sessionCookieName(process.env)}=`)),
      ).toBe(true);
    } finally {
      if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previousSecret;
      clearApplicationContext();
    }
  });
});

describe('workspace switch, JSON branch (issue #236, SDK-04, S-2)', () => {
  it('renders a JSON-branch refusal (404 workspace_not_available) in the standard ApiProblem envelope', async () => {
    const directory = createMemoryDirectory({
      workspaces: [SWITCH_WORKSPACE],
      users: [
        {
          email: SWITCH_EMAIL,
          name: 'Switcher',
          workspaceId: SWITCH_WORKSPACE.id,
          role: 'owner',
        },
      ],
    });
    installTestDomains({ rbac: { directory, identify: () => Promise.resolve(null) } });
    installTestDomains({ workspaces: { repository: switchWorkspaceRepository() } });
    const previousSecret = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = SWITCH_SECRET;
    try {
      const session = await mintSessionToken(
        newSessionClaims(SWITCH_EMAIL, SWITCH_WORKSPACE.slug),
        SWITCH_SECRET,
      );
      const response = await switchWorkspaceRoute(
        new Request('https://control-plane.test/api/auth/workspace', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://control-plane.test',
            host: 'control-plane.test',
            cookie: `${sessionCookieName(process.env)}=${session}`,
          },
          body: JSON.stringify({ workspace: 'not-a-member-workspace' }),
        }),
      );
      expect(response.status, await response.clone().text()).toBe(404);
      const { error } = ApiProblemSchema.parse(await response.json());
      expect(error.code).toBe('workspace_not_available');
      expect(error.detail).toBe(error.message);
    } finally {
      if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previousSecret;
      clearApplicationContext();
    }
  });
});
