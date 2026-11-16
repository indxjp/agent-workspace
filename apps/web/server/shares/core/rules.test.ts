import { describe, expect, it } from 'vitest';

import { decidePublish, EXPIRY_MS, publicLinkOpen, type PublishFacts } from './rules';
import type { PublishShareInput } from './input';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const facts: PublishFacts = {
  role: 'builder',
  publicSharingEnabled: true,
  runnableEnabled: true,
  now: NOW,
};
const session: PublishShareInput = {
  subjectType: 'session',
  subjectId: 'session-1',
  subjectLabel: 'Session',
  visibility: 'public',
};

describe('decidePublish', () => {
  it('counts an expiry from the time it is given', () => {
    for (const expiry of ['24 h', '7 days', '30 days'] as const) {
      expect(decidePublish({ ...session, expiry }, facts)).toMatchObject({
        ok: true,
        expiresAt: new Date(NOW.getTime() + EXPIRY_MS[expiry]),
      });
    }
    expect(decidePublish(session, facts)).toMatchObject({ ok: true, expiresAt: null });
  });

  it('refuses a public share only when the workspace policy is off', () => {
    const off = { ...facts, publicSharingEnabled: false };
    expect(decidePublish(session, off)).toStrictEqual({
      ok: false,
      message: 'Public sharing is disabled for this workspace.',
    });
    expect(decidePublish({ ...session, visibility: 'workspace' }, off)).toMatchObject({ ok: true });
  });

  it('gives an agent share a mode, and a runnable one a budget, for an Owner or Admin only', () => {
    const agent: PublishShareInput = { ...session, subjectType: 'agent' };
    expect(decidePublish(agent, facts)).toMatchObject({
      ok: true,
      mode: 'definition',
      budgetCapUsd: null,
    });
    const runnable: PublishShareInput = { ...agent, mode: 'runnable' };
    expect(decidePublish(runnable, { ...facts, role: 'admin' })).toMatchObject({
      ok: true,
      mode: 'runnable',
      budgetCapUsd: '20',
    });
    expect(
      decidePublish({ ...runnable, budgetCapUsd: 5 }, { ...facts, role: 'owner' }),
    ).toMatchObject({ ok: true, budgetCapUsd: '5' });
    expect(decidePublish(runnable, facts)).toStrictEqual({
      ok: false,
      message: 'Runnable links require Admin or Owner.',
    });
    expect(
      decidePublish(runnable, { ...facts, role: 'owner', runnableEnabled: false }),
    ).toStrictEqual({
      ok: false,
      message: 'Runnable public links are not available in this release (D-06).',
    });
    expect(decidePublish(session, facts)).toMatchObject({ ok: true, mode: undefined });
  });
});

describe('publicLinkOpen', () => {
  const open = {
    visibility: 'public',
    revokedAt: null,
    suspendedAt: null,
    stopped: false,
    expiresAt: null,
  };

  it('opens a live public link and closes it at its expiry instant', () => {
    expect(publicLinkOpen(open, NOW)).toBe(true);
    expect(publicLinkOpen({ ...open, expiresAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(true);
    expect(publicLinkOpen({ ...open, expiresAt: NOW }, NOW)).toBe(false);
  });

  it('keeps a non-public, revoked, suspended or stopped link closed', () => {
    expect(publicLinkOpen({ ...open, visibility: 'workspace' }, NOW)).toBe(false);
    expect(publicLinkOpen({ ...open, revokedAt: NOW }, NOW)).toBe(false);
    expect(publicLinkOpen({ ...open, suspendedAt: NOW }, NOW)).toBe(false);
    expect(publicLinkOpen({ ...open, stopped: true }, NOW)).toBe(false);
  });
});
