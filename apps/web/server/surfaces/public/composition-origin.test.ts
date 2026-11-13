/** Production deployment origins, directly and through surface resolution. */
import { log as webLogger } from '../../telemetry/logger';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SURFACE_ALLOWED_ORIGINS_MAX,
  type SurfaceDefinition,
} from '@indx-workspace/contracts/surfaces';
import { withDeploymentOrigin } from './composition';
import { mayOpenSession } from './conditions';
import { DEFAULT_TURNS_PER_CONVERSATION, turnsPerConversation } from './limits';
import { type Fixture, fixture, WORKSPACE_ID } from './composition.test-support';

describe('withDeploymentOrigin (ADR-0128, ADR-0129)', () => {
  const FRONTEND = 'https://acme-ai-web.team.workers.dev';
  const BARE: SurfaceDefinition = { name: 'main', agent: 'Front desk' };
  const withOrigin = { AW_FRONTEND_ORIGIN: FRONTEND };

  it('adds exactly the origin to a surface that lists none, and extends a list without repeating', () => {
    expect(withDeploymentOrigin(BARE, 'production', withOrigin).allowedOrigins).toEqual([FRONTEND]);
    const listed = { ...BARE, allowedOrigins: ['https://shop.example.com'] };
    expect(withDeploymentOrigin(listed, 'production', withOrigin).allowedOrigins).toEqual([
      'https://shop.example.com',
      FRONTEND,
    ]);
    const already = { ...BARE, allowedOrigins: [FRONTEND] };
    expect(withDeploymentOrigin(already, 'production', withOrigin)).toBe(already);
  });

  it('never widens a draft served from local', () => {
    expect(withDeploymentOrigin(BARE, 'local', withOrigin)).toBe(BARE);
  });

  it.each([
    ['unset', undefined],
    ['blank', '  '],
    ['a wildcard', '*'],
    ['a wildcard host', 'https://*.workers.dev'],
    ['http', 'http://acme-ai-web.team.workers.dev'],
    ['http on loopback', 'http://localhost:5173'],
    ['a path', `${FRONTEND}/chat`],
    ['a trailing slash', `${FRONTEND}/`],
    ['two origins', `${FRONTEND},https://other.example.com`],
    ['not a URL', 'acme-ai-web'],
  ])('adds nothing when the value is %s', (_label, value) => {
    const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
    try {
      expect(withDeploymentOrigin(BARE, 'production', { AW_FRONTEND_ORIGIN: value })).toBe(BARE);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves a full list as it is rather than refusing the surface', () => {
    const warn = vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
    try {
      const full = {
        ...BARE,
        allowedOrigins: Array.from(
          { length: SURFACE_ALLOWED_ORIGINS_MAX },
          (_, index) => `https://site${String(index)}.example.com`,
        ),
      };
      expect(withDeploymentOrigin(full, 'production', withOrigin)).toBe(full);
    } finally {
      warn.mockRestore();
    }
  });

  describe('through the runtime', () => {
    let state: Fixture;
    beforeEach(async () => {
      state = await fixture();
      state.productionSurface = true;
      state.promoted.add(state.agents.desk.id);
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
        ...withOrigin,
      };
    });

    it('widens the promoted surface the public is served, and not the try page draft', async () => {
      const served = await state.runtime.resolve('main', 'public');
      expect(served).toMatchObject({
        environment: 'production',
        surface: { allowedOrigins: [FRONTEND] },
      });
      const draft = await state.runtime.resolve('main', 'try');
      expect(draft?.environment).toBe('local');
      expect(draft?.surface.allowedOrigins).toBeUndefined();
    });

    it('does not widen a surface that is served from local before any promotion', async () => {
      state.productionSurface = false;
      state.promoted.delete(state.agents.desk.id);
      const served = await state.runtime.resolve('main', 'public');
      expect(served?.environment).toBe('local');
      expect(served?.surface.allowedOrigins).toBeUndefined();
    });

    it('resolves unchanged on a deployment that does not set the variable', async () => {
      state.env = {
        BOOTSTRAP_ADMIN: 'owner@example.com',
        BOOTSTRAP_ADMIN_PASSWORD: 'x'.repeat(12),
      };
      const served = await state.runtime.resolve('main', 'public');
      expect(served?.surface.allowedOrigins).toBeUndefined();
    });

    it('carries the origin into the served surfaces, so a visitor run answers CORS for it', async () => {
      const served = await state.runtime.servedSurfaces();
      expect(served).toEqual([
        { name: 'main', agent: 'Front desk', allowedOrigins: [FRONTEND], servedFrom: 'production' },
      ]);
    });

    it('admits a session from the frontend origin, with the default turn cap, and no other origin', async () => {
      const surface = (await state.runtime.resolve('main', 'public'))?.surface ?? null;
      expect(surface).not.toBeNull();
      const request = (origin: string) =>
        new Headers({
          host: 'aw.example.com',
          origin,
          'sec-fetch-site': 'cross-site',
        });
      expect(mayOpenSession(surface, request(FRONTEND), {}, 'session', 'production')).toEqual({
        ok: true,
        branch: 'allowed-origin',
        corsOrigin: FRONTEND,
      });
      expect(
        mayOpenSession(surface, request('https://evil.example.com'), {}, 'session', 'production'),
      ).toEqual({ ok: false, failed: 'origin-not-allowed' });
      if (surface === null) return;
      expect(turnsPerConversation(surface)).toBe(DEFAULT_TURNS_PER_CONVERSATION);
    });

    it('caps a visitor session the frontend opened, whose pinned version lists no origin', async () => {
      const opened = await state.runtime.open(
        (await state.runtime.resolve('main', 'public')) ?? state.resolved,
        {},
      );
      if (opened.kind !== 'opened') throw new Error(`expected a session, got ${opened.kind}`);
      const visitor = await state.runtime.visitorSurface(WORKSPACE_ID, opened.sessionId);
      expect(visitor?.surface?.allowedOrigins).toEqual([FRONTEND]);
    });
  });
});
