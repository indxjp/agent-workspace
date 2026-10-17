import type { SurfaceDefinition } from '@indx-workspace/contracts/surfaces';
import { afterEach, describe, expect, it } from 'vitest';

import { MIN_SESSION_SECRET_LENGTH } from '../../auth/session';
import {
  admitSurfaceVisitorWrite,
  admitVisitorWrite,
  DEFAULT_TURNS_PER_CONVERSATION,
  resetSurfaceLimits,
  SURFACE_RATE_LIMITS,
  turnsPerConversation,
} from './limits';
import {
  clearSurfaceSessionsRuntime,
  configureSurfaceSessionsRuntime,
  type VisitorSurface,
} from './runtime';

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';
const PLAIN: SurfaceDefinition = { name: 'main', agent: 'support' };
const LISTED: SurfaceDefinition = { ...PLAIN, allowedOrigins: ['https://shop.example.com'] };
const NOW = 1_000_000;
const PROXIED = {
  AW_TRUSTED_PROXY_HOPS: '1',
  SESSION_SECRET: 'k'.repeat(MIN_SESSION_SECRET_LENGTH),
} as const;
const client = (address: string): Headers => new Headers({ 'x-forwarded-for': address });

afterEach(() => {
  resetSurfaceLimits();
  clearSurfaceSessionsRuntime();
});

describe('a surface visitor’s turn cap (issue #622)', () => {
  it('is the declared cap, the default for a surface with origins, and none otherwise', () => {
    expect(turnsPerConversation({ ...LISTED, limits: { turnsPerConversation: 30 } })).toBe(30);
    expect(turnsPerConversation({ ...PLAIN, limits: { turnsPerConversation: 3 } })).toBe(3);
    expect(turnsPerConversation(LISTED)).toBe(DEFAULT_TURNS_PER_CONVERSATION);
    expect(turnsPerConversation(PLAIN)).toBeNull();
  });

  it('refuses the turn after the cap with a final code, and counts only admitted turns', () => {
    const capped = { ...PLAIN, limits: { turnsPerConversation: 2 } };
    const turn = (nowMs: number) =>
      admitVisitorWrite(capped, SESSION, 'turn', client('203.0.113.7'), nowMs, PROXIED);
    expect(turn(NOW)).toBeNull();
    expect(turn(NOW)).toBeNull();
    // A new minute lifts every rate window, never the cap.
    expect(turn(NOW + 120_000)).toMatchObject({
      code: 'surface_turn_limit_reached',
      retryAfterSeconds: null,
    });
    expect(
      admitVisitorWrite(capped, OTHER_SESSION, 'turn', client('203.0.113.7'), NOW, PROXIED),
    ).toBeNull();
  });

  it('rate-limits turns per visitor session, then per client', () => {
    const turn = (session: string) =>
      admitVisitorWrite(PLAIN, session, 'turn', client('203.0.113.7'), NOW, PROXIED);
    for (let sent = 0; sent < SURFACE_RATE_LIMITS.turnsPerSession; sent += 1) {
      expect(turn(SESSION)).toBeNull();
    }
    expect(turn(SESSION)).toMatchObject({ code: 'surface_rate_limited', retryAfterSeconds: 60 });

    const sessionsLeft = SURFACE_RATE_LIMITS.turnsPerClient - SURFACE_RATE_LIMITS.turnsPerSession;
    for (let sent = 0; sent < sessionsLeft; sent += 1) {
      expect(turn(crypto.randomUUID())).toBeNull();
    }
    expect(turn(OTHER_SESSION)).toMatchObject({ code: 'surface_rate_limited' });
  });
});

describe('admitSurfaceVisitorWrite, the run API hook (issue #622)', () => {
  function install(visitor: VisitorSurface | null): void {
    configureSurfaceSessionsRuntime({
      resolve: () => Promise.reject(new Error('the hook never resolves a name')),
      open: () => Promise.reject(new Error('the hook never opens a session')),
      checkModel: () => Promise.reject(new Error('the hook never checks a model')),
      visitorSurface: (workspaceId, sessionId) =>
        Promise.resolve(workspaceId === WORKSPACE && sessionId === SESSION ? visitor : null),
      servedSurfaces: () => Promise.reject(new Error('the limits never list surfaces')),
    });
  }

  it('admits every write of a session no surface opened, and with no runtime', async () => {
    await expect(
      admitSurfaceVisitorWrite(WORKSPACE, SESSION, 'turn', client('203.0.113.7')),
    ).resolves.toBeNull();
    install(null);
    for (let sent = 0; sent <= DEFAULT_TURNS_PER_CONVERSATION; sent += 1) {
      await expect(
        admitSurfaceVisitorWrite(WORKSPACE, crypto.randomUUID(), 'turn', client('203.0.113.7')),
      ).resolves.toBeNull();
    }
  });

  it('limits a visitor session by the surface it was opened on', async () => {
    install({ surface: { ...PLAIN, limits: { turnsPerConversation: 1 } } });
    const turn = () => admitSurfaceVisitorWrite(WORKSPACE, SESSION, 'turn', client('203.0.113.7'));
    await expect(turn()).resolves.toBeNull();
    await expect(turn()).resolves.toMatchObject({ code: 'surface_turn_limit_reached' });
  });

  it('caps a visitor of a surface that is no longer served at the default', () => {
    const turn = (minute: number) =>
      admitVisitorWrite(
        null,
        SESSION,
        'turn',
        client('203.0.113.7'),
        NOW + minute * 60_000,
        PROXIED,
      );
    for (let minute = 0; minute < DEFAULT_TURNS_PER_CONVERSATION; minute += 1) {
      expect(turn(minute)).toBeNull();
    }
    expect(turn(DEFAULT_TURNS_PER_CONVERSATION)).toMatchObject({
      code: 'surface_turn_limit_reached',
    });
  });
});
