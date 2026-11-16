/** Surface lookup, visitor limits and deployment workspace selection. */
import { log as webLogger } from '../../telemetry/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createSurfaceSessionsRuntime, resolveDeploymentScope } from './composition';
import { type Fixture, fixture, openedBy, OWNER, WORKSPACE_ID } from './composition.test-support';

describe('createSurfaceSessionsRuntime().checkModel (issue #661)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it("runs a new session's preflight for the surface's agent at its version, writing nothing", async () => {
    await expect(state.runtime.checkModel(state.resolved)).resolves.toBeNull();
    expect(state.preflights).toEqual([
      {
        owner: OWNER,
        agentId: state.agents.desk.id,
        sessionId: null,
        versionId: state.resolved.versionId,
      },
    ]);
    state.refusePreflight = true;
    await expect(state.runtime.checkModel(state.resolved)).resolves.toEqual({
      code: 'agent_runtime_profile_missing',
      message: 'no runtime profile',
    });
    // No session, no key, no token.
    expect(state.writes).toEqual([]);
    expect(state.sessions.size).toBe(0);
  });

  it('answers null for an agent that is gone, without a preflight', async () => {
    await expect(
      state.runtime.checkModel({ ...state.resolved, agentId: crypto.randomUUID() }),
    ).resolves.toBeNull();
    expect(state.preflights).toEqual([]);
  });
});

describe('createSurfaceSessionsRuntime().visitorSurface (issue #622)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
  });

  it('reads the surface of the version the session pinned, not the one served now', async () => {
    const opened = await openedBy(state, {});
    // Nothing serves `main` any more, and the session still keeps its pinned limits.
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: { name: 'main', agent: 'Front desk', limits: { turnsPerConversation: 2 } },
    });
  });

  it('adds the deployment frontend origin to the pinned surface (ADR-0128)', async () => {
    state.env = { AW_FRONTEND_ORIGIN: 'https://agents-web.vercel.app' };
    const opened = await openedBy(state, {});
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: {
        name: 'main',
        agent: 'Front desk',
        limits: { turnsPerConversation: 2 },
        allowedOrigins: ['https://agents-web.vercel.app'],
      },
    });
  });

  it('reads the served surface for a switcher session, whose version carries none', async () => {
    const opened = await openedBy(state, { agent: 'Billing' });
    await expect(state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId)).resolves.toEqual({
      surface: { name: 'main', agent: 'Front desk' },
    });
  });

  it('answers null for a session the bootstrap did not open', async () => {
    await expect(
      state.runtime.visitorSurface(WORKSPACE_ID, crypto.randomUUID()),
    ).resolves.toBeNull();
  });
});

describe('createSurfaceSessionsRuntime().servedSurfaces (issue #680)', () => {
  let state: Fixture;
  beforeEach(async () => {
    state = await fixture();
    state.env = { BOOTSTRAP_ADMIN: 'owner@example.com', BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12) };
  });

  it('lists the surfaces served to the public, and drops a name that resolves to none', async () => {
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([
      { name: 'main', agent: 'Front desk', servedFrom: 'local' },
    ]);
  });

  it('drops a surface the promoted agent production version no longer carries', async () => {
    state.promoted.add(state.agents.desk.id);
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
  });

  it('serves the WORKSPACE_SLUG workspace with no bootstrap credential set (issue #1168)', async () => {
    state.env = { WORKSPACE_SLUG: 'default' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([
      { name: 'main', agent: 'Front desk', servedFrom: 'local' },
    ]);
    await expect(state.runtime.resolve('main', 'public')).resolves.not.toBeNull();
  });

  it('serves nothing for a workspace the deployment does not have', async () => {
    state.env = { WORKSPACE_SLUG: 'other-workspace' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
    await expect(state.runtime.resolve('main', 'public')).resolves.toBeNull();
  });

  it('serves nothing when WORKSPACE_SLUG is not a usable slug', async () => {
    state.env = { WORKSPACE_SLUG: 'Bad Slug' };
    await expect(state.runtime.servedSurfaces()).resolves.toEqual([]);
    await expect(state.runtime.resolve('main', 'public')).resolves.toBeNull();
  });

  describe('an unusable WORKSPACE_SLUG (issue #1263)', () => {
    const construct = (env: Record<string, string>) =>
      createSurfaceSessionsRuntime({ env: () => env } as unknown as Parameters<
        typeof createSurfaceSessionsRuntime
      >[0]);

    it('warns once at construction, naming the variable', () => {
      const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
      try {
        construct({ WORKSPACE_SLUG: 'Bad Slug' });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain('WORKSPACE_SLUG');
      } finally {
        warn.mockRestore();
      }
    });

    it('stays quiet for a usable slug and for the default', () => {
      const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
      try {
        construct({ WORKSPACE_SLUG: 'default' });
        construct({});
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('resolveDeploymentScope', () => {
    const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_ID, slug: 'default' }]);

    it('resolves the deployment workspace, by default and by WORKSPACE_SLUG', async () => {
      await expect(resolveDeploymentScope({}, scopes)).resolves.toMatchObject({
        workspaceId: WORKSPACE_ID,
      });
      await expect(
        resolveDeploymentScope({ WORKSPACE_SLUG: 'default' }, scopes),
      ).resolves.toMatchObject({ workspaceId: WORKSPACE_ID });
      await expect(resolveDeploymentScope({ WORKSPACE_SLUG: 'other' }, scopes)).resolves.toBeNull();
    });

    it('answers null for an unusable slug without asking the resolver', async () => {
      const forWorkspaceSlug = vi.fn(() => Promise.resolve(null));
      await expect(
        resolveDeploymentScope({ WORKSPACE_SLUG: 'Bad Slug' }, { forWorkspaceSlug }),
      ).resolves.toBeNull();
      expect(forWorkspaceSlug).not.toHaveBeenCalled();
    });
  });

  describe('the deployment frontend origin (ADR-0128)', () => {
    const withEnv = (origin: string | undefined) => {
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
        ...(origin === undefined ? {} : { AW_FRONTEND_ORIGIN: origin }),
      };
    };

    const promote = () => {
      state.productionSurface = true;
      state.promoted.add(state.agents.desk.id);
    };

    it('adds it to a production surface that lists none, and leaves a surface alone when it is unset', async () => {
      promote();
      withEnv(undefined);
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'production' },
      ]);
      withEnv('https://agents-web.vercel.app');
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        {
          name: 'main',
          agent: 'Front desk',
          servedFrom: 'production',
          allowedOrigins: ['https://agents-web.vercel.app'],
        },
      ]);
    });

    it('never widens a draft served from local', async () => {
      withEnv('https://agents-web.vercel.app');
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'local' },
      ]);
    });

    it.each([
      ['plain http', 'http://agents-web.vercel.app'],
      ['http on loopback', 'http://localhost:3000'],
      ['a wildcard', '*'],
      ['a wildcard host', 'https://*.vercel.app'],
      ['a path', 'https://agents-web.vercel.app/app'],
      ['garbage', 'not a url'],
    ])('ignores %s with one warning', async (_name, value) => {
      const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
      promote();
      withEnv(value);
      await expect(state.runtime.servedSurfaces()).resolves.toEqual([
        { name: 'main', agent: 'Front desk', servedFrom: 'production' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('AW_FRONTEND_ORIGIN');
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(value);
      warn.mockRestore();
    });
  });
});
